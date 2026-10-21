"""Real PostgreSQL/pgvector migration, failure atomicity and rollback guards."""

import uuid

import pytest
from psycopg import sql
from test_ops import live, seeded  # noqa: F401

from app.ops import embedding_migration as migration
from app.ops.postgres import OpsError, connect, database_lock

SPACE = "a" * 64


@pytest.fixture
def corpus(live):  # noqa: F811
    cfg, _ = live
    cfg = seeded(cfg)
    with connect(cfg.DATABASE_URL, cfg) as conn:
        # Exercise a pre-existing 1536-dimensional column and its real IVFFlat
        # index, regardless of the test application's configured dimension.
        conn.execute("DROP INDEX ix_document_chunks_content_vector")
        conn.execute(
            "ALTER TABLE document_chunks ALTER COLUMN content_vector TYPE vector(1536) USING NULL::vector(1536)"
        )
        for kind in ("completed", "low_quality", "failed", "deleted"):
            doc_id = conn.execute(
                """
                INSERT INTO documents(title,file_name,file_path,file_type,file_size,status,
                    user_id,visibility,is_deleted,content)
                VALUES(%s,%s,'fixture.txt','txt',32,%s,1,'private',%s,'保留正文') RETURNING id
            """,
                (
                    kind,
                    kind + ".txt",
                    "completed" if kind == "deleted" else kind,
                    kind == "deleted",
                ),
            ).fetchone()[0]
            conn.execute(
                """
                INSERT INTO document_chunks(document_id,chunk_index,content,content_vector,embedding_space)
                VALUES(%s,0,'合成迁移材料',%s::vector,%s)
            """,
                (doc_id, "[1," + ",".join(["0"] * 1535) + "]", "b" * 64),
            )
        conn.execute(
            "CREATE INDEX ix_document_chunks_content_vector ON document_chunks USING ivfflat(content_vector vector_cosine_ops) WITH(lists=1)"
        )
    return cfg


def snapshot(cfg):
    with connect(cfg.DATABASE_URL, cfg) as conn:
        return migration._dimension(conn), migration._digest(conn)


def build(cfg, embed=None):
    run_id = uuid.uuid4().hex
    result = migration.prepare(
        cfg, run_id, 1024, SPACE, embed or (lambda _: [1.0] + [0.0] * 1023), writers_stopped=True
    )
    assert result == {"run_id": run_id, "status": "prepared", "chunks": 4, "indexed": 2}
    return run_id


def test_live_cross_dimension_activation_index_and_exact_rollback(corpus):
    cfg = corpus
    before = snapshot(cfg)
    run_id = build(cfg)
    assert snapshot(cfg) == before  # Preparation leaves live rows and dimensions untouched.
    assert migration.switch(cfg, run_id, writers_stopped=True)["status"] == "active"
    with connect(cfg.DATABASE_URL, cfg) as conn:
        assert migration._dimension(conn) == 1024
        rows = conn.execute("""
            SELECT d.title,vector_dims(c.content_vector),c.embedding_space
            FROM document_chunks c JOIN documents d ON d.id=c.document_id ORDER BY c.id
        """).fetchall()
        assert rows == [
            ("completed", 1024, SPACE),
            ("low_quality", 1024, SPACE),
            ("failed", None, None),
            ("deleted", None, None),
        ]
        assert (
            conn.execute(
                "SELECT count(*) FROM pg_index WHERE indexrelid='ix_document_chunks_content_vector'::regclass AND indisvalid"
            ).fetchone()[0]
            == 1
        )
        conn.execute("SET LOCAL enable_seqscan=off")
        vector = "[1," + ",".join(["0"] * 1023) + "]"
        plan = conn.execute(
            "EXPLAIN SELECT id FROM document_chunks ORDER BY content_vector <=> %s::vector LIMIT 1",
            (vector,),
        ).fetchall()
        assert "ix_document_chunks_content_vector" in str(plan)
        assert (
            conn.execute(
                "SELECT embedding_space FROM document_chunks WHERE content_vector IS NOT NULL ORDER BY content_vector <=> %s::vector LIMIT 1",
                (vector,),
            ).fetchone()[0]
            == SPACE
        )
    assert (
        migration.switch(cfg, run_id, rollback=True, writers_stopped=True)["status"]
        == "rolled_back"
    )
    assert (
        snapshot(cfg) == before
    )  # Original vectors, NULLs, spaces, metadata and documents match exactly.
    migration.discard(cfg, run_id, writers_stopped=True, discard_rollback=True)
    assert migration.inspect(cfg)["migrations"][0]["status"] == "discarded"


@pytest.mark.parametrize("bad", ([1.0], [float("nan")] * 1024, [0.0] * 1024))
def test_live_invalid_embeddings_preserve_original_schema_and_data(corpus, bad):
    before = snapshot(corpus)
    with pytest.raises(OpsError, match="finite, nonzero"):
        build(corpus, lambda _: bad)
    assert snapshot(corpus) == before
    assert migration.inspect(corpus)["migrations"] == []


@pytest.mark.parametrize("change", ("content", "permission", "insert"))
def test_live_source_changes_block_activation(corpus, change):
    run_id = build(corpus)
    with connect(corpus.DATABASE_URL, corpus) as conn:
        if change == "content":
            conn.execute(
                "UPDATE document_chunks SET content='更新材料' WHERE id=(SELECT min(id) FROM document_chunks)"
            )
        elif change == "permission":
            conn.execute("UPDATE documents SET visibility='public'")
        else:
            conn.execute(
                "INSERT INTO document_chunks(document_id,chunk_index,content) SELECT min(id),1,'新材料' FROM documents"
            )
    changed = snapshot(corpus)
    with pytest.raises(OpsError, match="Source data changed"):
        migration.switch(corpus, run_id, writers_stopped=True)
    assert snapshot(corpus) == changed
    migration.discard(corpus, run_id, writers_stopped=True, discard_rollback=True)


def test_live_new_writes_block_rollback_and_preserve_newer_data(corpus):
    run_id = build(corpus)
    migration.switch(corpus, run_id, writers_stopped=True)
    with connect(corpus.DATABASE_URL, corpus) as conn:
        conn.execute("UPDATE document_chunks SET content='切换后的新材料'")
    changed = snapshot(corpus)
    with pytest.raises(OpsError, match="Source data changed"):
        migration.switch(corpus, run_id, rollback=True, writers_stopped=True)
    assert snapshot(corpus) == changed


def test_live_index_rebuild_failure_reverts_ddl_and_vectors(corpus, monkeypatch):
    run_id = build(corpus)
    before = snapshot(corpus)
    original = migration._switch

    def failing(*args, **kwargs):
        original(*args, **kwargs)
        raise OpsError("Injected failure after index rebuild")

    monkeypatch.setattr(migration, "_switch", failing)
    with pytest.raises(OpsError, match="Injected failure"):
        migration.switch(corpus, run_id, writers_stopped=True)
    assert snapshot(corpus) == before
    assert migration.inspect(corpus)["migrations"][0]["status"] == "prepared"


def test_live_missing_staging_vector_rejected(corpus):
    run_id = build(corpus)
    with connect(corpus.DATABASE_URL, corpus) as conn:
        conn.execute(
            sql.SQL("UPDATE {} SET new_vector=NULL WHERE eligible").format(migration._stage(run_id))
        )
    with pytest.raises(OpsError, match="incomplete"):
        migration.switch(corpus, run_id, writers_stopped=True)
    assert snapshot(corpus)[0] == 1536


def test_live_migration_obeys_existing_maintenance_lock(corpus):
    with database_lock(corpus.DATABASE_URL, corpus):
        with pytest.raises(OpsError, match="already running"):
            build(corpus)


def test_live_preparation_cannot_replace_existing_rollback_window(corpus):
    run_id = build(corpus)
    with pytest.raises(OpsError, match="existing migration"):
        build(corpus)
    migration.switch(corpus, run_id, writers_stopped=True)
    with pytest.raises(OpsError, match="existing migration"):
        build(corpus)


def test_live_prepared_vector_tampering_is_rejected(corpus):
    run_id = build(corpus)
    with connect(corpus.DATABASE_URL, corpus) as conn:
        conn.execute(sql.SQL("UPDATE {} SET old_space=NULL").format(migration._stage(run_id)))
    with pytest.raises(OpsError, match="Prepared vectors changed"):
        migration.switch(corpus, run_id, writers_stopped=True)
    assert snapshot(corpus)[0] == 1536


def test_live_supplier_failure_leaves_no_partial_migration(corpus):
    before = snapshot(corpus)
    calls = []

    def failed(_):
        calls.append(1)
        if len(calls) == 1:
            return [1.0] + [0.0] * 1023
        raise RuntimeError("synthetic provider failure")

    with pytest.raises(RuntimeError, match="synthetic provider"):
        build(corpus, failed)
    assert snapshot(corpus) == before
    assert migration.inspect(corpus)["migrations"] == []
    assert len(calls) == 2


def test_offline_acknowledgement_and_identifier_validation():
    with pytest.raises(OpsError, match="Stop all writers"):
        migration.prepare(None, "a" * 32, 1024, SPACE, lambda _: [])
    with pytest.raises(OpsError, match="Migration ID"):
        migration.switch(None, "unsafe;drop", writers_stopped=True)
    with pytest.raises(OpsError, match="discard acknowledgements"):
        migration.discard(None, "a" * 32, writers_stopped=True)
