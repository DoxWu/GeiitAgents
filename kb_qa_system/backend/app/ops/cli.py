import argparse
import base64
import logging
import os

from app.ops.config import OpsSettings


def main():
    parser = argparse.ArgumentParser(description="GeiIt database recovery and independent monitoring")
    parser.add_argument("command", choices=["startup", "monitor", "backup", "verify", "restore", "check", "generate-key", "jobs", "work-once"])
    parser.add_argument("--snapshot-id", help="Select a verified snapshot for verify/restore")
    parser.add_argument("--force", action="store_true", help="Manual backup even if the interval has not elapsed")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.command == "generate-key":
        print(base64.b64encode(os.urandom(32)).decode())
        return
    try:
        cfg = OpsSettings()
        if args.snapshot_id:
            import re
            if args.command not in ("verify", "restore") or not re.fullmatch(r"[a-f0-9]{32}", args.snapshot_id):
                raise ValueError("Invalid snapshot selection")
        if args.force and args.command != "backup":
            raise ValueError("Force only applies to backup")
        if args.command == "startup":
            from app.ops.recovery import ensure_database
            ensure_database(cfg)
        elif args.command == "monitor":
            from app.ops.monitor import run
            run(cfg)
        elif args.command == "backup":
            from app.ops.backup import backup_once
            if not cfg.BACKUP_ENABLED:
                raise ValueError("Backup is disabled")
            print(backup_once(cfg, force=args.force))
        elif args.command == "verify":
            from app.ops.backup import verify_latest
            print(verify_latest(cfg, args.snapshot_id))
        elif args.command == "restore":
            from app.ops.backup import restore_latest
            from app.ops.postgres import database_lock
            with database_lock(cfg.DATABASE_URL, cfg) as conn:
                print(restore_latest(cfg, conn, args.snapshot_id))
        elif args.command in ("jobs", "work-once"):
            import json
            from app.ops.jobs import jobs, run_pending, heartbeat
            if args.command == "work-once":
                heartbeat(cfg)
                print(run_pending(cfg) or "idle")
            else:
                print(json.dumps(jobs(cfg), default=str))
        else:
            from app.ops.monitor import checks
            results = checks(cfg)
            print(results)
            if not results or not all(results.values()):
                raise ValueError("Dependency check failed")
    except Exception as exc:
        from app.ops.postgres import OpsError
        detail = str(exc) if isinstance(exc, OpsError) else "Check configuration, credentials, tool versions and storage; sensitive details omitted."
        logging.error("Operations command failed (%s): %s", type(exc).__name__, detail)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
