"""Synthetic tests for the deployment-only provider acceptance command."""

import httpx
import pytest

from app.ops import provider_acceptance as acceptance


def test_environment_placeholder_resolution_uses_process_environment(monkeypatch):
    monkeypatch.setenv("TEST_PRIMARY_KEY", "primary-value")
    monkeypatch.delenv("TEST_FALLBACK_KEY", raising=False)
    assert acceptance.resolve_environment(
        "${TEST_PRIMARY_KEY:${TEST_FALLBACK_KEY:default}}"
    ) == "primary-value"
    assert acceptance.resolve_environment(
        "${TEST_MISSING_KEY:default}"
    ) == "default"


def test_preflight_requires_separate_aliyun_and_deepseek_endpoints(monkeypatch):
    providers = {
        "llm": [
            {"name": "primary", "model": "chat", "api_key": "k", "api_base": "https://dashscope.aliyuncs.com/v1"},
            {"name": "fallback", "model": "chat-backup", "api_key": "k2", "api_base": "https://api.deepseek.com/v1", "enabled": True},
        ],
        "embedding": [
            {"name": "primary", "model": "embed", "api_key": "k", "api_base": "https://dashscope.aliyuncs.com/v1", "dimension": 1536},
            {"name": "cloud_fallback", "enabled": False},
        ],
    }
    monkeypatch.setenv("EMBEDDING_DIMENSION", "1536")
    assert acceptance.preflight(providers) == []
    providers["embedding"][0]["api_base"] = "https://api.deepseek.com/v1"
    assert any("aliyun_embedding" in item for item in acceptance.preflight(providers))


def test_database_vector_type_dimension_parser():
    assert acceptance.re.fullmatch(r"vector\((\d+)\)", "vector(1536)").group(1) == "1536"
    assert acceptance.re.fullmatch(r"vector\((\d+)\)", "vector") is None


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (type("Unauthorized", (Exception,), {"status_code": 401})(), "unauthorized"),
        (type("RateLimited", (Exception,), {"status_code": 429})(), "rate_limited"),
        (httpx.ReadTimeout("private provider body"), "timeout"),
    ],
)
def test_failure_diagnostics_exclude_provider_message(error, expected):
    diagnostic = acceptance.safe_failure(error)
    assert diagnostic == expected
    assert "private provider body" not in diagnostic


def test_resend_timeout_is_reported_as_unknown_without_retry(monkeypatch):
    class Client:
        def __init__(self, **_kwargs):
            self.calls = 0

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, *_args, **_kwargs):
            self.calls += 1
            raise httpx.ReadTimeout("private provider body")

    instances = []

    def client_factory(**kwargs):
        instance = Client(**kwargs)
        instances.append(instance)
        return instance

    monkeypatch.setattr(acceptance.httpx, "Client", client_factory)
    monkeypatch.setenv("RESEND_API_KEY", "test-secret")
    monkeypatch.setenv("EMAIL_FROM", "test@example.invalid")
    result = acceptance.send_resend_test("recipient@example.invalid")
    assert result == "unknown:timeout"
    assert sum(item.calls for item in instances) == 1
