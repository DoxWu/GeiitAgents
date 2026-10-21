"""Offline, transactional pgvector rebuild with an explicit rollback window.

Stop every application writer before use. Work on a restored copy first. This
module never changes environment files, starts services, or switches traffic.
"""

import argparse
import hashlib
import json
import math
import re
import uuid

from psycopg import sql

from app.core.embedding_space import embedding_space_id
from app.ops.config import OpsSettings
from app.ops.postgres import OpsError, connect, database_lock

MANIFEST = "public.geiit_embedding_migrations"


def _stage(run_id):
    if not isinstance(run_id, str) or not re.fullmatch(r"[0-9a-f]{32}", run_id):
        raise OpsError("Migration ID must be 32 lowercase hexadecimal characters")
    return sql.Identifier("public", "geiit_embedding_" + run_id)


def _dimension(conn):
    row = conn.execute("""
        SELECT format_type(atttypid,atttypmod) FROM pg_attribute
        WHERE attrelid='public.document_chunks'::regclass
          AND attname='content_vector' AND NOT attisdropped
    """).fetchone()
    match = re.fullmatch(r"vector\(([0-9]+)\)", row[0] if row else "")
    if not match:
        raise OpsError("A fixed-dimension document_chunks vector column is required")
    return int(match[1])


def _ensure_manifest(conn):
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {MANIFEST} (
            run_id varchar(32) PRIMARY KEY,
            source_dimension integer NOT NULL,
            target_dimension integer NOT NULL,
            target_space varchar(64) NOT NULL,
            source_digest varchar(64) NOT NULL,
            prepared_digest varchar(64) NOT NULL,
            active_digest varchar(64),
            chunk_count bigint NOT NULL,
            indexed_count bigint NOT NULL,
            status text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    """)


def _sources(conn):
    # Named cursors keep the entire corpus out of process memory. Table locks
    # prevent content, status and permission changes throughout each operation.
    cursor = conn.cursor(name="embedding_" + uuid.uuid4().hex)
    cursor.itersize = 32
    cursor.execute("""
        SELECT c.id, c.content, c.content_vector::text, c.embedding_space,
               (NOT d.is_deleted AND d.status IN ('completed','low_quality')) AS eligible,
               jsonb_build_object('chunk',to_jsonb(c),'document_sha256',
                   encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex'))::text
        FROM public.document_chunks c JOIN public.documents d ON d.id=c.document_id
        ORDER BY c.id
    """)
    return cursor


def _digest(conn):
    digest = hashlib.sha256()
    count = 0
    with _sources(conn) as rows:
        for *_, snapshot in rows:
            raw = snapshot.encode("utf-8")
            digest.update(len(raw).to_bytes(8, "big"))
            digest.update(raw)
            count += 1
    return digest.hexdigest(), count


def _vector(value, dimension):
    if (
        not isinstance(value, (list, tuple))
        or len(value) != dimension
        or any(type(item) not in (int, float) or not math.isfinite(item) for item in value)
        or not any(value)
    ):
        raise OpsError("Embedding must be finite, nonzero and match the target dimension")
    return json.dumps(value, separators=(",", ":"))


def _prepared_digest(conn, stage):
    digest = hashlib.sha256()
    with conn.cursor(name="prepared_" + uuid.uuid4().hex) as rows:
        rows.itersize = 32
        rows.execute(sql.SQL("SELECT to_jsonb(s)::text FROM {} s ORDER BY id").format(stage))
        for (snapshot,) in rows:
            raw = snapshot.encode("utf-8")
            digest.update(len(raw).to_bytes(8, "big"))
            digest.update(raw)
    return digest.hexdigest()


def inspect(cfg):
    with connect(cfg.DATABASE_URL, cfg) as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        result = {"dimension": _dimension(conn)}
        result["chunks"] = conn.execute("SELECT count(*) FROM public.document_chunks").fetchone()[0]
        exists = conn.execute("SELECT to_regclass(%s)", (MANIFEST,)).fetchone()[0]
        result["migrations"] = (
            []
            if not exists
            else [
                {
                    "run_id": row[0],
                    "source_dimension": row[1],
                    "target_dimension": row[2],
                    "status": row[3],
                }
                for row in conn.execute(
                    f"SELECT run_id,source_dimension,target_dimension,status FROM {MANIFEST} ORDER BY created_at"
                )
            ]
        )
        return result


def prepare(cfg, run_id, dimension, space, embed, *, writers_stopped=False):
    stage = _stage(run_id)
    if not writers_stopped:
        raise OpsError("Stop all writers and explicitly acknowledge the offline operation")
    if type(dimension) is not int or not 1 <= dimension <= 2000:
        raise OpsError("Target dimension must be between 1 and 2000 for vector indexes")
    if not isinstance(space, str) or not re.fullmatch(r"[0-9a-f]{64}", space):
        raise OpsError("A verified target embedding space is required")
    with database_lock(cfg.DATABASE_URL, cfg) as conn, conn.transaction():
        conn.execute("LOCK TABLE public.documents, public.document_chunks IN SHARE MODE")
        source_dimension = _dimension(conn)
        _ensure_manifest(conn)
        if conn.execute(
            f"SELECT 1 FROM {MANIFEST} WHERE status IN ('prepared','active') LIMIT 1"
        ).fetchone():
            raise OpsError("Finish or discard the existing migration before preparing another")
        conn.execute(
            sql.SQL("""
            CREATE TABLE {} (
                id integer PRIMARY KEY, old_vector vector({}), old_space varchar(64),
                new_vector vector({}), eligible boolean NOT NULL
            )
        """).format(stage, sql.Literal(source_dimension), sql.Literal(dimension))
        )
        digest = hashlib.sha256()
        count = indexed = 0
        with _sources(conn) as rows:
            for row_id, content, old_vector, old_space, eligible, snapshot in rows:
                raw = snapshot.encode("utf-8")
                digest.update(len(raw).to_bytes(8, "big"))
                digest.update(raw)
                new_vector = None
                if eligible:
                    if not content or not content.strip():
                        raise OpsError("An active chunk has no text; repair it before migration")
                    new_vector = _vector(embed(content), dimension)
                    indexed += 1
                conn.execute(
                    sql.SQL("INSERT INTO {} VALUES(%s,%s::vector,%s,%s::vector,%s)").format(stage),
                    (row_id, old_vector, old_space, new_vector, eligible),
                )
                count += 1
        conn.execute(
            f"""
            INSERT INTO {MANIFEST}(run_id,source_dimension,target_dimension,target_space,
                source_digest,prepared_digest,chunk_count,indexed_count,status)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,'prepared')
        """,
            (
                run_id,
                source_dimension,
                dimension,
                space,
                digest.hexdigest(),
                _prepared_digest(conn, stage),
                count,
                indexed,
            ),
        )
        return {"run_id": run_id, "status": "prepared", "chunks": count, "indexed": indexed}


def _run(conn, run_id):
    _stage(run_id)
    _ensure_manifest(conn)
    row = conn.execute(
        f"""
        SELECT source_dimension,target_dimension,target_space,source_digest,active_digest,
               chunk_count,indexed_count,prepared_digest,status FROM {MANIFEST} WHERE run_id=%s FOR UPDATE
    """,
        (run_id,),
    ).fetchone()
    if not row:
        raise OpsError("Migration ID was not found")
    return row


def _switch(conn, stage, dimension, *, rollback, space):
    # Save the real definitions, including index method/options/predicate. DDL and
    # data updates share one transaction, so a failed rebuild restores everything.
    indexes = conn.execute("""
        SELECT DISTINCT n.nspname,i.relname,pg_get_indexdef(i.oid)
        FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
        JOIN pg_namespace n ON n.oid=i.relnamespace
        JOIN pg_depend dep ON dep.classid='pg_class'::regclass AND dep.objid=i.oid
        JOIN pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=dep.refobjsubid
        WHERE x.indrelid='public.document_chunks'::regclass
          AND dep.refobjid=x.indrelid AND a.attname='content_vector'
    """).fetchall()
    for schema, name, _ in indexes:
        conn.execute(sql.SQL("DROP INDEX {}").format(sql.Identifier(schema, name)))
    conn.execute(
        sql.SQL("""
        ALTER TABLE public.document_chunks ALTER COLUMN content_vector TYPE vector({})
        USING NULL::vector({})
    """).format(sql.Literal(dimension), sql.Literal(dimension))
    )
    vector_column = sql.Identifier("old_vector" if rollback else "new_vector")
    space_value = (
        sql.SQL("s.old_space")
        if rollback
        else sql.SQL("CASE WHEN s.eligible THEN %s ELSE NULL END")
    )
    statement = sql.SQL("""
        UPDATE public.document_chunks c SET content_vector=s.{},embedding_space={}
        FROM {} s WHERE c.id=s.id
    """).format(vector_column, space_value, stage)
    conn.execute(statement, None if rollback else (space,))
    for _, _, definition in indexes:
        conn.execute(definition)
    conn.execute("ANALYZE public.document_chunks")


def switch(cfg, run_id, *, rollback=False, writers_stopped=False):
    stage = _stage(run_id)
    if not writers_stopped:
        raise OpsError("Stop all writers and explicitly acknowledge the offline operation")
    with database_lock(cfg.DATABASE_URL, cfg) as conn, conn.transaction():
        conn.execute("LOCK TABLE public.documents, public.document_chunks IN ACCESS EXCLUSIVE MODE")
        source, target, space, before, active, count, indexed, prepared_digest, status = _run(
            conn, run_id
        )
        conn.execute(sql.SQL("LOCK TABLE {} IN SHARE MODE").format(stage))
        if status != ("active" if rollback else "prepared"):
            raise OpsError("Migration status does not allow this operation")
        if _dimension(conn) != (target if rollback else source):
            raise OpsError("Vector column dimension changed since preparation")
        actual, actual_count = _digest(conn)
        if actual != (active if rollback else before) or actual_count != count:
            raise OpsError("Source data changed; refuse to overwrite newer content or permissions")
        stored, valid = conn.execute(
            sql.SQL("""
            SELECT count(*),count(*) FILTER(WHERE
                (eligible AND new_vector IS NOT NULL) OR (NOT eligible AND new_vector IS NULL)) FROM {}
        """).format(stage)
        ).fetchone()
        if stored != count or valid != count:
            raise OpsError("Prepared vectors are incomplete")
        if _prepared_digest(conn, stage) != prepared_digest:
            raise OpsError("Prepared vectors changed; refuse to activate or roll back")
        _switch(conn, stage, source if rollback else target, rollback=rollback, space=space)
        after, _ = _digest(conn)
        if rollback and after != before:
            raise OpsError("Rollback verification failed; transaction was reverted")
        new_status = "rolled_back" if rollback else "active"
        conn.execute(
            f"UPDATE {MANIFEST} SET status=%s,active_digest=%s WHERE run_id=%s",
            (new_status, after, run_id),
        )
        return {"run_id": run_id, "status": new_status, "chunks": count, "indexed": indexed}


def discard(cfg, run_id, *, writers_stopped=False, discard_rollback=False):
    stage = _stage(run_id)
    if not writers_stopped or not discard_rollback:
        raise OpsError("Explicit offline and rollback-discard acknowledgements are required")
    with database_lock(cfg.DATABASE_URL, cfg) as conn, conn.transaction():
        *_, status = _run(conn, run_id)
        if status not in {"prepared", "active", "rolled_back"}:
            raise OpsError("Migration has already been discarded")
        conn.execute(sql.SQL("DROP TABLE {}").format(stage))
        conn.execute(f"UPDATE {MANIFEST} SET status='discarded' WHERE run_id=%s", (run_id,))
        return {"run_id": run_id, "status": "discarded"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inspect", "prepare", "activate", "rollback", "discard"))
    parser.add_argument("--run-id")
    parser.add_argument("--writers-stopped", action="store_true")
    parser.add_argument("--discard-rollback", action="store_true")
    args = parser.parse_args(argv)
    if args.action != "inspect" and not args.writers_stopped:
        parser.error("--writers-stopped is required; stop API, worker, beat and ops first")
    if args.action not in {"inspect", "prepare"} and not args.run_id:
        parser.error("--run-id is required")
    if args.action == "discard" and not args.discard_rollback:
        parser.error("--discard-rollback is required")
    try:
        cfg = OpsSettings()
        if args.action == "inspect":
            result = inspect(cfg)
        elif args.action == "prepare":
            # Load only the configured primary; never fail over or initialize
            # Redis, health probes, local models, or application DB models.
            import httpx
            from openai import OpenAI

            from app.core.config import settings
            from app.core.model_provider.config_loader import ConfigLoader

            providers = ConfigLoader.load().providers.get("embedding", [])
            primary = next((item for item in providers if item.name == "primary"), None)
            if (
                not primary
                or not primary.enabled
                or primary.type != "openai"
                or not primary.dimension
            ):
                raise OpsError(
                    "An enabled OpenAI-compatible primary embedding configuration is required"
                )
            if primary.dimension != settings.EMBEDDING_DIMENSION:
                raise OpsError("Primary embedding dimension must match EMBEDDING_DIMENSION")
            request = {"model": primary.model}
            if primary.supports_dimensions:
                request["dimensions"] = primary.dimension
            with OpenAI(
                api_key=primary.api_key,
                base_url=primary.api_base,
                timeout=primary.timeout,
                max_retries=0,
                http_client=httpx.Client(follow_redirects=False, trust_env=False),
            ) as client:
                result = prepare(
                    cfg,
                    args.run_id or uuid.uuid4().hex,
                    primary.dimension,
                    embedding_space_id(primary, primary.dimension),
                    lambda text: client.embeddings.create(input=text, **request).data[0].embedding,
                    writers_stopped=True,
                )
        elif args.action == "discard":
            result = discard(cfg, args.run_id, writers_stopped=True, discard_rollback=True)
        else:
            result = switch(
                cfg, args.run_id, rollback=args.action == "rollback", writers_stopped=True
            )
        print(json.dumps(result))
        return 0
    except OpsError as error:
        print("FAIL: " + str(error))
    except Exception as error:
        print(
            "FAIL: embedding migration stopped ("
            + type(error).__name__
            + "); inspect migration state before retry"
        )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
