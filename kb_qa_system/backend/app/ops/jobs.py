"""Durable maintenance queue in backup storage, independent of the primary DB/Celery.

One source-scoped session lock owns execution. Losing the worker never causes an
automatic replay of a restore: the next owner reports the previous run interrupted.
"""
import hashlib
import hmac
import json
import uuid
from datetime import datetime, timezone

from psycopg.rows import dict_row

from app.ops.backup import (backup_once, encryption_key, init_store, latest_snapshot,
                            restore_latest, validate_config, verify_latest)
from app.ops.postgres import OpsError, connect, database_lock, identity, is_empty


class MaintenanceError(OpsError):
    def __init__(self, code, status=409):
        super().__init__(code)
        self.code, self.status = code, status


def require_enabled(cfg):
    if not cfg.OPS_API_ENABLED:
        raise MaintenanceError("operations_disabled", 503)
    if not cfg.BACKUP_DATABASE_URL:
        raise MaintenanceError("backup_storage_not_configured", 503)


def init_queue(conn):
    # An application database is never a maintenance store, even through a DNS alias.
    if conn.execute("SELECT to_regclass('public.users')").fetchone()[0]:
        raise MaintenanceError("backup_storage_is_application_database")
    init_store(conn)
    conn.execute("""CREATE TABLE IF NOT EXISTS geiit_backup.jobs (
        id text PRIMARY KEY, source text NOT NULL, request_id text NOT NULL,
        kind text NOT NULL CHECK(kind IN ('backup','verify','restore')),
        snapshot_id text, target_stamp text, actor_id integer NOT NULL,
        state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed','interrupted','cancelled')),
        created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz,
        finished_at timestamptz, result_snapshot_id text, error_code text,
        UNIQUE(source,request_id))""")
    conn.execute("CREATE INDEX IF NOT EXISTS jobs_source_created ON geiit_backup.jobs(source,created_at DESC)")
    conn.execute("""CREATE TABLE IF NOT EXISTS geiit_backup.workers (
        source text PRIMARY KEY, seen_at timestamptz NOT NULL)""")


def heartbeat(cfg):
    require_enabled(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as conn:
        init_queue(conn)
        conn.execute("""INSERT INTO geiit_backup.workers VALUES(%s,now())
            ON CONFLICT(source) DO UPDATE SET seen_at=now()""", (cfg.BACKUP_SOURCE_ID,))


PUBLIC_JOB_COLUMNS = "id,kind,snapshot_id,actor_id,state,created_at,started_at,finished_at,result_snapshot_id,error_code"


def status(cfg):
    # Configuration summary is an allowlist, never model_dump() secrets.
    result = {"enabled": cfg.OPS_API_ENABLED, "backup_enabled": cfg.BACKUP_ENABLED,
              "storage_configured": bool(cfg.BACKUP_DATABASE_URL),
              "restore_target": cfg.RESTORE_TARGET_NAME if cfg.RESTORE_TARGET_DATABASE_URL else None,
              "interval_seconds": cfg.BACKUP_INTERVAL_SECONDS, "retention_count": cfg.BACKUP_RETENTION_COUNT,
              "worker_seen_at": None, "worker_available": False, "store_available": False}
    if not cfg.OPS_API_ENABLED or not cfg.BACKUP_DATABASE_URL:
        return result
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as conn:
        result["store_available"] = True
        if conn.execute("SELECT to_regclass('geiit_backup.workers')").fetchone()[0]:
            row = conn.execute("SELECT seen_at FROM geiit_backup.workers WHERE source=%s", (cfg.BACKUP_SOURCE_ID,)).fetchone()
            if row:
                result["worker_seen_at"] = row[0]
                result["worker_available"] = (datetime.now(timezone.utc) - row[0]).total_seconds() <= max(180, cfg.OPS_INTERVAL_SECONDS * 3)
    return result


def snapshots(cfg, limit=50):
    require_enabled(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as conn:
        if not conn.execute("SELECT to_regclass('geiit_backup.snapshots')").fetchone()[0]:
            return []
        rows = conn.execute("""SELECT id,created_at,verified,manifest->>'size' AS size_bytes
            FROM geiit_backup.snapshots WHERE source=%s ORDER BY created_at DESC,id DESC LIMIT %s""",
                            (cfg.BACKUP_SOURCE_ID, limit)).fetchall()
        return [{"id": r[0], "created_at": r[1], "verified": r[2], "size_bytes": int(r[3]),
                 "within_restore_window": (datetime.now(timezone.utc) - r[1]).total_seconds() <= cfg.RESTORE_MAX_AGE_HOURS * 3600} for r in rows]


def jobs(cfg, limit=50):
    require_enabled(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as conn:
        if not conn.execute("SELECT to_regclass('geiit_backup.jobs')").fetchone()[0]:
            return []
        with conn.cursor(row_factory=dict_row) as cursor:
            return cursor.execute(f"SELECT {PUBLIC_JOB_COLUMNS} FROM geiit_backup.jobs WHERE source=%s ORDER BY created_at DESC,id DESC LIMIT %s",
                                  (cfg.BACKUP_SOURCE_ID, limit)).fetchall()


def get_job(cfg, job_id):
    require_enabled(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as conn:
        if not conn.execute("SELECT to_regclass('geiit_backup.jobs')").fetchone()[0]:
            raise MaintenanceError("job_not_found", 404)
        with conn.cursor(row_factory=dict_row) as cursor:
            row = cursor.execute(f"SELECT {PUBLIC_JOB_COLUMNS} FROM geiit_backup.jobs WHERE source=%s AND id=%s",
                                 (cfg.BACKUP_SOURCE_ID, job_id)).fetchone()
    if not row:
        raise MaintenanceError("job_not_found", 404)
    return row


def target_config(cfg):
    if not cfg.RESTORE_TARGET_DATABASE_URL:
        raise MaintenanceError("restore_target_not_configured")
    if identity(cfg.RESTORE_TARGET_DATABASE_URL) in (identity(cfg.DATABASE_URL), identity(cfg.BACKUP_DATABASE_URL)):
        raise MaintenanceError("restore_target_must_be_separate")
    return cfg.model_copy(update={"DATABASE_URL": cfg.RESTORE_TARGET_DATABASE_URL})


def target_stamp(cfg):
    target = target_config(cfg)
    # No connection strings in responses or queued payloads; stamp binds plan to target.
    value = json.dumps([cfg.BACKUP_SOURCE_ID, cfg.RESTORE_TARGET_NAME, identity(target.DATABASE_URL)]).encode()
    return hmac.new(encryption_key(cfg), value, hashlib.sha256).hexdigest()


def restore_plan(cfg, snapshot_id):
    require_enabled(cfg)
    validate_config(cfg)
    target = target_config(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as store:
        latest_snapshot(store, cfg, snapshot_id)
    with connect(target.DATABASE_URL, target) as conn:
        if not is_empty(conn):
            raise MaintenanceError("restore_target_not_empty")
    return {"snapshot_id": snapshot_id, "target_name": cfg.RESTORE_TARGET_NAME,
            "target_stamp": target_stamp(cfg), "empty": True,
            "requires_confirmation": True}


def submit(cfg, *, kind, request_id, actor_id, snapshot_id=None, stamp=None, confirmation=None):
    require_enabled(cfg)
    if kind not in ("backup", "verify", "restore"):
        raise MaintenanceError("invalid_operation", 422)
    validate_config(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as conn:
        init_queue(conn)
        # Serialize enqueue/cancel and retention to preserve selected snapshots.
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (cfg.BACKUP_SOURCE_ID,))
        with conn.cursor(row_factory=dict_row) as cursor:
            existing = cursor.execute("SELECT * FROM geiit_backup.jobs WHERE source=%s AND request_id=%s", (cfg.BACKUP_SOURCE_ID, request_id)).fetchone()
            if existing:
                if (existing["kind"], existing["snapshot_id"], existing["target_stamp"], existing["actor_id"]) != (kind, snapshot_id, stamp, actor_id):
                    raise MaintenanceError("idempotency_conflict")
                return {key: existing[key] for key in PUBLIC_JOB_COLUMNS.split(",")}
        if kind == "backup":
            if not cfg.BACKUP_ENABLED:
                raise MaintenanceError("backup_disabled")
            if snapshot_id or stamp:
                raise MaintenanceError("invalid_operation", 422)
        else:
            if not snapshot_id:
                raise MaintenanceError("snapshot_required", 422)
            latest_snapshot(conn, cfg, snapshot_id)
        if kind == "restore":
            if confirmation != cfg.RESTORE_TARGET_NAME or not stamp or not hmac.compare_digest(stamp, target_stamp(cfg)):
                raise MaintenanceError("restore_confirmation_mismatch")
            # Recheck after planning, and again in the worker immediately before restore.
            target = target_config(cfg)
            with connect(target.DATABASE_URL, target) as target_conn:
                if not is_empty(target_conn):
                    raise MaintenanceError("restore_target_not_empty")
        elif stamp or confirmation:
            raise MaintenanceError("invalid_operation", 422)
        if conn.execute("SELECT count(*) FROM geiit_backup.jobs WHERE source=%s AND state IN ('queued','running')", (cfg.BACKUP_SOURCE_ID,)).fetchone()[0] >= 20:
            raise MaintenanceError("queue_full", 429)
        with conn.cursor(row_factory=dict_row) as cursor:
            return cursor.execute(f"""INSERT INTO geiit_backup.jobs(id,source,request_id,kind,snapshot_id,target_stamp,actor_id,state)
                VALUES(%s,%s,%s,%s,%s,%s,%s,'queued') RETURNING {PUBLIC_JOB_COLUMNS}""",
                (uuid.uuid4().hex, cfg.BACKUP_SOURCE_ID, request_id, kind, snapshot_id, stamp, actor_id)).fetchone()


def cancel(cfg, job_id):
    require_enabled(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as conn:
        with conn.cursor(row_factory=dict_row) as cursor:
            row = cursor.execute(f"""UPDATE geiit_backup.jobs SET state='cancelled',finished_at=now()
                WHERE source=%s AND id=%s AND state='queued' RETURNING {PUBLIC_JOB_COLUMNS}""", (cfg.BACKUP_SOURCE_ID, job_id)).fetchone()
    if not row:
        raise MaintenanceError("job_not_queued")
    return row


def run_pending(cfg):
    require_enabled(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg, autocommit=True) as owner:
        init_queue(owner)
        key = "geiit-job-worker:" + cfg.BACKUP_SOURCE_ID
        if not owner.execute("SELECT pg_try_advisory_lock(hashtextextended(%s,0))", (key,)).fetchone()[0]:
            return None
        try:
            # Only a new execution owner can declare an old worker interrupted.
            owner.execute("""UPDATE geiit_backup.jobs SET state='interrupted',finished_at=now(),error_code='worker_interrupted'
                WHERE source=%s AND state='running'""", (cfg.BACKUP_SOURCE_ID,))
            with owner.cursor(row_factory=dict_row) as cursor:
                job = cursor.execute("""UPDATE geiit_backup.jobs SET state='running',started_at=now()
                    WHERE id=(SELECT id FROM geiit_backup.jobs WHERE source=%s AND state='queued'
                        ORDER BY created_at,id LIMIT 1) AND state='queued' RETURNING *""", (cfg.BACKUP_SOURCE_ID,)).fetchone()
            if not job:
                return None
            try:
                if job["kind"] == "backup":
                    if not cfg.BACKUP_ENABLED:
                        raise MaintenanceError("backup_disabled")
                    result = backup_once(cfg, force=True)
                elif job["kind"] == "verify":
                    result = verify_latest(cfg, job["snapshot_id"])
                else:
                    if not hmac.compare_digest(job["target_stamp"], target_stamp(cfg)):
                        raise MaintenanceError("restore_target_changed")
                    target = target_config(cfg)
                    with database_lock(target.DATABASE_URL, target) as lock:
                        result = restore_latest(target, lock, job["snapshot_id"])
                owner.execute("UPDATE geiit_backup.jobs SET state='succeeded',finished_at=now(),result_snapshot_id=%s WHERE id=%s",
                              (result, job["id"]))
            except Exception as exc:
                # Never persist raw driver/tool exceptions, DSNs or document contents.
                code = exc.code if isinstance(exc, MaintenanceError) else "operation_failed"
                owner.execute("UPDATE geiit_backup.jobs SET state='failed',finished_at=now(),error_code=%s WHERE id=%s", (code, job["id"]))
            return job["id"]
        finally:
            owner.execute("SELECT pg_advisory_unlock(hashtextextended(%s,0))", (key,))
