"""Run this outside the primary provider to detect a complete provider outage."""
import logging
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

import httpx

from app.ops.alerts import Incidents
from app.ops.backup import backup_once
from app.ops.postgres import connect, OpsError
from app.ops.recovery import schema_ready

logger = logging.getLogger(__name__)


def maintenance_cycle(cfg, backup_due):
    if cfg.OPS_API_ENABLED:
        from app.ops.jobs import run_pending
        job_id = run_pending(cfg)
        if job_id:
            return "job", job_id
    if cfg.BACKUP_ENABLED and backup_due:
        return "backup", backup_once(cfg)
    return "idle", None


def checks(cfg):
    results = {}
    if cfg.DATABASE_URL:
        try:
            with connect(cfg.DATABASE_URL, cfg) as conn:
                results["database"] = schema_ready(conn)
        except Exception:
            results["database"] = False
    if cfg.REDIS_URL:
        try:
            import redis
            with redis.Redis.from_url(cfg.REDIS_URL, socket_connect_timeout=5, socket_timeout=5) as client:
                results["redis"] = bool(client.ping())
        except Exception:
            results["redis"] = False
    if cfg.OPS_MONITOR_URL:
        try:
            with httpx.Client(timeout=10, follow_redirects=False) as client:
                response = client.get(cfg.OPS_MONITOR_URL)
                results["website"] = response.status_code == 200 and response.json().get("status") == "healthy"
        except Exception:
            results["website"] = False
    if cfg.BACKUP_ENABLED:
        try:
            with connect(cfg.BACKUP_DATABASE_URL, cfg) as store:
                last = store.execute("SELECT max(created_at) FROM geiit_backup.snapshots WHERE source=%s AND verified", (cfg.BACKUP_SOURCE_ID,)).fetchone()[0]
                results["backup-freshness"] = bool(last) and (datetime.now(timezone.utc) - last).total_seconds() <= cfg.BACKUP_INTERVAL_SECONDS * 2
        except Exception:
            results["backup-freshness"] = False
    if cfg.OPS_API_ENABLED and cfg.BACKUP_DATABASE_URL:
        try:
            with connect(cfg.BACKUP_DATABASE_URL, cfg) as store:
                if store.execute("SELECT to_regclass('geiit_backup.jobs')").fetchone()[0]:
                    rows = store.execute("""SELECT DISTINCT ON (kind) kind,state FROM geiit_backup.jobs
                        WHERE source=%s AND state IN ('succeeded','failed','interrupted')
                        ORDER BY kind,finished_at DESC,id DESC""", (cfg.BACKUP_SOURCE_ID,)).fetchall()
                    for kind, state in rows:
                        results["maintenance-" + kind] = state == "succeeded"
                results["maintenance-storage"] = True
        except Exception:
            results["maintenance-storage"] = False
    return results


def run(cfg):
    if not (cfg.DATABASE_URL or cfg.REDIS_URL or cfg.OPS_MONITOR_URL):
        raise OpsError("At least one monitoring target is required")
    incidents = Incidents(cfg)
    next_backup = 0
    future = None
    # Backup work must not delay outage monitoring or email alerts.
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="backup") as pool:
        while True:
            if cfg.OPS_API_ENABLED:
                try:
                    from app.ops.jobs import heartbeat
                    heartbeat(cfg)
                    incidents.record("maintenance-queue", True)
                except Exception:
                    incidents.record("maintenance-queue", False, "Maintenance storage or worker heartbeat unavailable.")
            for component, healthy in checks(cfg).items():
                incidents.record(component, healthy, "Endpoint/schema check failed." if not healthy else "Checks are passing again.")
            if future and future.done():
                try:
                    kind, result = future.result()
                    if kind == "backup":
                        incidents.record("backup", True, "Encrypted snapshot and restore verification passed.")
                        next_backup = time.monotonic() + (cfg.OPS_INTERVAL_SECONDS if result == "not-due" else cfg.BACKUP_INTERVAL_SECONDS)
                except Exception as exc:
                    logger.error("Backup failed (%s); previous verified snapshots retained", type(exc).__name__)
                    incidents.record("backup", False, "Backup/restore drill failed. Previous verified snapshots retained.")
                    next_backup = time.monotonic() + cfg.OPS_INTERVAL_SECONDS
                future = None
            if future is None and (cfg.OPS_API_ENABLED or (cfg.BACKUP_ENABLED and time.monotonic() >= next_backup)):
                future = pool.submit(maintenance_cycle, cfg, time.monotonic() >= next_backup)
            time.sleep(cfg.OPS_INTERVAL_SECONDS)
