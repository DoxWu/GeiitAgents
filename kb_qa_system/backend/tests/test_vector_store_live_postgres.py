"""Real pgvector SQL, migrations and permissions; embeddings are synthetic.

Uses the existing opt-in, disposable local PostgreSQL fixture. No supplier calls
or model downloads; this does not measure semantic retrieval quality.
"""

from types import SimpleNamespace

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from test_ops import live, seeded  # noqa: F401  Explicit disposable cluster fixture.

from app.core.config import settings
from app.models import Document, DocumentChunk, User
from app.services.vector_store import VectorStoreService


class SyntheticEmbedding:
    name = "synthetic-live-pg"
    dimension = settings.EMBEDDING_DIMENSION
    config = SimpleNamespace(type="openai", model=name, api_base="https://invalid.example/v1")

    def embed_query(self, value):
        return [1.0] + [0.0] * (self.dimension - 1)


def test_live_vector_space_reprocessing_and_document_permissions(live, monkeypatch):  # noqa: F811
    from app.core import database
    from app.services import rag_chain, vector_store

    cfg, _ = live
    cfg = seeded(cfg)
    engine = create_engine(cfg.DATABASE_URL.replace("postgresql://", "postgresql+psycopg://"))
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", factory)
    monkeypatch.setattr(vector_store, "SessionLocal", factory)
    monkeypatch.setattr(settings, "ENABLE_RERANKING", False)
    # This test covers PostgreSQL itself, independently of cache availability.
    monkeypatch.setattr(vector_store.RedisManager, "get", lambda key: None)
    monkeypatch.setattr(vector_store.RedisManager, "set", lambda *a, **kw: True)
    client = SyntheticEmbedding()
    store = object.__new__(VectorStoreService)
    store._manager = SimpleNamespace(get_embedding_client_with_fallback=lambda: (client, []))
    monkeypatch.setattr(rag_chain, "get_vector_store", lambda: store)
    vector = client.embed_query("fixture")
    space = store._embedding_space_id(client)

    try:
        with factory() as db:
            column_type = db.execute(
                text("""
                SELECT format_type(atttypid, atttypmod) FROM pg_attribute
                WHERE attrelid = 'document_chunks'::regclass AND attname = 'content_vector'
            """)
            ).scalar_one()
            assert column_type == f"vector({settings.EMBEDDING_DIMENSION})"
            owner = User(username="owner", email="owner@example.test", hashed_password="fixture")
            other = User(username="other", email="other@example.test", hashed_password="fixture")
            db.add_all([owner, other])
            db.flush()
            ids = {}
            for kind in ("own", "other", "public", "processing", "failed", "deleted", "legacy"):
                document = Document(
                    title=kind,
                    file_name=f"{kind}.txt",
                    file_path=f"fixtures/{kind}.txt",
                    file_type="txt",
                    file_size=32,
                    content="synthetic acceptance text",
                    user_id=other.id if kind == "other" else owner.id,
                    visibility="public" if kind == "public" else "private",
                    status=kind if kind in {"processing", "failed"} else "completed",
                    is_deleted=kind == "deleted",
                )
                db.add(document)
                db.flush()
                ids[kind] = document.id
                db.add(
                    DocumentChunk(
                        document_id=document.id,
                        chunk_index=0,
                        content="synthetic acceptance text",
                        content_vector=vector,
                        embedding_space=None if kind == "legacy" else space,
                    )
                )
            db.commit()
            owner_id = owner.id

        def returned_ids(results):
            return {item["metadata"]["document_id"] for item in results}

        results = store.vector_search("synthetic acceptance", top_k=20)
        assert returned_ids(results) == {ids[kind] for kind in ("own", "other", "public")}
        assert store.vector_search("synthetic acceptance", document_ids=[]) == []
        assert returned_ids(
            store.vector_search("synthetic acceptance", top_k=20, document_ids=[ids["own"]])
        ) == {ids["own"]}

        rag = rag_chain.RAGChainService()
        scope = [ids[kind] for kind in ("own", "other", "public")]
        assert returned_ids(
            rag.retrieve_context(
                "synthetic acceptance", top_k=20, user_id=owner_id, document_ids=scope
            )
        ) == {ids["own"], ids["public"]}
        assert returned_ids(
            rag.retrieve_context(
                "synthetic acceptance",
                top_k=20,
                user_id=owner_id,
                document_ids=scope,
                user_type="guest",
            )
        ) == {ids["public"]}
        assert rag.retrieve_context("synthetic acceptance", document_ids=scope) == []

        # NULL legacy spaces cannot be compared. Explicitly regenerate their
        # vectors from preserved text before they become vector-searchable.
        store.delete_document_chunks(ids["legacy"])
        assert store.add_chunks([{"text": "synthetic acceptance text"}], ids["legacy"]) == 1
        assert ids["legacy"] in returned_ids(store.vector_search("synthetic acceptance", top_k=20))
        with factory() as db:
            rebuilt = db.query(DocumentChunk).filter_by(document_id=ids["legacy"]).one()
            assert rebuilt.embedding_space == space
            assert len(rebuilt.content_vector) == settings.EMBEDDING_DIMENSION
            assert db.get(Document, ids["legacy"]).content == "synthetic acceptance text"
    finally:
        engine.dispose()
