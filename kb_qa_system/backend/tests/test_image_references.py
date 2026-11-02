"""Reference bytes must reach the image provider, including every fallback."""
import base64
import asyncio
import json
import socket
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from app.core.image_request import IMAGE_EDIT_PATH, image_target
from app.core.model_provider.schemas import ModelProviderConfig, ProviderEndpointConfig
from app.schemas.private_model import PrivateImageGeneration
from app.services import private_model, server_image_generation

PNG = b'\x89PNG\r\n\x1a\n'
REFERENCE = 'data:image/png;base64,' + base64.b64encode(PNG).decode()


@pytest.mark.parametrize('references', [
    ['https://example.com/input.png'], [REFERENCE] * 3,
    [REFERENCE.replace('image/png', 'image/jpeg')],
    ['data:image/png;base64,' + base64.b64encode(PNG + b'x' * 1_500_000).decode()],
    ['data:image/png;base64,not base64'],
])
def test_invalid_references_are_rejected(references):
    with pytest.raises(ValidationError):
        PrivateImageGeneration(base_url='https://models.example/v1', model='edit', prompt='edit', reference_images=references)


def test_official_host_matching_does_not_rewrite_similar_hosts():
    for host in ['dashscope.aliyuncs.com.evil.example', 'other.aliyuncs.com', 'x.cn-beijing.maas.aliyuncs.com.evil.example']:
        base = f'https://{host}/v1'
        assert image_target(base, [REFERENCE]) == (base, 'images/edits', False)


@pytest.mark.asyncio
@pytest.mark.parametrize('dashscope,count', [(False, 1), (False, 2), (True, 2)])
async def test_byok_sends_image_bytes_with_pinned_host_and_tls(monkeypatch, dashscope, count):
    host = 'ws-fixture.cn-beijing.maas.aliyuncs.com' if dashscope else 'models.example'
    base = f'https://{host}/compatible-mode/v1'
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, 'getaddrinfo', AsyncMock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('1.1.1.1', 443))]))
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.host == '1.1.1.1'
        assert request.headers['Host'] == host
        assert request.extensions['sni_hostname'] == host
        assert request.headers['Authorization'] == 'Bearer synthetic'
        if dashscope:
            assert request.url.path == IMAGE_EDIT_PATH
            body = json.loads(request.content)
            assert body['input']['messages'][0]['content'] == [{'image': REFERENCE}] * count + [{'text': 'keep subject'}]
            assert body['parameters']['size'] == '1536*864'
            return httpx.Response(200, json={'output': {'choices': [{'message': {'content': [{'image': 'https://cdn.example/edited.png'}]}}]}})
        assert request.url.path.endswith('/images/edits')
        assert request.headers['Content-Type'].startswith('multipart/form-data; boundary=')
        assert request.content.count(PNG) == count
        assert b'name="image"' in request.content if count == 1 else b'name="image[]"' in request.content
        assert b'keep subject' in request.content and b'1536x864' in request.content
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(PNG).decode()}]})

    original = httpx.AsyncClient
    monkeypatch.setattr(private_model.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    download = AsyncMock(return_value=REFERENCE)
    monkeypatch.setattr(private_model, 'image_data_url_from_provider_url', download)
    result = await private_model.generate_private_image(PrivateImageGeneration(
        base_url=base, model='edit', prompt='keep subject', size='1536x864', reference_images=[REFERENCE] * count,
    ), 'synthetic')
    assert result['data_url'] == REFERENCE and len(calls) == 1
    assert download.await_count == (1 if dashscope else 0)


@pytest.mark.asyncio
async def test_server_fallback_keeps_references_when_protocol_changes(monkeypatch):
    endpoints = [ProviderEndpointConfig(name=name, model='edit', api_base=base, api_key='synthetic', type='openai_images', enabled=True)
                 for name, base in [('primary', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), ('fallback', 'https://models.example/v1')]]
    monkeypatch.setattr(server_image_generation.ConfigLoader, 'load', lambda: ModelProviderConfig(providers={'image_generation': endpoints}))
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            assert request.url.path == IMAGE_EDIT_PATH
            assert json.loads(request.content)['input']['messages'][0]['content'][0]['image'] == REFERENCE
            return httpx.Response(503)
        assert request.url.path == '/v1/images/edits' and PNG in request.content
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(PNG).decode()}]})

    original = httpx.AsyncClient
    monkeypatch.setattr(server_image_generation.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = await server_image_generation.generate_server_image('primary', 'edit', reference_images=[REFERENCE])
    assert result['data_url'] == REFERENCE and len(calls) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize('status,body,expected', [
    (403, {'code': 'AllocationQuota.FreeTierOnly', 'message': 'synthetic-secret-echo'}, '仅使用免费额度'),
    (404, {}, '支持图片编辑'),
])
async def test_edit_errors_are_safe_and_never_retry_without_references(monkeypatch, status, body, expected):
    endpoint = ProviderEndpointConfig(name='primary', model='edit', api_base='https://dashscope.aliyuncs.com/compatible-mode/v1', api_key='synthetic', type='openai_images', enabled=True)
    monkeypatch.setattr(server_image_generation.ConfigLoader, 'load', lambda: ModelProviderConfig(providers={'image_generation': [endpoint]}))
    monkeypatch.setattr(private_model, 'public_endpoint', AsyncMock(return_value=('https://1.1.1.1/v1/images/edits', 'models.example', 'models.example')))
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status, json=body)

    original = httpx.AsyncClient
    monkeypatch.setattr(private_model.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(private_model.PrivateModelError, match=expected) as error:
        await private_model.generate_private_image(PrivateImageGeneration(base_url='https://models.example/v1', model='edit', prompt='edit', reference_images=[REFERENCE]), 'synthetic')
    assert 'synthetic-secret-echo' not in str(error.value)
    with pytest.raises(server_image_generation.ImageGenerationError, match=expected):
        await server_image_generation.generate_server_image('primary', 'edit', reference_images=[REFERENCE])
    assert len(calls) == 2
