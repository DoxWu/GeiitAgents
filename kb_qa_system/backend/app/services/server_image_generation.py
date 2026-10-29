"""Server-configured, bounded OpenAI-compatible image generation."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import time
from urllib.parse import urlsplit

import httpx

from app.core.model_provider.config_loader import ConfigLoader
from app.core.public_http import public_get

MAX_RESPONSE_BYTES = 3 * 1024 * 1024
MAX_IMAGE_BYTES = 1_500_000
MAX_IMAGE_DOWNLOAD_SECONDS = 15


class ImageGenerationError(Exception):
    pass


def configured_image_endpoints() -> list[dict[str, str]]:
    return [
        {"id": endpoint.name, "model": endpoint.model}
        for endpoint in ConfigLoader.load().providers.get("image_generation", [])
        if endpoint.enabled and endpoint.model and endpoint.api_key and endpoint.api_base
    ]


def _image_data_url(encoded: str) -> str:
    try:
        image = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ImageGenerationError("图片服务返回无效内容。") from None
    if not image or len(image) > MAX_IMAGE_BYTES:
        raise ImageGenerationError("图片服务返回的文件超出大小限制。")
    if image.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    elif image.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif len(image) >= 12 and image[:4] == b"RIFF" and image[8:12] == b"WEBP":
        mime = "image/webp"
    else:
        raise ImageGenerationError("图片服务返回了不支持的格式。")
    return f"data:{mime};base64,{encoded}"


def _generation_url(base_url: str) -> str:
    parsed = urlsplit(base_url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 443}
        or parsed.query
        or parsed.fragment
    ):
        raise ImageGenerationError("生图 API 地址必须为有效 HTTPS 地址。")
    return base_url.rstrip("/") + "/images/generations"


def _download_provider_image_url(image_url: str) -> str:
    try:
        parsed = urlsplit(image_url)
        port = parsed.port
    except ValueError:
        raise ImageGenerationError("图片服务返回了无效地址。") from None
    if (
        len(image_url) > 2048
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or port not in {None, 443}
        or parsed.fragment
    ):
        raise ImageGenerationError("图片服务返回了无效地址。")

    try:
        deadline = time.monotonic() + MAX_IMAGE_DOWNLOAD_SECONDS
        response = public_get(
            image_url,
            headers={"Accept": "image/png,image/jpeg,image/webp"},
            timeout=2,
            stream=True,
        )
    except Exception:
        raise ImageGenerationError("图片下载失败。") from None
    try:
        if time.monotonic() > deadline:
            raise ImageGenerationError("图片下载超时。")
        if response.status_code != 200:
            raise ImageGenerationError("图片下载失败。")
        content_length = response.headers.get("Content-Length")
        if content_length:
            try:
                length = int(content_length)
                if length < 1 or length > MAX_IMAGE_BYTES:
                    raise ImageGenerationError("图片服务返回的文件超出大小限制。")
            except ValueError:
                raise ImageGenerationError("图片服务返回了无效文件大小。") from None

        image = bytearray()
        for chunk in response.iter_content(chunk_size=256 * 1024):
            if time.monotonic() > deadline:
                raise ImageGenerationError("图片下载超时。")
            if not chunk:
                continue
            image.extend(chunk)
            if len(image) > MAX_IMAGE_BYTES:
                raise ImageGenerationError("图片服务返回的文件超出大小限制。")
    finally:
        response.close()

    encoded = base64.b64encode(image).decode("ascii")
    return _image_data_url(encoded)


async def _image_data_url_from_provider_url(image_url: str) -> str:
    try:
        return await asyncio.to_thread(_download_provider_image_url, image_url)
    except ImageGenerationError:
        raise
    except Exception:
        raise ImageGenerationError("图片下载失败。") from None


async def generate_server_image(endpoint_id: str, prompt: str) -> dict[str, str]:
    if len(prompt.strip()) == 0 or len(prompt) > 1000:
        raise ImageGenerationError("图片描述需要 1–1000 个字符。")
    endpoints = [
        endpoint
        for endpoint in ConfigLoader.load().providers.get("image_generation", [])
        if endpoint.enabled and endpoint.model and endpoint.api_key and endpoint.api_base
    ]
    start = next(
        (index for index, endpoint in enumerate(endpoints) if endpoint.name == endpoint_id), None
    )
    if start is None:
        raise ImageGenerationError("所选服务端生图模型不可用。")

    for endpoint in endpoints[start:]:
        try:
            url = _generation_url(endpoint.api_base)
            timeout = httpx.Timeout(60.0, connect=5.0)
            async with httpx.AsyncClient(
                timeout=timeout, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream(
                    "POST",
                    url,
                    headers={"Authorization": f"Bearer {endpoint.api_key}"},
                    json={
                        "model": endpoint.model,
                        "prompt": prompt.strip(),
                        "n": 1,
                        "size": "1024x1024",
                        "response_format": "b64_json",
                    },
                ) as response:
                    if response.status_code < 200 or response.status_code >= 300:
                        continue
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise ImageGenerationError("图片服务响应超出大小限制。")
            payload = json.loads(body)
            data = payload.get("data")
            if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
                continue
            encoded = data[0].get("b64_json")
            if isinstance(encoded, str):
                try:
                    data_url = _image_data_url(encoded)
                except ImageGenerationError:
                    continue
            elif isinstance(data[0].get("url"), str):
                try:
                    data_url = await _image_data_url_from_provider_url(data[0]["url"])
                except ImageGenerationError:
                    continue
            else:
                continue
            return {"data_url": data_url, "model": endpoint.model}
        except ImageGenerationError:
            continue
        except Exception:
            continue
    raise ImageGenerationError("生图请求失败，请检查模型配置或稍后重试。")
