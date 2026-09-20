import logging
import time
from pathlib import Path
from functools import lru_cache

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory

from app.ops.alerts import Incidents
from app.ops.postgres import OpsError, connect, database_lock, is_empty

logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[2]


def migration_config():
    # No fileConfig here: runtime recovery must not reconfigure web-server logging.
    config = Config()
    config.set_main_option("script_location", str(ROOT / "alembic"))
    return config


@lru_cache(maxsize=1)
def expected_heads():
    return set(ScriptDirectory.from_config(migration_config()).get_heads())


def schema_ready(conn):
    if not conn.execute("SELECT to_regclass('public.alembic_version')").fetchone()[0]:
        return False
    revisions = {row[0] for row in conn.execute("SELECT version_num FROM public.alembic_version")}
    required = ("users", "documents", "document_chunks", "conversations", "messages", "document_folders")
    return revisions == expected_heads() and all(
        conn.execute("SELECT to_regclass(%s)", ("public." + table,)).fetchone()[0] for table in required)


def bootstrap_admin(conn, cfg):
    if not cfg.BOOTSTRAP_ADMIN_ENABLED or conn.execute("SELECT EXISTS(SELECT 1 FROM public.users)").fetchone()[0]:
        return
    from scripts.create_superuser import validate_username, validate_password, validate_email
    from passlib.hash import bcrypt
    validate_username(cfg.SUPERUSER_USERNAME)
    validate_email(cfg.SUPERUSER_EMAIL)
    validate_password(cfg.SUPERUSER_PASSWORD)
    conn.execute("""INSERT INTO public.users(username,email,hashed_password,is_active,is_superuser,user_type)
        VALUES(%s,%s,%s,true,true,'regular')""", (cfg.SUPERUSER_USERNAME, cfg.SUPERUSER_EMAIL, bcrypt.hash(cfg.SUPERUSER_PASSWORD)))
    logger.info("Created bootstrap administrator in an empty user table")


def recover_once(cfg):
    # A healthy replica can start during a long backup; only mutations need the lock.
    with connect(cfg.DATABASE_URL, cfg) as check:
        if schema_ready(check) and (not cfg.BOOTSTRAP_ADMIN_ENABLED or
                check.execute("SELECT EXISTS(SELECT 1 FROM public.users)").fetchone()[0]):
            return "ready"
    with database_lock(cfg.DATABASE_URL, cfg) as conn:
        empty = is_empty(conn)
        restored = False
        if empty and cfg.RESTORE_ON_EMPTY:
            from app.ops.backup import restore_latest
            restore_latest(cfg, conn)
            restored = True
            logger.warning("Restored verified snapshot to empty primary database")
        if not schema_ready(conn):
            if not (cfg.MIGRATE_ON_STARTUP or cfg.DB_RECOVERY_ENABLED):
                raise OpsError("Schema is not ready and automatic migrations are disabled")
            config = migration_config()
            config.attributes["maintenance_lock_held"] = True
            config.attributes["database_url"] = cfg.DATABASE_URL
            config.attributes["ops_settings"] = cfg
            command.upgrade(config, "head")
        if not schema_ready(conn):
            raise OpsError("Migration revision or required tables failed validation")
        bootstrap_admin(conn, cfg)
        return "restored" if restored else "initialized" if empty else "ready"


def ensure_database(cfg):
    deadline = time.monotonic() + cfg.DB_STARTUP_TIMEOUT_SECONDS
    incidents = Incidents(cfg, str(Path(cfg.OPS_STATE_FILE).with_name("startup-state.json")))
    while True:
        try:
            result = recover_once(cfg)
            incidents.record("database-startup", True)
            if result == "initialized":
                logger.warning("Initialized an empty database: migrations do not recover historical user/document data")
            return result
        except Exception as exc:
            # Raw driver/subprocess errors may contain DSNs or SQL values.
            logger.error("Database recovery not ready (%s); retrying within startup deadline", type(exc).__name__)
            incidents.record("database-startup", False, "Database unavailable, schema check/migration/restore failed; inspect deployment configuration.")
            if time.monotonic() >= deadline:
                raise OpsError("Database recovery timed out; existing data was not cleared") from None
            time.sleep(cfg.DB_RETRY_INTERVAL_SECONDS)
