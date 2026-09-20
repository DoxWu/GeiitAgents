"""Versioned encrypted pg_dump archives stored in a separate PostgreSQL database.

An archive is committed only after a full restore drill; old snapshots survive failures.
"""
import base64
import hashlib
import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg import sql
from psycopg.types.json import Jsonb

from app.ops.postgres import OpsError, connect, database_lock, database_url, identity, is_empty, pg_tool

CHUNK_SIZE = 1024 * 1024


def encryption_key(cfg):
    try:
        key = base64.b64decode(cfg.BACKUP_ENCRYPTION_KEY, validate=True)
        if len(key) != 32:
            raise ValueError
        return key
    except ValueError:
        raise OpsError("BACKUP_ENCRYPTION_KEY must be a base64-encoded 32-byte key") from None


def validate_config(cfg):
    encryption_key(cfg)
    if not cfg.BACKUP_VERIFY_ADMIN_URL:
        raise OpsError("BACKUP_VERIFY_ADMIN_URL is required for verified backup and recovery")
    if not cfg.BACKUP_DATABASE_URL or identity(cfg.DATABASE_URL) == identity(cfg.BACKUP_DATABASE_URL):
        raise OpsError("Backup storage must be a separate PostgreSQL database")


def init_store(conn):
    conn.execute("CREATE SCHEMA IF NOT EXISTS geiit_backup")
    conn.execute("""CREATE TABLE IF NOT EXISTS geiit_backup.snapshots (
        id text PRIMARY KEY, source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        manifest jsonb NOT NULL, signature bytea NOT NULL, verified boolean NOT NULL DEFAULT false)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS geiit_backup.chunks (
        snapshot_id text REFERENCES geiit_backup.snapshots(id) ON DELETE CASCADE,
        seq integer NOT NULL, payload bytea NOT NULL, PRIMARY KEY(snapshot_id,seq))""")


def manifest_bytes(manifest):
    return json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()


def aad(source, snapshot_id, seq):
    return json.dumps([source, snapshot_id, seq], separators=(",", ":")).encode()


def seal(cipher, value, context):
    nonce = os.urandom(12)
    return nonce + cipher.encrypt(nonce, value, context)


def unseal(cipher, value, context):
    return cipher.decrypt(bytes(value[:12]), bytes(value[12:]), context)


def inventory(conn):
    tables = conn.execute("""SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY c.relname""").fetchall()
    counts = {name: conn.execute(sql.SQL('SELECT count(*) FROM public.{}').format(sql.Identifier(name))).fetchone()[0] for (name,) in tables}
    if not {"users", "documents", "document_chunks", "alembic_version"}.issubset(counts):
        raise OpsError("Core tables missing; refusing to create a misleading backup")
    revisions = [r[0] for r in conn.execute("SELECT version_num FROM public.alembic_version ORDER BY version_num")]
    if not revisions:
        raise OpsError("Database has no migration revision")
    return {"counts": counts, "revisions": revisions}


def check_restored(url, expected, cfg):
    with connect(url, cfg) as conn:
        if inventory(conn) != {k: expected[k] for k in ("counts", "revisions")}:
            raise OpsError("Restored table counts or migration revision differ from snapshot")
        if not conn.execute("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector')").fetchone()[0]:
            raise OpsError("Restored database has no pgvector extension")


def restore_dump(file, url, cfg):
    pg_tool("pg_restore", ["--dbname", "", "--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", str(file)], cfg, url)


def verify_dump(file, expected, cfg):
    if not cfg.BACKUP_VERIFY_ADMIN_URL:
        raise OpsError("BACKUP_VERIFY_ADMIN_URL is required for a full restore drill (CREATEDB permission)")
    name = "geiit_verify_" + uuid.uuid4().hex
    # Only delete the exact fresh database created by this invocation.
    with connect(cfg.BACKUP_VERIFY_ADMIN_URL, cfg, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
        try:
            url = database_url(cfg.BACKUP_VERIFY_ADMIN_URL, name)
            restore_dump(file, url, cfg)
            check_restored(url, expected, cfg)
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def backup_once(cfg, *, force=False):
    validate_config(cfg)
    with database_lock(cfg.DATABASE_URL, cfg) as source_lock, connect(cfg.BACKUP_DATABASE_URL, cfg) as store:
        fingerprint = "SELECT current_database(),pg_postmaster_start_time(),inet_server_port()"
        if source_lock.execute(fingerprint).fetchone() == store.execute(fingerprint).fetchone():
            raise OpsError("Backup URL resolves to the source database; backup refused")
        # Refuse a source containing archive storage, including alternate DNS names
        # for the same physical database. Never recursively archive backups.
        if source_lock.execute("SELECT to_regnamespace('geiit_backup')").fetchone()[0]:
            raise OpsError("Source database contains backup storage; use dedicated databases")
        if (source_lock.info.dbname, source_lock.info.host, source_lock.info.port) == (store.info.dbname, store.info.host, store.info.port):
            raise OpsError("Backup and source databases must differ")
        init_store(store)
        store.commit()
        if source_lock.execute("SELECT to_regnamespace('geiit_backup')").fetchone()[0]:
            raise OpsError("Backup URL resolves to the source database; backup refused")
        # The store transaction lock serializes two external schedulers for this source.
        store.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (cfg.BACKUP_SOURCE_ID,))
        last = store.execute("SELECT created_at FROM geiit_backup.snapshots WHERE source=%s AND verified ORDER BY created_at DESC LIMIT 1", (cfg.BACKUP_SOURCE_ID,)).fetchone()
        if not force and last and (datetime.now(timezone.utc) - last[0]).total_seconds() < cfg.BACKUP_INTERVAL_SECONDS:
            return "not-due"
        with tempfile.TemporaryDirectory(prefix="geiit-backup-") as directory:
            file = Path(directory) / "snapshot.dump"
            # pg_dump and row counts share one exported repeatable-read snapshot.
            with connect(cfg.DATABASE_URL, cfg) as source:
                source.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                snapshot = source.execute("SELECT pg_export_snapshot()").fetchone()[0]
                expected = inventory(source)
                if not cfg.BACKUP_ALLOW_EMPTY and expected["counts"]["users"] == 0:
                    raise OpsError("No users in source database; preserving previous backups")
                pg_tool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--snapshot", snapshot, "--file", str(file)], cfg, cfg.DATABASE_URL)
            if not 0 < file.stat().st_size <= cfg.BACKUP_MAX_BYTES:
                raise OpsError("Backup exceeds configured size limit")
            verify_dump(file, expected, cfg)
            expected.update(size=file.stat().st_size, sha256=file_hash(file))
            snapshot_id = uuid.uuid4().hex
            cipher = AESGCM(encryption_key(cfg))
            signature = seal(cipher, manifest_bytes(expected), aad(cfg.BACKUP_SOURCE_ID, snapshot_id, "manifest"))
            store.execute("INSERT INTO geiit_backup.snapshots(id,source,manifest,signature) VALUES(%s,%s,%s,%s)",
                          (snapshot_id, cfg.BACKUP_SOURCE_ID, Jsonb(expected), signature))
            with file.open("rb") as handle:
                seq = 0
                while chunk := handle.read(CHUNK_SIZE):
                    store.execute("INSERT INTO geiit_backup.chunks VALUES(%s,%s,%s)",
                                  (snapshot_id, seq, seal(cipher, chunk, aad(cfg.BACKUP_SOURCE_ID, snapshot_id, seq))))
                    seq += 1
            # Read back/decrypt from the destination before marking the snapshot verified.
            downloaded = Path(directory) / "readback.dump"
            download(store, snapshot_id, expected, signature, downloaded, cfg)
            store.execute("UPDATE geiit_backup.snapshots SET verified=true WHERE id=%s", (snapshot_id,))
            # Queued manual operations pin their selected snapshot until completion.
            # The queue is optional; old installations need no schema migration.
            pinned = []
            if store.execute("SELECT to_regclass('geiit_backup.jobs')").fetchone()[0]:
                pinned = [r[0] for r in store.execute("SELECT snapshot_id FROM geiit_backup.jobs WHERE source=%s AND state IN ('queued','running') AND snapshot_id IS NOT NULL", (cfg.BACKUP_SOURCE_ID,))]
            store.execute("""DELETE FROM geiit_backup.snapshots WHERE id IN (
                SELECT id FROM geiit_backup.snapshots WHERE source=%s AND verified
                ORDER BY created_at DESC,id DESC OFFSET %s) AND NOT (id = ANY(%s))""", (cfg.BACKUP_SOURCE_ID, cfg.BACKUP_RETENTION_COUNT, pinned))
            return snapshot_id


def file_hash(file):
    with file.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def download(store, snapshot_id, manifest, signature, file, cfg):
    cipher = AESGCM(encryption_key(cfg))
    try:
        if unseal(cipher, signature, aad(cfg.BACKUP_SOURCE_ID, snapshot_id, "manifest")) != manifest_bytes(manifest):
            raise ValueError
        if not 0 < manifest["size"] <= cfg.BACKUP_MAX_BYTES:
            raise ValueError
        size, seq = 0, 0
        with store.cursor(name="backup_download_" + uuid.uuid4().hex) as cursor, file.open("wb") as handle:
            cursor.execute("SELECT seq,payload FROM geiit_backup.chunks WHERE snapshot_id=%s ORDER BY seq", (snapshot_id,))
            for number, encrypted in cursor:
                if number != seq:
                    raise ValueError
                chunk = unseal(cipher, encrypted, aad(cfg.BACKUP_SOURCE_ID, snapshot_id, seq))
                size += len(chunk)
                if size > cfg.BACKUP_MAX_BYTES:
                    raise ValueError
                handle.write(chunk)
                seq += 1
        if size != manifest["size"] or file_hash(file) != manifest["sha256"]:
            raise ValueError
    except Exception:
        raise OpsError("Backup integrity/key verification failed; restore refused") from None


def latest_snapshot(store, cfg, snapshot_id=None):
    row = store.execute("""SELECT id,manifest,signature,created_at FROM geiit_backup.snapshots
        WHERE source=%s AND verified AND (%s::text IS NULL OR id=%s)
        ORDER BY created_at DESC,id DESC LIMIT 1""", (cfg.BACKUP_SOURCE_ID, snapshot_id, snapshot_id)).fetchone()
    if not row or (datetime.now(timezone.utc) - row[3]).total_seconds() > cfg.RESTORE_MAX_AGE_HOURS * 3600:
        raise OpsError("No sufficiently recent verified backup; restore refused")
    return row


def verify_latest(cfg, snapshot_id=None):
    validate_config(cfg)
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as store, tempfile.TemporaryDirectory(prefix="geiit-verify-") as directory:
        row = latest_snapshot(store, cfg, snapshot_id)
        file = Path(directory) / "snapshot.dump"
        download(store, row[0], row[1], row[2], file, cfg)
        verify_dump(file, row[1], cfg)
        return row[0]


def restore_latest(cfg, destination_lock, snapshot_id=None):
    validate_config(cfg)
    if not is_empty(destination_lock):
        raise OpsError("Restore only supports an empty target; existing data is never overwritten")
    with connect(cfg.BACKUP_DATABASE_URL, cfg) as store, tempfile.TemporaryDirectory(prefix="geiit-restore-") as directory:
        row = latest_snapshot(store, cfg, snapshot_id)
        file = Path(directory) / "snapshot.dump"
        download(store, row[0], row[1], row[2], file, cfg)
        # Verify current PostgreSQL/pgvector compatibility before touching the target.
        verify_dump(file, row[1], cfg)
        if not is_empty(destination_lock):
            raise OpsError("Target changed during verification; restore refused")
        restore_dump(file, cfg.DATABASE_URL, cfg)
        check_restored(cfg.DATABASE_URL, row[1], cfg)
        return row[0]
