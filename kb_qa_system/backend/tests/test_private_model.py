"""Behavior tests for the request-scoped relay; no database or provider calls."""
import asyncio
import base64
import json
import socket
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from pydantic import ValidationError

from app.core.privacy import filter_monitoring_event
from app.schemas.private_model import PrivateCompletion
from app.services.private_model import PrivateModelError, complete_private, public_endpoint, stream_private


def payload(**changes):
    return PrivateCompletion.model_validate({
        "base_url": "https://models.example/v1", "model": "test-model",
        "messages": [{"role": "user", "content": "hello"}], **changes,
    })


def test_multimodal_request_accepts_bounded_png_and_rejects_mime_spoofing():
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()
    data = payload(messages=[{"role": "user", "content": [
        {"type": "text", "text": "inspect this chart"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{png}"}},
    ]}])
    assert data.messages[0].content[1]["image_url"]["url"].startswith("data:image/png;base64,")
    with pytest.raises(ValidationError):
        payload(messages=[{"role": "user", "content": [
            {"type": "text", "text": "inspect"},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{png}"}},
        ]}])


def test_multimodal_request_rejects_extra_fields_and_too_many_images():
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()
    image = {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{png}"}}
    with pytest.raises(ValidationError):
        payload(messages=[{"role": "user", "content": [{"type": "text", "text": "inspect"}, image, image, image, image]}])


def test_resolves_once_and_pins_ip_with_original_tls_hostname():
    async def run():
        dns = AsyncMock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))])
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", dns):
            assert await public_endpoint("https://models.example/v1/") == (
                "https://1.1.1.1/v1/chat/completions", "models.example", "models.example")
            dns.assert_awaited_once()
    asyncio.run(run())


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "192.168.0.1", "224.0.0.1"])
def test_private_or_special_dns_is_rejected(address):
    async def run():
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", AsyncMock(return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)),
        ])):
            with pytest.raises(PrivateModelError) as error:
                await public_endpoint("https://models.example/v1")
            assert error.value.status == 400
    asyncio.run(run())


@pytest.mark.parametrize("url", ["http://models.example/v1", "https://models.example:8443/v1", "https://key@models.example/v1", "https://models.example/v1?key=secret", "https://models.example/v1#secret"])
def test_unsafe_urls_are_rejected_before_dns(url):
    async def run():
        dns = AsyncMock()
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", dns):
            with pytest.raises(PrivateModelError):
                await public_endpoint(url)
            dns.assert_not_called()
    asyncio.run(run())


def relay_mock(handler):
    original = httpx.AsyncClient
    def factory(**kwargs):
        assert kwargs["follow_redirects"] is False
        assert kwargs["trust_env"] is False
        return original(transport=httpx.MockTransport(handler), **kwargs)
    return patch("app.services.private_model.httpx.AsyncClient", factory)


def test_concurrent_keys_remain_request_scoped():
    async def run():
        seen = []
        async def handler(request):
            await asyncio.sleep(0)
            seen.append(request.headers["Authorization"])
            assert request.headers["Host"] == "models.example"
            assert request.extensions["sni_hostname"] == "models.example"
            assert str(request.url) == "https://1.1.1.1/v1/chat/completions"
            assert "api_key" not in json.loads(request.content)
            return httpx.Response(200, json={"choices": [{"message": {"content": "done"}}], "debug": "ignored"})
        with patch("app.services.private_model.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), relay_mock(handler):
            results = await asyncio.gather(complete_private(payload(), "key-one"), complete_private(payload(), "key-two"))
        assert sorted(seen) == ["Bearer key-one", "Bearer key-two"]
        assert results == [{"content": "done", "model": "test-model"}] * 2
    asyncio.run(run())


@pytest.mark.parametrize("status", [301, 307, 401, 403, 429, 500])
def test_error_bodies_and_redirects_never_escape(status):
    async def run():
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(status, text="secret-fixture echoed by upstream", headers={"location": "https://other.example"})
        with patch("app.services.private_model.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), relay_mock(handler):
            with pytest.raises(PrivateModelError) as error:
                await complete_private(payload(), "secret-fixture")
            assert "secret-fixture" not in str(error.value)
            assert len(calls) == 1
    asyncio.run(run())


@pytest.mark.parametrize("body", [b"bad-json", b"x" * (2 * 1024 * 1024 + 1), b'{"choices":[]}'], ids=["invalid-json", "oversized", "empty-choices"])
def test_malformed_and_oversized_responses_have_generic_errors(body):
    async def run():
        with patch("app.services.private_model.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), relay_mock(lambda _: httpx.Response(200, content=body)):
            with pytest.raises(PrivateModelError):
                await complete_private(payload(), "fixture-key")
    asyncio.run(run())


def test_credentials_cannot_be_persisted_as_body_fields():
    with pytest.raises(ValidationError):
        payload(api_key="fixture-key")
    data = bytearray(payload().model_dump_json().encode())
    assert PrivateCompletion.model_validate_json(data).model == "test-model"


@pytest.mark.parametrize("limit", [None, 100000])
def test_optional_output_limit_is_omitted_or_forwarded(limit):
    async def run():
        def handler(request):
            body = json.loads(request.content)
            if limit is None:
                assert "max_tokens" not in body
            else:
                assert body["max_tokens"] == limit
            return httpx.Response(200, json={"choices": [{"message": {"content": "done"}}]})
        with patch("app.services.private_model.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), relay_mock(handler):
            await complete_private(payload(max_tokens=limit), "fixture-key")
    asyncio.run(run())


def test_stream_private_forwards_only_text_deltas_and_omits_credentials_from_body():
    async def run():
        def handler(request):
            body = json.loads(request.content)
            assert body["stream"] is True
            assert "api_key" not in body
            return httpx.Response(200, content=(
                b'data: {"choices":[{"delta":{"content":"one"}}]}\n\n'
                b'data: {"choices":[{"delta":{"content":"two"}}]}\n\n'
                b'data: [DONE]\n\n'
            ), headers={"content-type": "text/event-stream"})
        with patch.object(app.services.private_model, "public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), relay_mock(handler):
            chunks = [chunk async for chunk in stream_private(payload(max_tokens=100), "fixture-key")]
        assert chunks == ["one", "two"]
    import app.services.private_model
    asyncio.run(run())


def test_monitoring_drops_private_requests_and_scrubs_other_headers():
    assert filter_monitoring_event({"request": {"url": "https://app/api/v1/private-models/complete", "data": "fixture"}}, {}) is None
    assert filter_monitoring_event({"transaction": "/api/v1/private-models/complete"}, {}) is None
    event = {"request": {"headers": {"X-Model-Api-Key": "fixture", "Authorization": "fixture", "Cookie": "fixture", "Accept": "application/json"}}}
    assert filter_monitoring_event(event, {})["request"]["headers"] == {"Accept": "application/json"}
