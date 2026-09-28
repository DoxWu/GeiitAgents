"""Catalog security and protocol boundaries; only synthetic provider fixtures."""
import asyncio
import socket
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.schemas.private_model import PrivateModelList
from app.services.private_model import PrivateModelError, list_private_models, normalize_model_list


def request():
    return PrivateModelList(base_url="https://models.example/v1/")


def transport(handler):
    original = httpx.AsyncClient

    def factory(**kwargs):
        assert kwargs["follow_redirects"] is False
        assert kwargs["trust_env"] is False
        return original(transport=httpx.MockTransport(handler), **kwargs)

    return patch("app.services.private_model.httpx.AsyncClient", factory)


def test_catalog_pins_public_ip_and_only_forwards_ids():
    async def run():
        seen = []

        def provider(req):
            seen.append(req)
            assert req.method == "GET"
            assert str(req.url) == "https://1.1.1.1/v1/models"
            assert req.content == b""
            assert req.headers["host"] == "models.example"
            assert req.extensions["sni_hostname"] == "models.example"
            assert req.headers["authorization"] == "Bearer fixture-key"
            return httpx.Response(200, json={"data": [{"id": "chat-1", "capabilities": ["vision"], "secret": "ignored"}]})

        dns = AsyncMock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))])
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", dns), transport(provider):
            assert await list_private_models(request(), "fixture-key") == {"models": [{"id": "chat-1"}], "truncated": False}
        dns.assert_awaited_once()
        assert len(seen) == 1
    asyncio.run(run())


@pytest.mark.parametrize("address", ["127.0.0.1", "169.254.169.254", "::1"])
def test_discovery_rejects_private_dns_without_sending_key(address):
    async def run():
        dns = AsyncMock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))])
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", dns), patch("app.services.private_model.httpx.AsyncClient") as client:
            with pytest.raises(PrivateModelError):
                await list_private_models(request(), "fixture-key")
            client.assert_not_called()
    asyncio.run(run())


@pytest.mark.parametrize("status", [301, 307, 401, 403, 404, 429, 500])
def test_no_redirect_or_provider_error_body_leaks(status):
    async def run():
        calls = []

        def provider(req):
            calls.append(req)
            return httpx.Response(status, text="fixture-secret echo", headers={"location": "https://elsewhere.example"})

        with patch("app.services.private_model.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/models", "models.example", "models.example"))), transport(provider):
            with pytest.raises(PrivateModelError) as error:
                await list_private_models(request(), "fixture-secret")
            assert "fixture-secret" not in str(error.value)
            assert error.value.status == (429 if status == 429 else 502)
            assert len(calls) == 1
    asyncio.run(run())


@pytest.mark.parametrize("body", [b"bad-json", b"x" * (1024 * 1024 + 1), b'{"data":{}}', b'[]'], ids=["bad-json", "oversized", "invalid-data", "invalid-root"])
def test_malformed_or_oversized_catalog_is_sanitized(body):
    async def run():
        with patch("app.services.private_model.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/models", "models.example", "models.example"))), transport(lambda req: httpx.Response(200, content=body)):
            with pytest.raises(PrivateModelError):
                await list_private_models(request(), "fixture-key")
    asyncio.run(run())


def test_ids_are_deduplicated_bounded_and_capabilities_unknown():
    data = {"data": [{"id": "valid"}, {"id": "valid"}, {"id": "x\n"}, {"id": "x" * 201}, None, {"id": ""}, {"id": " spaced "}, {"id": "bad\x7f"}]}
    assert normalize_model_list(data) == {"models": [{"id": "valid"}], "truncated": True}
    catalog = normalize_model_list({"data": [{"id": str(n)} for n in range(501)]})
    assert len(catalog["models"]) == 500 and catalog["truncated"]
    assert normalize_model_list({"data": [], "has_more": True}) == {"models": [], "truncated": True}
    assert normalize_model_list({"data": []}) == {"models": [], "truncated": False}


def test_cancellation_is_not_converted_to_a_provider_failure():
    async def run():
        async def provider(req):
            raise asyncio.CancelledError
        with patch("app.services.private_model.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/models", "models.example", "models.example"))), transport(provider):
            with pytest.raises(asyncio.CancelledError):
                await list_private_models(request(), "fixture-key")
    asyncio.run(run())
