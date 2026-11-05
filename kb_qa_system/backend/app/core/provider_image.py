"""Validate and download temporary public image URLs returned by model providers."""

from __future__ import annotations

import asyncio
import base64
import binascii
import re
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

from app.core.public_http import public_get

MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_RESPONSE_BYTES = 88 * 1024 * 1024
MAX_REFERENCE_IMAGE_BYTES = 1_500_000
MAX_IMAGE_DOWNLOAD_SECONDS = 60


class ProviderImageError(Exception):
    pass


def validate_static_svg(image: bytes) -> None:
    try:
        xml = image.decode("utf-8-sig")
        if re.search(r"<!DOCTYPE|<!ENTITY|<\?(?!xml\s)", xml, re.I):
            raise ValueError()
        root = ET.fromstring(xml)
        namespace = "{http://www.w3.org/2000/svg}"
        if root.tag != namespace + "svg":
            raise ValueError()
        allowed = set(
            "svg a switch view g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc metadata clipPath mask pattern marker linearGradient radialGradient stop filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence style".split()
        )

        def safe_css(value: str) -> bool:
            value = re.sub(r"/\*[\s\S]*?\*/", "", value)
            value = re.sub(
                r"\\([0-9a-f]{1,6}\s?|[^0-9a-f\r\n])",
                lambda match: (
                    chr(min(int(match[1].strip(), 16), 0x10FFFF))
                    if re.match(r"[0-9a-f]", match[1], re.I)
                    else match[1]
                ),
                value,
                flags=re.I,
            )
            return not re.search(
                r"\\|/\*|@(?:import|font-face|(?:-webkit-)?keyframes)\b|(?:expression|image|(?:-webkit-)?image-set)\s*\(|(?:javascript|vbscript)\s*:|-moz-binding|behavior\s*:",
                value,
                re.I,
            ) and all(
                re.fullmatch(r'\s*[\'"]?#[\w:.-]+[\'"]?\s*', target)
                for target in re.findall(r"url\s*\(([^)]*)\)", value, re.I)
            )

        for node in root.iter():
            if node.tag.removeprefix(namespace) not in allowed or not node.tag.startswith(
                namespace
            ):
                raise ValueError()
            if node.tag == namespace + "style" and not safe_css(node.text or ""):
                raise ValueError()
            for name, value in node.attrib.items():
                local = name.rsplit("}", 1)[-1]
                if (
                    local.lower().startswith("on")
                    or local == "base"
                    or local == "href"
                    and not re.fullmatch(r"#[\w:.-]+", value)
                    or not safe_css(value)
                ):
                    raise ValueError()
    except (UnicodeError, ValueError, ET.ParseError):
        raise ProviderImageError("SVG包含无效XML或不支持的活动内容。") from None


def _size_error(max_image_bytes: int) -> ProviderImageError:
    if max_image_bytes == MAX_IMAGE_BYTES:
        return ProviderImageError("模型生成图片超过64 MiB接收上限，请降低输出尺寸后重试。")
    return ProviderImageError(f"图片超过{max_image_bytes:,}字节限制。")


def image_data_url(encoded: str, *, max_image_bytes: int = MAX_IMAGE_BYTES) -> str:
    if len(encoded) > ((max_image_bytes + 2) // 3) * 4:
        raise _size_error(max_image_bytes)
    try:
        image = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ProviderImageError("图片服务返回无效内容。") from None
    if not image:
        raise ProviderImageError("图片服务返回无效内容。")
    if len(image) > max_image_bytes:
        raise _size_error(max_image_bytes)
    if image.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    elif image.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif len(image) >= 12 and image[:4] == b"RIFF" and image[8:12] == b"WEBP":
        mime = "image/webp"
    elif (
        len(image) >= 13
        and image[:6] in {b"GIF87a", b"GIF89a"}
        and any(image[6:8])
        and any(image[8:10])
    ):
        mime = "image/gif"
    elif image.lstrip(b"\xef\xbb\xbf \r\n\t").startswith((b"<svg", b"<?xml", b"<!--")):
        validate_static_svg(image)
        mime = "image/svg+xml"
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
            headers={"Accept": "image/png,image/jpeg,image/webp,image/gif,image/svg+xml"},
            timeout=10,
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
                if length > max_image_bytes:
                    raise _size_error(max_image_bytes)
                if length < 1:
                    raise ProviderImageError("图片服务返回了无效文件大小。")
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
                raise _size_error(max_image_bytes)
    finally:
        response.close()

    encoded = base64.b64encode(image).decode("ascii")
    return image_data_url(encoded, max_image_bytes=max_image_bytes)


async def image_data_url_from_provider_url(image_url: str) -> str:
    try:
        return await asyncio.to_thread(download_provider_image_url, image_url)
    except ProviderImageError:
        raise
    except Exception:
        raise ProviderImageError("图片下载失败。") from None
