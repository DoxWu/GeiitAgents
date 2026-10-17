"""Unit tests and explicitly opted-in disposable PostgreSQL recovery drills."""
import asyncio
import base64
import os
import subprocess
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from psycopg import sql

from app.ops.config import OpsSettings
from app.ops.postgres import OpsError, cli_env, connect, database_lock, pg_tool
from app.ops.alerts import Incidents
from app.ops.backup import backup_once, restore_latest, verify_latest
from app.ops.recovery import recover_once, ensure_database, schema_ready


def config(**overrides):
    values = dict(DATABASE_URL="postgresql://ops_test@127.0.0.1:55439/postgres",
                  REDIS_URL="", OPS_MONITOR_URL="", OPS_ALERTS_ENABLED=False,
                  BOOTSTRAP_ADMIN_ENABLED=False, BACKUP_ENABLED=False,
                  RESTORE_ON_EMPTY=False, MIGRATE_ON_STARTUP=True, DB_RECOVERY_ENABLED=True,
                  BACKUP_SOURCE_ID="test", BACKUP_ENCRYPTION_KEY=base64.b64encode(b"t" * 32).decode())
    values.update(overrides)
    return OpsSettings(_env_file=None, **values)


def test_password_not_in_process_arguments():
    cfg = config()
    url = "postgresql://test:secret%40value@localhost/test?sslmode=require"
    with patch("app.ops.postgres.subprocess.run") as run:
        pg_tool("pg_dump", ["--format=custom"], cfg, url)
    args, kwargs = run.call_args
    assert "secret" not in str(args)
    assert kwargs["env"]["PGPASSWORD"] == "secret@value"
    assert kwargs["env"]["PGSSLMODE"] == "require"


def test_tool_failure_redacts_details():
    with patch("app.ops.postgres.subprocess.run", side_effect=subprocess.CalledProcessError(1, "secret")):
        with pytest.raises(OpsError) as error:
            pg_tool("pg_restore", [], config())
    assert "secret" not in str(error.value)


def test_alert_threshold_cooldown_recovery_and_persistence(tmp_path):
    cfg = config(OPS_STATE_FILE=str(tmp_path / "state.json"), OPS_FAILURE_THRESHOLD=2,
                 OPS_ALERT_COOLDOWN_SECONDS=60)
    with patch("app.ops.alerts.deliver", return_value=True) as send:
        incidents = Incidents(cfg)
        incidents.record("database", False, now=1)
        assert send.call_count == 0
        incidents.record("database", False, now=2)
        assert send.call_count == 1
        incidents = Incidents(cfg)
        incidents.record("database", False, now=3)
        assert send.call_count == 1
        incidents.record("database", False, now=63)
        assert send.call_count == 2
        incidents.record("database", True, now=64)
        incidents.record("database", True, now=65)
        assert send.call_count == 3


def test_email_failure_retries_without_recording_success(tmp_path):
    cfg = config(OPS_STATE_FILE=str(tmp_path / "state.json"), OPS_FAILURE_THRESHOLD=1)
    with patch("app.ops.alerts.deliver", side_effect=[RuntimeError("private"), True]) as send:
        incidents = Incidents(cfg)
        incidents.record("website", False)
        assert incidents.states["website"]["notified"] is False
        incidents.record("website", False)
        assert send.call_count == 2
        assert incidents.states["website"]["notified"] is True


def test_startup_waits_for_database(tmp_path):
    cfg = config(OPS_STATE_FILE=str(tmp_path / "state.json"))
    with patch("app.ops.recovery.recover_once", side_effect=[OSError(), "ready"]) as recover, \
            patch("app.ops.recovery.time.sleep"):
        assert ensure_database(cfg) == "ready"
        assert recover.call_count == 2


def test_readiness_requires_schema_and_redis():
    from app.ops.runtime import readiness
    with patch("app.ops.runtime.checks", return_value={"database": False, "redis": True}):
        assert readiness(config())[0] is False
    with patch("app.ops.runtime.checks", return_value={"database": True, "redis": True}) as check:
        assert readiness(config(OPS_MONITOR_URL="https://example.test/ready"))[0] is True
        assert not check.call_args.args[0].OPS_MONITOR_URL
        assert not check.call_args.args[0].OPS_API_ENABLED


def test_application_config_preserves_migration_controls():
    from types import SimpleNamespace

    from app.ops.runtime import application_config

    settings = SimpleNamespace(
        DATABASE_URL="postgresql://app@db/app",
        REDIS_URL="redis://cache/0",
        MIGRATE_ON_STARTUP=False,
        DB_RECOVERY_ENABLED=False,
        DB_STARTUP_TIMEOUT_SECONDS=42,
        DB_RETRY_INTERVAL_SECONDS=7,
        DB_CONNECT_TIMEOUT_SECONDS=3,
        DB_OPERATION_TIMEOUT_SECONDS=55,
        OPS_INTERVAL_SECONDS=19,
    )
    cfg = application_config(settings)

    assert cfg.DATABASE_URL == settings.DATABASE_URL
    assert cfg.REDIS_URL == settings.REDIS_URL
    assert cfg.MIGRATE_ON_STARTUP is False
    assert cfg.DB_RECOVERY_ENABLED is False
    assert cfg.DB_STARTUP_TIMEOUT_SECONDS == 42
    assert cfg.DB_RETRY_INTERVAL_SECONDS == 7
    assert cfg.DB_CONNECT_TIMEOUT_SECONDS == 3
    assert cfg.DB_OPERATION_TIMEOUT_SECONDS == 55
    assert cfg.OPS_INTERVAL_SECONDS == 19


def test_runtime_recovery_retries_after_failure():
    from app.ops.runtime import recovery_loop
    calls = []
    def recover(cfg):
        calls.append(1)
        if len(calls) == 1:
            raise OSError("offline")
        return "ready"
    async def tick(seconds):
        if len(calls) >= 2:
            raise asyncio.CancelledError()
    with patch("app.ops.runtime.recover_once", side_effect=recover), patch("app.ops.runtime.asyncio.sleep", tick):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(recovery_loop(config()))
    assert len(calls) == 2


@pytest.fixture
def live(tmp_path, monkeypatch):
    url = os.environ.get("GEIIT_OPS_TEST_ADMIN_URL")
    if not url:
        pytest.skip("Set GEIIT_OPS_TEST_ADMIN_URL to a disposable local cluster with pgvector")
    from urllib.parse import urlsplit
    parsed = urlsplit(url)
    assert parsed.hostname in ("127.0.0.1", "localhost") and parsed.username == "ops_test"
    from sqlalchemy.engine import make_url
    names = ["geiit_ops_test_" + uuid.uuid4().hex for _ in range(3)]
    urls = [make_url(url).set(database=name).render_as_string(hide_password=False) for name in names]
    cfg = config(DATABASE_URL=urls[0], BACKUP_DATABASE_URL=urls[1], BACKUP_VERIFY_ADMIN_URL=url,
                 OPS_STATE_FILE=str(tmp_path / "state.json"), BACKUP_ENABLED=True)
    monkeypatch.setenv("DATABASE_URL", urls[0])
    monkeypatch.setenv("DEBUG", "true")
    with connect(url, cfg, autocommit=True) as admin:
        for name in names:
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
        try:
            yield cfg, urls[2]
        finally:
            for name in names:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def seeded(cfg):
    cfg = cfg.model_copy(update={"BOOTSTRAP_ADMIN_ENABLED": True, "SUPERUSER_USERNAME": "test_admin",
                                 "SUPERUSER_EMAIL": "admin@example.test", "SUPERUSER_PASSWORD": "TestOnly123!"})
    assert recover_once(cfg) == "initialized"
    return cfg


def test_live_migrate_idempotent_and_bootstrap_never_resets(live):
    cfg, _ = live
    cfg = seeded(cfg)
    with connect(cfg.DATABASE_URL, cfg) as conn:
        original = conn.execute("SELECT hashed_password FROM users").fetchone()[0]
    assert recover_once(cfg.model_copy(update={"SUPERUSER_PASSWORD": "Changed123!"})) == "ready"
    with connect(cfg.DATABASE_URL, cfg) as conn:
        assert schema_ready(conn)
        assert conn.execute("SELECT hashed_password FROM users").fetchone()[0] == original
        assert conn.execute("SELECT count(*) FROM users").fetchone()[0] == 1
    with database_lock(cfg.DATABASE_URL, cfg):
        assert recover_once(cfg) == "ready"
        with pytest.raises(OpsError, match="already running"):
            with database_lock(cfg.DATABASE_URL, cfg):
                pass


def test_live_encrypted_backup_restore_and_corruption(live):
    cfg, target = live
    cfg = seeded(cfg)
    with connect(cfg.DATABASE_URL, cfg) as conn:
        # Exercise vector values, sequences and application records as well as users.
        conn.execute("CREATE TABLE public.ops_vector_fixture(id serial PRIMARY KEY, embedding vector(3), content text)")
        conn.execute("INSERT INTO ops_vector_fixture(embedding,content) VALUES('[1,2,3]','recover this document')")
        original = conn.execute("SELECT hashed_password FROM users").fetchone()[0]
    snapshot = backup_once(cfg)
    assert backup_once(cfg) == "not-due"
    assert verify_latest(cfg) == snapshot
    restored = cfg.model_copy(update={"DATABASE_URL": target, "RESTORE_ON_EMPTY": True})
    assert recover_once(restored) == "restored"
    with connect(target, cfg) as conn:
        assert conn.execute("SELECT hashed_password FROM users").fetchone()[0] == original
        from passlib.hash import bcrypt
        assert bcrypt.verify("TestOnly123!", original)
        assert conn.execute("SELECT embedding::text,content FROM ops_vector_fixture").fetchone() == ("[1,2,3]", "recover this document")
        assert conn.execute("INSERT INTO ops_vector_fixture(content) VALUES('next') RETURNING id").fetchone()[0] == 2
    with database_lock(target, cfg) as lock:
        with pytest.raises(OpsError, match="empty target"):
            restore_latest(restored, lock)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as store:
        store.execute("UPDATE geiit_backup.chunks SET payload=set_byte(payload,20, get_byte(payload,20) # 1) WHERE snapshot_id=%s AND seq=0", (snapshot,))
    with pytest.raises(OpsError, match="integrity"):
        verify_latest(cfg)


def test_live_failed_backup_preserves_previous_and_empty_restore_refuses(live):
    cfg, target = live
    cfg = seeded(cfg)
    snapshot = backup_once(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as store:
        store.execute("UPDATE geiit_backup.snapshots SET created_at=now()-interval '2 days'")
    with connect(cfg.DATABASE_URL, cfg) as conn:
        conn.execute("DELETE FROM users")
    with pytest.raises(OpsError, match="No users"):
        backup_once(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as store:
        assert store.execute("SELECT id FROM geiit_backup.snapshots").fetchall() == [(snapshot,)]
    strict = cfg.model_copy(update={"DATABASE_URL": target, "RESTORE_ON_EMPTY": True, "RESTORE_MAX_AGE_HOURS": 1})
    with pytest.raises(OpsError, match="recent verified"):
        recover_once(strict)
    with connect(target, cfg) as conn:
        assert not conn.execute("SELECT to_regclass('public.users')").fetchone()[0]


def test_live_failed_restore_drill_does_not_commit_backup(live):
    cfg, _ = live
    cfg = seeded(cfg)
    with patch("app.ops.backup.verify_dump", side_effect=OpsError("drill failed")):
        with pytest.raises(OpsError, match="drill failed"):
            backup_once(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as store:
        assert store.execute("SELECT count(*) FROM geiit_backup.snapshots").fetchone()[0] == 0


def test_live_primary_loss_recovers_without_manual_migration(live):
    cfg, _ = live
    cfg = seeded(cfg)
    backup_once(cfg)
    from sqlalchemy.engine import make_url
    name = make_url(cfg.DATABASE_URL).database
    with connect(cfg.BACKUP_VERIFY_ADMIN_URL, cfg, autocommit=True) as admin:
        admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
    assert recover_once(cfg.model_copy(update={"RESTORE_ON_EMPTY": True})) == "restored"
    with connect(cfg.DATABASE_URL, cfg) as conn:
        assert schema_ready(conn)
        assert conn.execute("SELECT username FROM users").fetchone()[0] == "test_admin"


def test_health_routes_return_503_but_liveness_survives():
    # Load the real handlers without initializing unrelated model/OCR providers.
    import ast
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from fastapi.testclient import TestClient
    tree = ast.parse((Path(__file__).parents[1] / "app/main.py").read_text(encoding="utf-8"))
    handlers = [node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name in ("health_check", "liveness")]
    app = FastAPI()
    ns = {"app": app, "JSONResponse": JSONResponse, "settings": Mock(APP_NAME="test", ENVIRONMENT="test")}
    exec(compile(ast.Module(body=handlers, type_ignores=[]), "main_health_handlers", "exec"), ns)
    with patch("app.ops.runtime.application_config", return_value=config()), patch("app.ops.runtime.readiness", return_value=(False, {})):
        client = TestClient(app)
        assert client.get("/live").status_code == 200
        assert client.get("/ready").status_code == 503
        assert client.get("/health").status_code == 503


def test_production_validation_with_prometheus_auth():
    from app.core.config import Settings
    cfg = Settings(_env_file=None, ENVIRONMENT="production", DEBUG=False,
                   SECRET_KEY="test-validation-key-" + "0123456789abcdef" * 3,
                   OPENAI_API_KEY="test-only", CORS_ORIGINS=["https://example.test"],
                   ENABLE_PROMETHEUS=True, PROMETHEUS_AUTH_ENABLED=True,
                   PROMETHEUS_AUTH_PASSWORD="test-only", EMAIL_ENABLED=False)
    assert cfg.validate_required_for_production() == []


def test_monitor_revision_check_does_not_load_application_secrets():
    import sys
    from app.ops.recovery import expected_heads
    expected_heads.cache_clear()
    heads = expected_heads()
    expected_heads.cache_clear()
    with patch.dict(sys.modules, {"app.core.config": None}):
        assert expected_heads() == heads
    expected_heads.cache_clear()
