import base64
import json

import httpx
import pytest
from pydantic import ValidationError

from app.core.image_request import image_request_options, validate_reference_images
from app.core.model_provider.schemas import ModelProviderConfig, ProviderEndpointConfig
from app.core.provider_image import ProviderImageError, image_data_url
from app.schemas.image_generation import ServerImageRequest
from app.schemas.private_model import PrivateImageGeneration
from app.services import private_model, server_image_generation

SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a"/></defs><rect fill="url(#a)" width="12" height="12"/></svg>'
GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")


def test_static_styles_remain_supported():
    content = b'<svg xmlns="http://www.w3.org/2000/svg"><style>/* vector theme */ @media screen {.a{fill:red}}</style><rect class="a" aria-label="help@example.test"/></svg>'
    assert image_data_url(base64.b64encode(content).decode()).startswith("data:image/svg+xml;")


@pytest.mark.parametrize(("content", "mime"), [(SVG, "image/svg+xml"), (GIF, "image/gif")])
def test_outputs_are_accepted_without_widening_reference_inputs(content, mime):
    data_url = image_data_url(base64.b64encode(content).decode())
    assert data_url.startswith(f"data:{mime};base64,")
    with pytest.raises(ValueError):
        validate_reference_images([data_url])


@pytest.mark.parametrize(
    "content",
    [
        b"<script/>",
        b"<foreignObject/>",
        b'<rect onload="x"/>',
        b'<use href="https://example.test/x"/>',
        b'<style>@import "https://example.test/x";</style>',
    ],
)
def test_svg_active_content_is_rejected(content):
    with pytest.raises(ProviderImageError):
        image_data_url(
            base64.b64encode(
                b'<svg xmlns="http://www.w3.org/2000/svg">' + content + b"</svg>"
            ).decode()
        )


def test_output_schema_and_documented_protocol():
    request = ServerImageRequest(
        endpoint_id="primary",
        consent=True,
        prompt="synthetic",
        size="auto",
        output_format="gif",
        frame_count=12,
        frame_duration_ms=100,
    )
    body = image_request_options(
        "gpt-image-2.6-flare",
        request.prompt,
        request.size,
        [],
        False,
        request.output_format,
        request.frame_count,
        request.frame_duration_ms,
    )["json"]
    assert body == {
        "model": "gpt-image-2.6-flare",
        "prompt": "synthetic",
        "n": 1,
        "size": "auto",
        "output_format": "gif",
        "frame_count": 12,
        "frame_duration_ms": 100,
    }
    for params in [
        {"frame_count": 9},
        {"output_format": "gif", "frame_count": 65},
        {"output_format": "svg", "frame_duration_ms": 100},
        {"size": "auto"},
    ]:
        with pytest.raises(ValidationError):
            ServerImageRequest(endpoint_id="primary", consent=True, prompt="synthetic", **params)
    with pytest.raises(ValueError):
        image_request_options(
            "gpt-image-2.6-flare", "edit", "1024x1024", ["reference"], False, "svg"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(("output_format", "content"), [("svg", SVG), ("gif", GIF)])
async def test_real_http_assembly_in_byok_and_server_paths(monkeypatch, output_format, content):
    endpoint = ProviderEndpointConfig(
        name="primary",
        type="openai_images",
        model="gpt-image-2.6-sunburst",
        api_key="synthetic",
        api_base="https://images.example/v1",
        enabled=True,
    )
    monkeypatch.setattr(
        server_image_generation.ConfigLoader,
        "load",
        lambda: ModelProviderConfig(providers={"image_generation": [endpoint]}),
    )

    async def public_endpoint(base, resource):
        return f"https://203.0.113.1/v1/{resource}", "images.example", "images.example"

    monkeypatch.setattr(private_model, "public_endpoint", public_endpoint)
    bodies = []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        assert body["output_format"] == output_format
        assert "response_format" not in body
        if output_format == "gif":
            assert (
                body["size"] == "auto"
                and body["frame_count"] == 9
                and body["frame_duration_ms"] == 200
            )
        else:
            assert "frame_count" not in body
        return httpx.Response(
            200, json={"data": [{"b64_json": base64.b64encode(content).decode()}]}
        )

    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs),
    )
    size = "auto" if output_format == "gif" else "1024x1024"
    result = await server_image_generation.generate_server_image(
        "primary", "synthetic", size, output_format=output_format
    )
    request = PrivateImageGeneration(
        base_url=endpoint.api_base,
        model=endpoint.model,
        prompt="synthetic",
        size=size,
        output_format=output_format,
    )
    byok = await private_model.generate_private_image(request, "synthetic")
    assert result["data_url"] == byok["data_url"]
    assert base64.b64decode(byok["data_url"].split(",")[1]) == content
    assert len(bodies) == 2
