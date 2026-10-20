"""Synthetic tests for the deployment-only provider acceptance command."""

from types import SimpleNamespace

import httpx
import pytest

from app.ops import provider_acceptance as acceptance


def test_environment_placeholder_resolution_uses_process_environment(monkeypatch):
    monkeypatch.setenv("TEST_PRIMARY_KEY", "primary-value")
    monkeypatch.delenv("TEST_FALLBACK_KEY", raising=False)
    assert (
        acceptance.resolve_environment("${TEST_PRIMARY_KEY:${TEST_FALLBACK_KEY:default}}")
        == "primary-value"
    )
    assert acceptance.resolve_environment("${TEST_MISSING_KEY:default}") == "default"


def test_preflight_requires_separate_aliyun_and_deepseek_endpoints(monkeypatch):
    providers = {
        "llm": [
            {
                "name": "primary",
                "model": "chat",
                "api_key": "k",
                "api_base": "https://dashscope.aliyuncs.com/v1",
            },
            {
                "name": "fallback",
                "model": "chat-backup",
                "api_key": "k2",
                "api_base": "https://api.deepseek.com/v1",
                "enabled": True,
            },
        ],
        "embedding": [
            {
                "name": "primary",
                "model": "embed",
                "api_key": "k",
                "api_base": "https://dashscope.aliyuncs.com/v1",
                "dimension": 1536,
            },
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


def test_smtp_preflight_requires_host_password_and_valid_port(monkeypatch):
    monkeypatch.setenv("SMTP_HOST", "smtp.example.invalid")
    monkeypatch.setenv("SMTP_PORT", "465")
    monkeypatch.setenv("SMTP_PASSWORD", "test-secret")
    monkeypatch.setenv("EMAIL_FROM", "sender@example.invalid")
    monkeypatch.setenv("SMTP_USE_TLS", "true")
    monkeypatch.setenv("SMTP_START_TLS", "false")
    assert acceptance.preflight_smtp("recipient@example.invalid") == []
    monkeypatch.setenv("SMTP_PORT", "70000")
    assert any(
        "SMTP_PORT" in issue for issue in acceptance.preflight_smtp("recipient@example.invalid")
    )


def test_smtp_test_is_single_shot_and_reports_acceptance_without_credentials(monkeypatch):
    class Client:
        calls = 0

        def __init__(self, host, port, **kwargs):
            assert (host, port) == ("smtp.example.invalid", 465)
            assert kwargs["timeout"] == 15

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def login(self, username, password):
            assert username == "smtp-user"
            assert password == "test-secret"

        def send_message(self, message):
            type(self).calls += 1
            assert message["To"] == "recipient@example.invalid"
            assert "one-time deployment acceptance test" in message.get_content()
            return {}

    monkeypatch.setenv("SMTP_HOST", "smtp.example.invalid")
    monkeypatch.setenv("SMTP_PORT", "465")
    monkeypatch.setenv("SMTP_TIMEOUT", "15")
    monkeypatch.setenv("SMTP_USER", "smtp-user")
    monkeypatch.setenv("SMTP_PASSWORD", "test-secret")
    monkeypatch.setenv("SMTP_USE_TLS", "true")
    monkeypatch.setenv("SMTP_START_TLS", "false")
    monkeypatch.setenv("EMAIL_FROM", "sender@example.invalid")
    monkeypatch.setattr(acceptance.smtplib, "SMTP_SSL", Client)
    assert acceptance.send_smtp_test("recipient@example.invalid") == "accepted"
    assert Client.calls == 1


def test_smtp_timeout_is_unknown_and_is_not_retried(monkeypatch):
    class Client:
        calls = 0

        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def send_message(self, _message):
            type(self).calls += 1
            raise TimeoutError("private smtp response")

    monkeypatch.setenv("SMTP_HOST", "smtp.example.invalid")
    monkeypatch.setenv("SMTP_PORT", "465")
    monkeypatch.setenv("SMTP_PASSWORD", "test-secret")
    monkeypatch.setenv("EMAIL_FROM", "sender@example.invalid")
    monkeypatch.setenv("SMTP_USE_TLS", "true")
    monkeypatch.setenv("SMTP_START_TLS", "false")
    monkeypatch.setattr(acceptance.smtplib, "SMTP_SSL", Client)
    assert acceptance.send_smtp_test("recipient@example.invalid") == "unknown:timeout"
    assert Client.calls == 1


def test_provider_probes_allow_reasoning_budget_and_use_application_tool_choice(monkeypatch):
    requests = []

    def create(**request):
        requests.append(request)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content="OK",
                        tool_calls=[
                            SimpleNamespace(function=SimpleNamespace(name="acceptance_probe"))
                        ],
                    )
                )
            ]
        )

    class Client:
        def __init__(self, **_kwargs):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=create))

        def close(self):
            pass

    monkeypatch.setattr(acceptance, "OpenAI", Client)
    endpoint = {"model": "model", "api_key": "key", "api_base": "https://example.invalid/v1"}
    acceptance.probe_chat(endpoint, "synthetic")
    acceptance.probe_tools(endpoint, "synthetic")
    assert all(request["max_tokens"] >= 256 for request in requests)
    assert requests[1]["tool_choice"] == "auto"


@pytest.mark.parametrize("supports_dimensions", [False, "false", "true", True])
def test_embedding_probe_respects_string_and_boolean_dimension_capability(
    monkeypatch, supports_dimensions
):
    requests = []

    def create(**request):
        requests.append(request)
        return SimpleNamespace(data=[SimpleNamespace(embedding=[0.0] * 3)])

    class Client:
        def __init__(self, **_kwargs):
            self.embeddings = SimpleNamespace(create=create)

        def close(self):
            pass

    monkeypatch.setattr(acceptance, "OpenAI", Client)
    item = {
        "model": "embed",
        "api_key": "synthetic",
        "api_base": "https://example.invalid/v1",
        "dimension": "3",
        "supports_dimensions": supports_dimensions,
    }
    acceptance.probe_embedding(item, "synthetic", 3)
    assert ("dimensions" in requests[0]) == (supports_dimensions in (True, "true"))
