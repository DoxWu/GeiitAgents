import base64
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from app.core.model_provider.schemas import ModelProviderConfig, ProviderEndpointConfig
from app.services import server_image_generation as image_generation


@pytest.mark.asyncio
async def test_server_image_fails_over_to_independently_configured_endpoint(monkeypatch):
    primary = ProviderEndpointConfig(
        name="primary",
        type="openai_images",
        model="image-main",
        api_key="main-key",
        api_base="https://image-main.example/v1",
        enabled=True,
    )
    fallback = ProviderEndpointConfig(
        name="fallback",
        type="openai_images",
        model="image-backup",
        api_key="backup-key",
        api_base="https://image-backup.example/v1",
        enabled=True,
    )
    config = ModelProviderConfig(providers={"image_generation": [primary, fallback]})
    monkeypatch.setattr(image_generation.ConfigLoader, "load", lambda: config)
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode("ascii")
    calls = []

    def handler(request):
        calls.append(request)
        assert json.loads(request.content)["size"] == "1536x864"
        if request.headers["Authorization"] == "Bearer main-key":
            return httpx.Response(503)
        assert request.headers["Authorization"] == "Bearer backup-key"
        body = json.loads(request.content)
        assert body["model"] == "image-backup"
        return httpx.Response(200, json={"data": [{"b64_json": png}]})

    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        image_generation.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(transport=transport, **kwargs),
    )

    result = await image_generation.generate_server_image("primary", "A test illustration", "1536x864")

    assert len(calls) == 2
    assert calls[0].url.host == "image-main.example"
    assert calls[1].url.host == "image-backup.example"
    assert result == {"data_url": f"data:image/png;base64,{png}", "model": "image-backup"}


@pytest.mark.parametrize("size", ["0x1024", "513x1024", "4112x1024", "01024x1024", "1024X1024"])
@pytest.mark.asyncio
async def test_invalid_dimensions_rejected_before_provider_lookup(size, monkeypatch):
    def unexpected_lookup():
        raise AssertionError("Invalid dimensions must not contact a provider")

    monkeypatch.setattr(image_generation.ConfigLoader, "load", unexpected_lookup)
    with pytest.raises(image_generation.ImageGenerationError):
        await image_generation.generate_server_image("primary", "synthetic", size)


@pytest.mark.asyncio
async def test_server_image_downloads_provider_result_url(monkeypatch):
    primary = ProviderEndpointConfig(
        name="primary",
        type="openai_images",
        model="image-main",
        api_key="main-key",
        api_base="https://image-main.example/v1",
        enabled=True,
    )
    config = ModelProviderConfig(providers={"image_generation": [primary]})
    monkeypatch.setattr(image_generation.ConfigLoader, "load", lambda: config)
    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(
            200, json={"data": [{"url": "https://images.example/signed-result"}]}
        )
    )
    monkeypatch.setattr(
        image_generation.httpx,
        "AsyncClient",
        lambda **kwargs: original_client(transport=transport, **kwargs),
    )
    downloaded = []
    data_url = "data:image/png;base64,iVBORw0KGgo="

    def download(url):
        downloaded.append(url)
        return data_url

    monkeypatch.setattr(image_generation, "_download_provider_image_url", download)

    result = await image_generation.generate_server_image("primary", "A test illustration")

    assert downloaded == ["https://images.example/signed-result"]
    assert result == {"data_url": data_url, "model": "image-main"}


@pytest.mark.asyncio
async def test_server_text_only_4k_uses_dashscope_native_route(monkeypatch):
    endpoint = ProviderEndpointConfig(
        name="primary", type="openai_images", model="qwen-image-3.0-pro", api_key="synthetic",
        api_base="https://dashscope.aliyuncs.com/compatible-mode/v1", enabled=True,
    )
    monkeypatch.setattr(image_generation.ConfigLoader, "load", lambda: ModelProviderConfig(providers={"image_generation": [endpoint]}))
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode("ascii")
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.path == "/api/v1/services/aigc/multimodal-generation/generation"
        body = json.loads(request.content)
        assert body["input"]["messages"][0]["content"] == [{"text": "synthetic 4K scene"}]
        assert body["parameters"]["size"] == "3840*2160"
        return httpx.Response(200, json={"data": [{"b64_json": png}]})

    original = httpx.AsyncClient
    monkeypatch.setattr(image_generation.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = await image_generation.generate_server_image("primary", "synthetic 4K scene", "3840x2160")
    assert result == {"data_url": f"data:image/png;base64,{png}", "model": endpoint.model}
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("embedded", [False, True])
async def test_server_image_accepts_provider_result_larger_than_upload_limit(monkeypatch, embedded):
    primary = ProviderEndpointConfig(name="primary", type="openai_images", model="image-main", api_key="main-key", api_base="https://image-main.example/v1", enabled=True)
    monkeypatch.setattr(image_generation.ConfigLoader, "load", lambda: ModelProviderConfig(providers={"image_generation": [primary]}))
    original = httpx.AsyncClient
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={"data": [{"b64_json": data_url.split(",", 1)[1]} if embedded else {"url": "https://images.example/result"}]}))
    monkeypatch.setattr(image_generation.httpx, "AsyncClient", lambda **kwargs: original(transport=transport, **kwargs))
    image = b"\x89PNG\r\n\x1a\n" + b"x" * 25_000_000
    data_url = "data:image/png;base64," + base64.b64encode(image).decode()
    monkeypatch.setattr(image_generation, "_image_data_url_from_provider_url", AsyncMock(return_value=data_url))
    result = await image_generation.generate_server_image("primary", "synthetic", "4096x4096")
    assert result == {"data_url": data_url, "model": "image-main"}


def test_provider_image_url_download_is_public_https_and_size_bounded(monkeypatch):
    class Response:
        status_code = 200
        headers = {"Content-Length": "8"}

        def __init__(self):
            self.closed = False

        def iter_content(self, chunk_size):
            assert chunk_size == 256 * 1024
            yield b"\x89PNG\r\n\x1a\n"

        def close(self):
            self.closed = True

    response = Response()
    calls = []

    def public_get(url, **kwargs):
        calls.append((url, kwargs))
        return response

    monkeypatch.setattr(image_generation, "public_get", public_get)

    result = image_generation._download_provider_image_url(
        "https://images.example/result?sig=synthetic"
    )

    assert result == "data:image/png;base64,iVBORw0KGgo="
    assert calls == [
        (
            "https://images.example/result?sig=synthetic",
            {
                "headers": {"Accept": "image/png,image/jpeg,image/webp"},
                "timeout": 10,
                "stream": True,
            },
        )
    ]
    assert response.closed


def test_provider_image_url_rejects_private_hosts_and_non_https(monkeypatch):
    for url in (
        "http://images.example/result",
        "https://127.0.0.1/result",
        "https://user:password@images.example/result",
        "https://images.example:8443/result",
        "https://images.example/result#fragment",
    ):
        with pytest.raises(image_generation.ImageGenerationError):
            image_generation._download_provider_image_url(url)


def test_provider_image_url_rejects_oversized_response_and_closes(monkeypatch):
    class Response:
        status_code = 200
        headers = {"Content-Length": str(image_generation.MAX_IMAGE_BYTES + 1)}
        closed = False

        def iter_content(self, chunk_size):
            raise AssertionError("oversized content must be rejected before reading")

        def close(self):
            self.closed = True

    response = Response()
    monkeypatch.setattr(image_generation, "public_get", lambda *_args, **_kwargs: response)

    with pytest.raises(image_generation.ImageGenerationError):
        image_generation._download_provider_image_url("https://images.example/large")

    assert response.closed


def test_provider_image_url_rejects_oversized_stream_without_content_length(monkeypatch):
    class Response:
        status_code = 200
        headers = {}

        def __init__(self):
            self.closed = False

        def iter_content(self, chunk_size):
            yield b"x" * (image_generation.MAX_IMAGE_BYTES + 1)

        def close(self):
            self.closed = True

    response = Response()
    monkeypatch.setattr(image_generation, "public_get", lambda *_args, **_kwargs: response)

    with pytest.raises(image_generation.ImageGenerationError):
        image_generation._download_provider_image_url("https://images.example/large")

    assert response.closed


def test_provider_image_url_obeys_total_download_deadline(monkeypatch):
    class Response:
        status_code = 200
        headers = {}

        def __init__(self):
            self.closed = False

        def iter_content(self, chunk_size):
            raise AssertionError("expired download must not read the response")

        def close(self):
            self.closed = True

    response = Response()
    monkeypatch.setattr(image_generation, "public_get", lambda *_args, **_kwargs: response)
    monkeypatch.setattr(image_generation, "MAX_IMAGE_DOWNLOAD_SECONDS", -1)

    with pytest.raises(image_generation.ImageGenerationError, match="超时"):
        image_generation._download_provider_image_url("https://images.example/slow")

    assert response.closed
