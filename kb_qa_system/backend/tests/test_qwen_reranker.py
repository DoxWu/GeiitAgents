"""Synthetic reranking contracts; no real providers, database or local ML downloads."""

import json
from types import SimpleNamespace
from urllib.parse import urlsplit

import httpx
import pytest
from pydantic import ValidationError

from app.core.model_provider.schemas import ModelProviderConfig, ProviderEndpointConfig
from app.schemas.chat import QuestionRequest, RegenerateRequest
from app.services import qwen_reranker as reranker

DOCUMENTS = [
    {"content": "Annual leave is 10 days.", "metadata": {"document_id": 7}, "score": 0.8},
    {"content": "Apply through the HR portal.", "metadata": {"document_id": 8}, "score": 0.7},
]


@pytest.fixture
def primary(monkeypatch):
    endpoint = ProviderEndpointConfig(
        name="primary",
        api_key="synthetic-secret",
        api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    config = ModelProviderConfig(providers={"llm": [endpoint]})
    monkeypatch.setattr(reranker.ConfigLoader, "load", lambda: config)
    return endpoint


def transport(monkeypatch, handler):
    client_type = httpx.Client
    monkeypatch.setattr(
        reranker.httpx,
        "Client",
        lambda **kwargs: client_type(transport=httpx.MockTransport(handler), **kwargs),
    )


@pytest.mark.parametrize(
    "base",
    [
        "https://dashscope.aliyuncs.com/compatible-mode/v1/",
        "https://dashscope-intl.aliyuncs.com/api/v1",
        "https://dashscope-us.aliyuncs.com/v1",
        "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    ],
)
def test_endpoint_keeps_primary_host_and_region(base):
    assert urlsplit(reranker.rerank_url(base)).netloc == urlsplit(base).netloc
    assert reranker.rerank_url(base).endswith("/api/v1/services/rerank/text-rerank/text-rerank")


@pytest.mark.parametrize(
    "base",
    [
        "http://dashscope.aliyuncs.com/v1",
        "https://dashscope.aliyuncs.com.evil.test/v1",
        "https://api.deepseek.com/v1",
        "https://user:password@dashscope.aliyuncs.com/v1",
        "https://dashscope.aliyuncs.com/v1?key=secret",
        "https://dashscope.aliyuncs.com/unknown",
    ],
)
def test_unknown_primary_never_receives_a_rerank_request(base):
    with pytest.raises(ValueError):
        reranker.rerank_url(base)


def test_primary_request_maps_indexes_and_preserves_sources(monkeypatch, primary):
    def handler(request):
        body = json.loads(request.content)
        assert request.headers["Authorization"] == "Bearer synthetic-secret"
        assert body == {
            "model": reranker.MODEL,
            "input": {"query": "How do I apply?", "documents": [d["content"] for d in DOCUMENTS]},
            "parameters": {"top_n": 2},
        }
        return httpx.Response(
            200,
            json={
                "output": {
                    "results": [
                        {"index": 0, "relevance_score": 0.2},
                        {"index": 1, "relevance_score": 0.9},
                    ]
                }
            },
        )

    transport(monkeypatch, handler)
    output = reranker.rerank_with_primary("How do I apply?", DOCUMENTS, 2)
    assert [d["metadata"]["document_id"] for d in output] == [8, 7]
    assert output[0]["score"] == 0.7
    assert output[0]["rerank_score"] == 0.9
    assert all("rerank_score" not in d for d in DOCUMENTS)


@pytest.mark.parametrize(
    "results",
    [
        [{"index": 20, "relevance_score": 0.8}],
        [{"index": True, "relevance_score": 0.8}],
        [{"index": 0, "relevance_score": float("nan")}],
        [{"index": 0, "relevance_score": 1.1}],
        [{"index": 0, "relevance_score": "0.8"}],
        [],
    ],
)
def test_invalid_results_fall_back_atomically(monkeypatch, primary, results):
    transport(
        monkeypatch,
        lambda _: httpx.Response(200, content=json.dumps({"output": {"results": results}})),
    )
    assert reranker.rerank_with_primary("query", DOCUMENTS, 1) == DOCUMENTS[:1]


def test_duplicate_indexes_are_rejected(monkeypatch, primary):
    transport(
        monkeypatch,
        lambda _: httpx.Response(
            200, json={"output": {"results": [{"index": 0, "relevance_score": 0.9}] * 2}}
        ),
    )
    assert reranker.rerank_with_primary("query", DOCUMENTS, 2) == DOCUMENTS


@pytest.mark.parametrize("status", [302, 401, 429, 500])
def test_provider_errors_preserve_order_without_logging_bodies(
    monkeypatch, primary, caplog, status
):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status,
            text="synthetic-secret private source text",
            headers={"Location": "https://evil.test/"},
        )

    transport(monkeypatch, handler)
    assert reranker.rerank_with_primary("query", DOCUMENTS, 1) == DOCUMENTS[:1]
    assert len(calls) == 1
    assert "synthetic-secret" not in caplog.text
    assert "private source" not in caplog.text


def test_timeout_falls_back(monkeypatch, primary):
    def timeout(_):
        raise httpx.ReadTimeout("private detail")

    transport(monkeypatch, timeout)
    assert reranker.rerank_with_primary("query", DOCUMENTS, 1) == DOCUMENTS[:1]


def test_oversized_response_falls_back(monkeypatch, primary):
    transport(
        monkeypatch, lambda _: httpx.Response(200, content=b"x" * (reranker.MAX_RESPONSE_BYTES + 1))
    )
    assert reranker.rerank_with_primary("query", DOCUMENTS, 1) == DOCUMENTS[:1]


def test_input_budget_does_not_call_provider(monkeypatch, primary):
    monkeypatch.setattr(reranker.httpx, "Client", lambda **_: pytest.fail("must not call provider"))
    docs = [{"content": "x" * (reranker.MAX_DOCUMENT_CHARACTERS + 1)}, DOCUMENTS[1]]
    assert reranker.rerank_with_primary("query", docs, 1) == docs[:1]
    primary.enabled = False
    assert reranker.rerank_with_primary("query", DOCUMENTS, 1) == DOCUMENTS[:1]


def test_request_schemas_default_to_current_and_reject_arbitrary_models():
    assert QuestionRequest(question="q").rerank_mode == "current"
    assert (
        RegenerateRequest(conversation_id=1, rerank_mode=reranker.MODEL).rerank_mode
        == reranker.MODEL
    )
    with pytest.raises(ValidationError):
        QuestionRequest(question="q", rerank_mode="untrusted-model")


def test_rag_scope_default_and_opt_in_are_request_local(monkeypatch):
    from app.services import rag_chain

    service = rag_chain.RAGChainService()
    monkeypatch.setattr(rag_chain.settings, "ENABLE_RERANKING", False)
    monkeypatch.setattr(service, "_compute_search_scope", lambda *args: [7, 8])
    searches = []

    def search(query, **kwargs):
        searches.append(kwargs)
        return DOCUMENTS

    monkeypatch.setattr(rag_chain, "get_vector_store", lambda: SimpleNamespace(search=search))
    calls = []

    def rank(query, docs, top_k):
        calls.append(docs)
        return docs[::-1][:top_k]

    monkeypatch.setattr(reranker, "rerank_with_primary", rank)
    assert service.retrieve_context("query", top_k=2, user_id=1) == DOCUMENTS
    assert not calls
    assert (
        service.retrieve_context("query", top_k=2, user_id=1, rerank_mode=reranker.MODEL)
        == DOCUMENTS[::-1]
    )
    assert searches[-1]["document_ids"] == [7, 8]
    assert searches[-1]["top_k"] <= reranker.MAX_CANDIDATES
    assert service.retrieve_context("query", top_k=2, user_id=1) == DOCUMENTS
    assert len(calls) == 1
    monkeypatch.setattr(service, "_compute_search_scope", lambda *args: [])
    assert service.retrieve_context("query", user_id=2, rerank_mode=reranker.MODEL) == []
    assert len(calls) == 1
