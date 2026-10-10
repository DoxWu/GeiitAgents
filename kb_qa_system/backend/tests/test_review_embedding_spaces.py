from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock

from app.services.vector_store import VectorStoreService


class FakeClient:
    def __init__(self, model, api_base, dimension, vector):
        self.name = model
        self.config = SimpleNamespace(type="openai", model=model, api_base=api_base)
        self.dimension = dimension
        self.vector = vector
        self.calls = 0

    def embed_query(self, text):
        self.calls += 1
        return self.vector


class FakeManager:
    def __init__(self, primary, fallbacks=()):
        self.primary = primary
        self.fallbacks = list(fallbacks)

    def get_embedding_client_with_fallback(self):
        return self.primary, self.fallbacks


def stub_provider_exceptions(monkeypatch):
    package = ModuleType("app.core.model_provider")
    package.__path__ = []
    exceptions = ModuleType("app.core.model_provider.exceptions")
    exceptions.ModelInvocationError = type("ModelInvocationError", (Exception,), {})
    exceptions.ModelClientUnavailableError = type("ModelClientUnavailableError", (Exception,), {})
    monkeypatch.setitem(__import__("sys").modules, "app.core.model_provider", package)
    monkeypatch.setitem(__import__("sys").modules, "app.core.model_provider.exceptions", exceptions)


def test_embedding_cache_changes_with_model_space(monkeypatch):
    from app.services import vector_store

    monkeypatch.setattr(vector_store.settings, "EMBEDDING_DIMENSION", 3)
    cache = {}
    monkeypatch.setattr(vector_store.RedisManager, "get", lambda key: cache.get(key))
    monkeypatch.setattr(vector_store.RedisManager, "set", lambda key, value, ttl: cache.__setitem__(key, value))
    stub_provider_exceptions(monkeypatch)

    first = FakeClient("model-a", "https://one.example/v1", 3, [1.0, 0.0, 0.0])
    store = object.__new__(VectorStoreService)
    store._manager = FakeManager(first)
    vector_a, model_a, space_a = store._generate_embedding_with_space("same text")
    assert (vector_a, model_a) == ([1.0, 0.0, 0.0], "model-a")

    second = FakeClient("model-b", "https://two.example/v1", 3, [0.0, 1.0, 0.0])
    store._manager = FakeManager(second)
    vector_b, model_b, space_b = store._generate_embedding_with_space("same text")
    assert (vector_b, model_b) == ([0.0, 1.0, 0.0], "model-b")
    assert space_a != space_b
    assert first.calls == second.calls == 1


def test_incompatible_dimension_falls_through_without_caching(monkeypatch):
    from app.services import vector_store

    monkeypatch.setattr(vector_store.settings, "EMBEDDING_DIMENSION", 3)
    monkeypatch.setattr(vector_store.RedisManager, "get", lambda key: None)
    cache_writes = []
    monkeypatch.setattr(vector_store.RedisManager, "set", lambda *args, **kwargs: cache_writes.append(args))
    stub_provider_exceptions(monkeypatch)

    incompatible = FakeClient("model-512", "https://one.example/v1", 2, [1.0, 0.0])
    compatible = FakeClient("model-3", "https://two.example/v1", 3, [0.0, 1.0, 0.0])
    store = object.__new__(VectorStoreService)
    store._manager = FakeManager(incompatible, [compatible])

    vector, model, space = store._generate_embedding_with_space("same text")
    assert (vector, model) == ([0.0, 1.0, 0.0], "model-3")
    assert space == store._embedding_space_id(compatible)
    assert incompatible.calls == 0
    assert compatible.calls == 1
    assert len(cache_writes) == 1


def test_missing_embedding_clients_returns_three_part_result(monkeypatch):
    stub_provider_exceptions(monkeypatch)
    unavailable = __import__("sys").modules[
        "app.core.model_provider.exceptions"
    ].ModelClientUnavailableError

    class UnavailableManager:
        def get_embedding_client_with_fallback(self):
            raise unavailable("none enabled")

    store = object.__new__(VectorStoreService)
    store._manager = UnavailableManager()
    assert store._generate_embedding_with_space("query") == (None, "none", None)


def test_keyword_search_only_uses_searchable_document_states(monkeypatch):
    from app.services import vector_store

    class EmptyResult:
        def __iter__(self):
            return iter(())

    class CapturingSession:
        def __init__(self):
            self.statements = []

        def execute(self, statement, params):
            self.statements.append(str(statement))
            return EmptyResult()

        def close(self):
            pass

    session = CapturingSession()
    monkeypatch.setattr(vector_store, "SessionLocal", lambda: session)
    store = object.__new__(VectorStoreService)

    assert store.keyword_search("database知识库", top_k=3) == []
    assert len(session.statements) == 2
    assert all("d.status IN ('completed', 'low_quality')" in sql for sql in session.statements)


def test_openai_embedding_only_sends_dimensions_when_enabled():
    from app.core.model_provider.clients.openai_embedding import OpenAIEmbeddingClient
    from app.core.model_provider.schemas import ProviderEndpointConfig

    for supports_dimensions in (False, True):
        config = ProviderEndpointConfig(
            name="fixture",
            model="fixture-model",
            dimension=3,
            supports_dimensions=supports_dimensions,
        )
        client = OpenAIEmbeddingClient(config)
        call = MagicMock(return_value=SimpleNamespace(
            data=[SimpleNamespace(embedding=[1.0, 0.0, 0.0])]
        ))
        client._client = SimpleNamespace(embeddings=SimpleNamespace(create=call))
        client.breaker = SimpleNamespace(is_open=lambda: False, record_success=lambda: None)

        assert client.embed_query("query") == [1.0, 0.0, 0.0]
        kwargs = call.call_args.kwargs
        assert ("dimensions" in kwargs) is supports_dimensions
        assert kwargs["model"] == "fixture-model"
