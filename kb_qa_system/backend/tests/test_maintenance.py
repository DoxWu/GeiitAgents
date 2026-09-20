import importlib.util
import sys
import types
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.ops import jobs
from app.ops.backup import backup_once
from app.ops.postgres import connect
from test_ops import config, live, seeded  # Explicit disposable cluster fixture.


def load_routes():
    user = {"id": None, "admin": False}
    def auth():
        if user["id"] is None:
            raise HTTPException(401)
        if not user["admin"]:
            raise HTTPException(403)
        return types.SimpleNamespace(id=user["id"])
    deps = types.ModuleType("app.api.deps")
    deps.get_current_superuser = auth
    spec = importlib.util.spec_from_file_location("isolated_maintenance", Path(__file__).parents[1] / "app/api/routes/maintenance.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"app.api.deps": deps}):
        spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix="/api/v1")
    app.dependency_overrides[module.config] = lambda: config(OPS_API_ENABLED=True)
    return TestClient(app), user, module


def test_routes_require_admin_and_reject_arbitrary_targets():
    client, user, module = load_routes()
    url = "/api/v1/admin/maintenance"
    with patch.object(module.jobs, "submit", return_value={"id": "queued"}) as submit, patch.object(module.jobs, "status", return_value={"enabled": True}):
        body = {"kind": "backup", "request_id": str(uuid.uuid4())}
        for verb, suffix, payload in [("get", "/status", None), ("get", "/jobs", None), ("get", "/snapshots", None), ("post", "/jobs", body), ("post", "/restore-plan", {"snapshot_id": "a" * 32}), ("post", "/jobs/" + "a" * 32 + "/cancel", None)]:
            assert client.request(verb, url + suffix, json=payload).status_code == 401
            user.update(id=2, admin=False)
            assert client.request(verb, url + suffix, json=payload).status_code == 403
            user.update(id=None)
        user.update(id=1, admin=True)
        response = client.post(url + "/jobs", json=body)
        assert response.status_code == 202
        assert response.headers["cache-control"] == "no-store"
        assert submit.call_args.kwargs["actor_id"] == 1
        invalid = client.post(url + "/jobs", json={**body, "target_url": "postgresql://user:secret@localhost/other"})
        assert invalid.status_code == 422
        assert "secret" not in invalid.text
        assert client.post(url + "/jobs", json={**body, "kind": "shell"}).status_code == 422
        assert client.get(url + "/jobs?limit=100000").status_code == 422


def test_route_errors_redact_database_credentials():
    client, user, module = load_routes()
    user.update(id=1, admin=True)
    with patch.object(module.jobs, "status", side_effect=RuntimeError("postgresql://private:secret@host/db")):
        response = client.get("/api/v1/admin/maintenance/status")
    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "maintenance_unavailable"}}
    assert "secret" not in response.text


def test_disabled_status_never_connects_and_exposes_no_secrets():
    cfg = config(OPS_API_ENABLED=False, BACKUP_DATABASE_URL="postgresql://user:secret@host/backup")
    with patch("app.ops.jobs.connect") as connection:
        result = jobs.status(cfg)
        with pytest.raises(jobs.MaintenanceError, match="operations_disabled"):
            jobs.snapshots(cfg)
    connection.assert_not_called()
    assert "secret" not in str(result)
    from app.ops.backup import validate_config
    from app.ops.postgres import OpsError
    with pytest.raises(OpsError, match="BACKUP_VERIFY_ADMIN_URL"):
        validate_config(config(BACKUP_VERIFY_ADMIN_URL=""))


def configured(live):
    cfg, target = live
    return seeded(cfg).model_copy(update={"OPS_API_ENABLED": True, "RESTORE_TARGET_DATABASE_URL": target, "RESTORE_TARGET_NAME": "test-recovery"})


def enqueue(cfg, kind="backup", snapshot=None, **kwargs):
    return jobs.submit(cfg, kind=kind, request_id=kwargs.pop("request_id", str(uuid.uuid4())),
                       actor_id=1, snapshot_id=snapshot, **kwargs)


def test_live_queue_idempotency_worker_and_status(live):
    cfg = configured(live)
    jobs.heartbeat(cfg)
    assert jobs.status(cfg)["worker_available"]
    request_id = str(uuid.uuid4())
    first = enqueue(cfg, request_id=request_id)
    assert enqueue(cfg, request_id=request_id)["id"] == first["id"]
    with pytest.raises(jobs.MaintenanceError, match="idempotency_conflict"):
        jobs.submit(cfg, kind="backup", request_id=request_id, actor_id=2)
    assert jobs.run_pending(cfg) == first["id"]
    result = jobs.jobs(cfg)[0]
    assert result["state"] == "succeeded"
    assert result["result_snapshot_id"] == jobs.snapshots(cfg)[0]["id"]
    assert enqueue(cfg, request_id=request_id)["state"] == "succeeded"
    assert len(jobs.jobs(cfg)) == 1
    assert jobs.get_job(cfg, first["id"])["state"] == "succeeded"
    # Manual action bypasses interval; scheduler still observes it.
    second = enqueue(cfg)
    assert jobs.run_pending(cfg) == second["id"]
    assert len(jobs.snapshots(cfg)) == 2


def test_live_selected_snapshot_restore_and_recheck(live):
    cfg = configured(live)
    snapshot = backup_once(cfg)
    plan = jobs.restore_plan(cfg, snapshot)
    assert plan["target_name"] == "test-recovery"
    assert "DATABASE_URL" not in str(plan)
    with pytest.raises(jobs.MaintenanceError, match="confirmation"):
        enqueue(cfg, "restore", snapshot, stamp=plan["target_stamp"], confirmation="wrong")
    job = enqueue(cfg, "restore", snapshot, stamp=plan["target_stamp"], confirmation=plan["target_name"])
    # A newer snapshot exists by execution time; requested snapshot remains selected.
    with connect(cfg.DATABASE_URL, cfg) as conn:
        conn.execute("UPDATE users SET username='new-name'")
    newer = backup_once(cfg, force=True)
    assert newer != snapshot
    assert jobs.run_pending(cfg) == job["id"]
    assert jobs.jobs(cfg)[0]["state"] == "succeeded"
    with connect(cfg.RESTORE_TARGET_DATABASE_URL, cfg) as conn:
        assert conn.execute("SELECT username FROM users").fetchone()[0] == "test_admin"
    with pytest.raises(jobs.MaintenanceError, match="not_empty"):
        jobs.restore_plan(cfg, snapshot)


def test_live_target_changed_after_plan_is_not_overwritten(live):
    cfg = configured(live)
    snapshot = backup_once(cfg)
    plan = jobs.restore_plan(cfg, snapshot)
    enqueue(cfg, "restore", snapshot, stamp=plan["target_stamp"], confirmation=plan["target_name"])
    with connect(cfg.RESTORE_TARGET_DATABASE_URL, cfg) as conn:
        conn.execute("CREATE TABLE preserve_me(id integer)")
        conn.execute("INSERT INTO preserve_me VALUES(17)")
    jobs.run_pending(cfg)
    assert jobs.jobs(cfg)[0]["state"] == "failed"
    with connect(cfg.RESTORE_TARGET_DATABASE_URL, cfg) as conn:
        assert conn.execute("SELECT id FROM preserve_me").fetchone()[0] == 17
        assert not conn.execute("SELECT to_regclass('users')").fetchone()[0]


def test_live_target_reconfigured_rejects_pending_job(live):
    cfg = configured(live)
    snapshot = backup_once(cfg)
    plan = jobs.restore_plan(cfg, snapshot)
    enqueue(cfg, "restore", snapshot, stamp=plan["target_stamp"], confirmation=plan["target_name"])
    jobs.run_pending(cfg.model_copy(update={"RESTORE_TARGET_NAME": "changed"}))
    assert jobs.jobs(cfg)[0]["error_code"] == "restore_target_changed"


def test_live_interrupted_restore_not_replayed_cancel_queued(live):
    cfg = configured(live)
    first = enqueue(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as conn:
        conn.execute("UPDATE geiit_backup.jobs SET state='running' WHERE id=%s", (first["id"],))
    second = enqueue(cfg)
    assert jobs.cancel(cfg, second["id"])["state"] == "cancelled"
    with patch("app.ops.jobs.backup_once") as backup:
        assert jobs.run_pending(cfg) is None
    backup.assert_not_called()
    assert {row["state"] for row in jobs.jobs(cfg)} == {"interrupted", "cancelled"}


def test_live_worker_lock_excludes_other_worker(live):
    cfg = configured(live)
    enqueue(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg, autocommit=True) as owner:
        owner.execute("SELECT pg_advisory_lock(hashtextextended(%s,0))", ("geiit-job-worker:" + cfg.BACKUP_SOURCE_ID,))
        assert jobs.run_pending(cfg) is None
        assert jobs.jobs(cfg)[0]["state"] == "queued"


def test_live_pinned_snapshot_survives_retention(live):
    cfg = configured(live).model_copy(update={"BACKUP_RETENTION_COUNT": 2})
    snapshot = backup_once(cfg)
    enqueue(cfg, "verify", snapshot)
    backup_once(cfg, force=True)
    backup_once(cfg, force=True)
    assert snapshot in {row["id"] for row in jobs.snapshots(cfg)}
    jobs.run_pending(cfg)
    assert jobs.jobs(cfg)[0]["state"] == "succeeded"
    backup_once(cfg, force=True)
    assert snapshot not in {row["id"] for row in jobs.snapshots(cfg)}


def test_live_operation_errors_do_not_store_raw_details(live):
    cfg = configured(live)
    enqueue(cfg)
    with patch("app.ops.jobs.backup_once", side_effect=RuntimeError("secret-connection")):
        jobs.run_pending(cfg)
    row = jobs.jobs(cfg)[0]
    assert row["state"] == "failed" and row["error_code"] == "operation_failed"
    assert "secret" not in str(row)
    from app.ops.monitor import checks
    assert checks(cfg)["maintenance-backup"] is False


def test_live_queue_bound_and_source_isolation(live):
    cfg = configured(live)
    for _ in range(20):
        enqueue(cfg)
    with pytest.raises(jobs.MaintenanceError, match="queue_full"):
        enqueue(cfg)
    other = cfg.model_copy(update={"BACKUP_SOURCE_ID": "another-source"})
    assert jobs.jobs(other) == []
    with pytest.raises(jobs.MaintenanceError, match="job_not_queued"):
        jobs.cancel(other, jobs.jobs(cfg)[0]["id"])


def test_live_application_database_cannot_be_queue_storage(live):
    cfg = configured(live)
    bad = cfg.model_copy(update={"BACKUP_DATABASE_URL": cfg.DATABASE_URL})
    with pytest.raises(jobs.MaintenanceError, match="application_database"):
        jobs.heartbeat(bad)
    with connect(cfg.DATABASE_URL, cfg) as conn:
        assert not conn.execute("SELECT to_regnamespace('geiit_backup')").fetchone()[0]
