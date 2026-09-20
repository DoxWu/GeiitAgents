import os
import subprocess
from contextlib import contextmanager

import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo

LOCK_ID = 7193264105


class OpsError(RuntimeError):
    """Only fixed, nonsecret diagnostics may be emitted by the CLI."""


def dsn(url):
    if "://" not in url and "=" in url:
        return make_conninfo(**conninfo_to_dict(url))
    if not url.startswith(("postgresql://", "postgres://", "postgresql+psycopg://")):
        raise OpsError("PostgreSQL URL is required")
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


def connect(url, cfg, **kwargs):
    return psycopg.connect(dsn(url), connect_timeout=cfg.DB_CONNECT_TIMEOUT_SECONDS,
                           options=f"-c statement_timeout={cfg.DB_OPERATION_TIMEOUT_SECONDS * 1000} -c lock_timeout=10000",
                           application_name="geiit-ops", **kwargs)


def identity(url):
    args = conninfo_to_dict(dsn(url))
    return (args.get("host", "localhost").lower(), args.get("port", "5432"), args.get("dbname"))


def database_url(url, name):
    args = conninfo_to_dict(dsn(url))
    args["dbname"] = name
    return make_conninfo(**args)


def cli_env(url, cfg):
    # Never put a password/DSN on the process command line. Preserve TLS options.
    params = conninfo_to_dict(dsn(url))
    supported = {"host", "hostaddr", "port", "dbname", "user", "password", "sslmode", "sslrootcert", "sslcert", "sslkey", "sslpassword", "channel_binding", "target_session_attrs", "options"}
    if set(params) - supported:
        raise OpsError("Unsupported PostgreSQL URL parameter for backup tools")
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    for key, value in params.items():
        env["PGDATABASE" if key == "dbname" else "PG" + key.upper()] = value
    env["PGCONNECT_TIMEOUT"] = str(cfg.DB_CONNECT_TIMEOUT_SECONDS)
    env["PGAPPNAME"] = "geiit-ops"
    return env


def pg_tool(binary, args, cfg, url=None):
    try:
        subprocess.run([binary, *args], env=cli_env(url, cfg) if url else os.environ.copy(),
                       check=True, timeout=cfg.DB_OPERATION_TIMEOUT_SECONDS,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        raise OpsError(f"{binary} failed; check client/server versions, permissions and available disk space") from None


@contextmanager
def database_lock(url, cfg):
    with connect(url, cfg, autocommit=True) as conn:
        if not conn.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_ID,)).fetchone()[0]:
            raise OpsError("Database maintenance is already running")
        try:
            yield conn
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_ID,))


def user_tables(conn):
    return conn.execute("""SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind IN ('r','p','v','m','S','f') AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e')""").fetchall()


def is_empty(conn):
    return not user_tables(conn)
