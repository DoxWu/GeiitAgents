"""Server-configured, bounded OpenAI-compatible image generation."""

from __future__ import annotations

import asyncio
import json
from urllib.parse import urlsplit

import httpx
from app.core.image_request import image_target, image_request_options, image_result, image_error_message, validate_reference_images

from app.core.model_provider.config_loader import ConfigLoader
from app.core.provider_image import (
    MAX_IMAGE_BYTES,
    MAX_IMAGE_DOWNLOAD_SECONDS,
    download_provider_image_url,
)
from app.core.provider_image import (
    ProviderImageError as ImageGenerationError,
)
from app.core.provider_image import (
    image_data_url as _image_data_url,
)
from app.core.public_http import public_get
from app.schemas.image_generation import validate_image_size

MAX_RESPONSE_BYTES = 12 * 1024 * 1024


def configured_image_endpoints() -> list[dict[str, str]]:
    return [
        {"id": endpoint.name, "model": endpoint.model}
        for endpoint in ConfigLoader.load().providers.get("image_generation", [])
        if endpoint.enabled and endpoint.model and endpoint.api_key and endpoint.api_base
    ]


def _generation_url(base_url: str, resource: str = 'images/generations') -> str:
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
    return base_url.rstrip("/") + "/" + resource


def _download_provider_image_url(image_url: str) -> str:
    return download_provider_image_url(
        image_url,
        request_get=public_get,
        max_image_bytes=MAX_IMAGE_BYTES,
        max_download_seconds=MAX_IMAGE_DOWNLOAD_SECONDS,
    )


async def _image_data_url_from_provider_url(image_url: str) -> str:
    try:
        return await asyncio.to_thread(_download_provider_image_url, image_url)
    except ImageGenerationError:
        raise
    except Exception:
        raise ImageGenerationError("图片下载失败。") from None


async def generate_server_image(endpoint_id: str, prompt: str, size: str = "1024x1024", reference_images: list[str] | None = None) -> dict[str, str]:
    if len(prompt.strip()) == 0 or len(prompt) > 6000:
        raise ImageGenerationError("最终生图提示词需要1–6000个字符。")
    try:
        validate_image_size(size)
        reference_images = validate_reference_images([] if reference_images is None else reference_images)
    except ValueError:
        raise ImageGenerationError("图片尺寸或参考图片无效。") from None
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

    failure = '生图请求失败，请检查模型配置或稍后重试。'
    for endpoint in endpoints[start:]:
        try:
            base, resource, dashscope = image_target(endpoint.api_base, reference_images)
            url = _generation_url(base, resource)
            options = image_request_options(endpoint.model, prompt.strip(), size, reference_images, dashscope)
            timeout = httpx.Timeout(60.0, connect=5.0)
            async with httpx.AsyncClient(
                timeout=timeout, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream(
                    "POST",
                    url,
                    headers={"Authorization": f"Bearer {endpoint.api_key}"},
                    **options,
                ) as response:
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise ImageGenerationError("图片服务响应超出大小限制。")
            try:
                payload = json.loads(body)
            except ValueError:
                payload = {}
            if response.status_code < 200 or response.status_code >= 300:
                failure = image_error_message(response.status_code, payload, bool(reference_images))
                continue
            data = image_result(payload)
            encoded = data.get("b64_json")
            if isinstance(encoded, str):
                try:
                    data_url = _image_data_url(encoded, max_image_bytes=MAX_IMAGE_BYTES)
                except ImageGenerationError as exc:
                    failure = str(exc)
                    continue
            elif isinstance(data.get("url"), str):
                try:
                    data_url = await _image_data_url_from_provider_url(data["url"])
                except ImageGenerationError as exc:
                    failure = str(exc)
                    continue
            else:
                continue
            return {"data_url": data_url, "model": endpoint.model}
        except ImageGenerationError as exc:
            failure = str(exc)
            continue
        except Exception:
            continue
    raise ImageGenerationError(failure)
