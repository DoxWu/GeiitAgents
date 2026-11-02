"""Validate and download temporary public image URLs returned by model providers."""

from __future__ import annotations

import asyncio
import base64
import binascii
import time
from urllib.parse import urlsplit

from app.core.public_http import public_get

MAX_IMAGE_BYTES = 1_500_000
MAX_IMAGE_DOWNLOAD_SECONDS = 15


class ProviderImageError(Exception):
    pass


def image_data_url(encoded: str) -> str:
    try:
        image = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ProviderImageError("图片服务返回无效内容。") from None
    if not image or len(image) > MAX_IMAGE_BYTES:
        raise ProviderImageError("图片服务返回的文件超出大小限制。")
    if image.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    elif image.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif len(image) >= 12 and image[:4] == b"RIFF" and image[8:12] == b"WEBP":
        mime = "image/webp"
    else:
        raise ProviderImageError("图片服务返回了不支持的格式。")
    return f"data:{mime};base64,{encoded}"


def download_provider_image_url(
    image_url: str,
    *,
    request_get=public_get,
    max_image_bytes: int = MAX_IMAGE_BYTES,
    max_download_seconds: int = MAX_IMAGE_DOWNLOAD_SECONDS,
) -> str:
    try:
        parsed = urlsplit(image_url)
        port = parsed.port
    except ValueError:
        raise ProviderImageError("图片服务返回了无效地址。") from None
    if (
        len(image_url) > 2048
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or port not in {None, 443}
        or parsed.fragment
    ):
        raise ProviderImageError("图片服务返回了无效地址。")

    try:
        deadline = time.monotonic() + max_download_seconds
        response = request_get(
            image_url,
            headers={"Accept": "image/png,image/jpeg,image/webp"},
            timeout=2,
            stream=True,
        )
    except Exception:
        raise ProviderImageError("图片下载失败。") from None
    try:
        if time.monotonic() > deadline:
            raise ProviderImageError("图片下载超时。")
        if response.status_code != 200:
            raise ProviderImageError("图片下载失败。")
        content_length = response.headers.get("Content-Length")
        if content_length:
            try:
                length = int(content_length)
                if length < 1 or length > max_image_bytes:
                    raise ProviderImageError("图片服务返回的文件超出大小限制。")
            except ValueError:
                raise ProviderImageError("图片服务返回了无效文件大小。") from None

        image = bytearray()
        for chunk in response.iter_content(chunk_size=256 * 1024):
            if time.monotonic() > deadline:
                raise ProviderImageError("图片下载超时。")
            if not chunk:
                continue
            image.extend(chunk)
            if len(image) > max_image_bytes:
                raise ProviderImageError("图片服务返回的文件超出大小限制。")
    finally:
        response.close()

    encoded = base64.b64encode(image).decode("ascii")
    return image_data_url(encoded)


async def image_data_url_from_provider_url(image_url: str) -> str:
    try:
        return await asyncio.to_thread(download_provider_image_url, image_url)
    except ProviderImageError:
        raise
    except Exception:
        raise ProviderImageError("图片下载失败。") from None
