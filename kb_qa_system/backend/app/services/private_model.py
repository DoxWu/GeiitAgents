"""Request-scoped BYOK relay. No provider registry, cache, queue, or persistence."""

import asyncio
import base64
import binascii
import ipaddress
import json
import socket
from collections.abc import AsyncGenerator
from urllib.parse import urlsplit

import httpx

from app.core.model_text_stream import read_text_response
from app.core.provider_image import ProviderImageError as ImageGenerationError
from app.core.provider_image import image_data_url_from_provider_url
from app.schemas.private_model import PrivateCompletion, PrivateImageGeneration, PrivateModelList


class PrivateModelError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


async def public_endpoint(base_url: str, resource: str = "chat/completions") -> tuple[str, str, str]:
    """Resolve once, pin the public IP, and retain the hostname for TLS/Host."""
    try:
        parsed = urlsplit(base_url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.port not in (None, 443)
            or any(ord(c) < 33 for c in base_url)
        ):
            raise ValueError
        hostname = parsed.hostname.encode("idna").decode("ascii")
        addresses = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(hostname, 443, type=socket.SOCK_STREAM),
            timeout=5,
        )
        ips = [ipaddress.ip_address(item[4][0]) for item in addresses]
        if not ips or any(not ip.is_global or ip.is_multicast or ip.is_reserved for ip in ips):
            raise ValueError
        ip = ips[0]
        authority = f"[{ip}]" if ip.version == 6 else str(ip)
        if resource not in ("chat/completions", "models", "images/generations"):
            raise ValueError
        path = parsed.path.rstrip("/") + "/" + resource
        return f"https://{authority}{path}", hostname, hostname
    except (TimeoutError, ValueError, UnicodeError, OSError):
        raise PrivateModelError(400, "仅支持 HTTPS 公网模型地址（443 端口），本机模型请使用本机直连。") from None


async def complete_private(request: PrivateCompletion, api_key: str) -> dict:
    _validate_api_key(api_key)
    url, host, tls_name = await public_endpoint(request.base_url)
    body = {
        "model": request.model,
        "messages": [message.model_dump() for message in request.messages],
        "stream": False,
    }
    if request.max_tokens is not None:
        body["max_tokens"] = request.max_tokens
    try:
        async with asyncio.timeout(120):
            async with httpx.AsyncClient(
                follow_redirects=False, trust_env=False, timeout=httpx.Timeout(90, connect=10),
            ) as client:
                async with client.stream(
                    "POST", url, headers={"Authorization": f"Bearer {api_key}", "Host": host},
                    json=body, extensions={"sni_hostname": tls_name},
                ) as response:
                    if response.status_code != 200:
                        # Never forward provider bodies: they may echo credentials or prompts.
                        code = response.status_code
                        if code in (401, 403):
                            raise PrivateModelError(502, "模型服务拒绝认证，请检查 API Key 和模型权限。")
                        if code == 429:
                            raise PrivateModelError(429, "模型服务额度或速率已达上限。")
                        raise PrivateModelError(502, "模型服务请求失败，请检查接口地址和模型名称。")
                    chunks = bytearray()
                    async for chunk in response.aiter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > 2 * 1024 * 1024:
                            raise PrivateModelError(502, "模型响应超过大小限制。")
                    data = json.loads(chunks)
                    content = data["choices"][0]["message"]["content"]
                    if not isinstance(content, str) or not content.strip():
                        raise ValueError
                    return {"content": content, "model": request.model}
    except PrivateModelError:
        raise
    except Exception:
        # Unexpected provider/transport errors must not reach traceback exporters.
        raise PrivateModelError(502, "模型连接超时或返回格式无效。") from None


def _validate_api_key(api_key: str) -> None:
    if not api_key or len(api_key) > 4096 or not api_key.isascii() or any(ord(c) < 33 for c in api_key):
        raise PrivateModelError(400, "API Key 格式无效。")


async def generate_private_image(request: PrivateImageGeneration, api_key: str) -> dict:
    """Return one bounded image, downloading temporary public provider URLs when needed."""
    _validate_api_key(api_key)
    url, host, tls_name = await public_endpoint(request.base_url, "images/generations")
    body = {"model": request.model, "prompt": request.prompt, "n": 1, "size": request.size, "response_format": "b64_json"}
    try:
        async with asyncio.timeout(120):
            async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=httpx.Timeout(90, connect=10)) as client:
                async with client.stream("POST", url, headers={"Authorization": f"Bearer {api_key}", "Host": host},
                                         json=body, extensions={"sni_hostname": tls_name}) as response:
                    if response.status_code != 200:
                        code = response.status_code
                        if code in (401, 403):
                            raise PrivateModelError(502, "图像服务拒绝认证，请检查 API Key 和模型权限。")
                        if code == 429:
                            raise PrivateModelError(429, "图像服务额度或速率已达上限。")
                        raise PrivateModelError(502, "图像服务请求失败，请检查接口地址和生图模型名称。")
                    chunks = bytearray()
                    async for chunk in response.aiter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > 3 * 1024 * 1024:
                            raise PrivateModelError(502, "图像服务响应超过大小限制。")
                    data = json.loads(chunks)
                    images = data.get("data") if isinstance(data, dict) else None
                    if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
                        raise ValueError
                    encoded = images[0].get("b64_json")
                    if encoded is None and isinstance(images[0].get("url"), str):
                        data_url = await image_data_url_from_provider_url(images[0]["url"])
                        encoded = data_url.split(",", 1)[1]
                    raw = base64.b64decode(encoded, validate=True)
                    if len(raw) > 1_500_000:
                        raise PrivateModelError(413, "生成图片超过本机附件的 1.5 MiB 限制。")
                    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
                        mime = "image/png"
                    elif raw.startswith(b"\xff\xd8\xff"):
                        mime = "image/jpeg"
                    elif len(raw) >= 12 and raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
                        mime = "image/webp"
                    else:
                        raise ValueError
                    return {"data_url": f"data:{mime};base64,{encoded}"}
    except PrivateModelError:
        raise
    except ImageGenerationError:
        raise PrivateModelError(502, "图像服务返回的图片地址无法安全下载或图片格式不受支持。") from None
    except (KeyError, IndexError, TypeError, ValueError, binascii.Error, json.JSONDecodeError):
        raise PrivateModelError(502, "图像服务未返回有效的内嵌 PNG、JPEG 或 WebP 图片。") from None
    except Exception:
        raise PrivateModelError(502, "图像生成请求超时或返回格式无效。") from None


def normalize_model_list(data: object) -> dict:
    """Only IDs cross the relay. Listing does not attest model capabilities."""
    if not isinstance(data, dict) or not isinstance(data.get("data"), list):
        raise PrivateModelError(502, "模型列表格式无效，可继续手填模型名称。")
    models = []
    seen = set()
    truncated = data.get("has_more") is True
    for item in data["data"]:
        model = item.get("id") if isinstance(item, dict) else None
        if (not isinstance(model, str) or not model.strip() or model != model.strip()
                or len(model) > 200 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in model)):
            truncated = True
            continue
        if model in seen:
            continue
        seen.add(model)
        if len(models) < 500:
            models.append({"id": model})
        else:
            truncated = True
    return {"models": models, "truncated": truncated}


async def list_private_models(request: PrivateModelList, api_key: str) -> dict:
    _validate_api_key(api_key)
    url, host, tls_name = await public_endpoint(request.base_url, "models")
    try:
        async with asyncio.timeout(20):
            async with httpx.AsyncClient(
                follow_redirects=False, trust_env=False, timeout=httpx.Timeout(15, connect=5),
            ) as client:
                async with client.stream(
                    "GET", url, headers={"Authorization": f"Bearer {api_key}", "Host": host},
                    extensions={"sni_hostname": tls_name},
                ) as response:
                    if response.status_code in (401, 403):
                        raise PrivateModelError(502, "模型服务拒绝读取列表，请检查密钥权限；也可手填模型名称。")
                    if response.status_code == 429:
                        raise PrivateModelError(429, "模型服务额度或速率已达上限，请稍后重试。")
                    if response.status_code != 200:
                        raise PrivateModelError(502, "模型服务未提供可用列表，可继续手填模型名称。")
                    chunks = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(chunks) + len(chunk) > 1024 * 1024:
                            raise PrivateModelError(502, "模型列表超过大小限制，可继续手填模型名称。")
                        chunks.extend(chunk)
                    return normalize_model_list(json.loads(chunks))
    except PrivateModelError:
        raise
    except Exception:
        raise PrivateModelError(502, "获取模型列表超时或格式无效，可继续手填模型名称。") from None


async def stream_private(request: PrivateCompletion, api_key: str, completion=None) -> AsyncGenerator[str, None]:
    """Yield provider SSE text deltas without exposing the provider response body."""
    _validate_api_key(api_key)
    url, host, tls_name = await public_endpoint(request.base_url)
    body = {
        "model": request.model,
        "messages": [message.model_dump() for message in request.messages],
        "stream": True,
    }
    if request.max_tokens is not None:
        body["max_tokens"] = request.max_tokens
    try:
        async with asyncio.timeout(120):
            async with httpx.AsyncClient(
                follow_redirects=False, trust_env=False, timeout=httpx.Timeout(90, connect=10),
            ) as client:
                async with client.stream(
                    "POST", url, headers={"Authorization": f"Bearer {api_key}", "Host": host},
                    json=body, extensions={"sni_hostname": tls_name},
                ) as response:
                    if response.status_code != 200:
                        code = response.status_code
                        if code in (401, 403):
                            raise PrivateModelError(502, "模型服务拒绝认证，请检查 API Key 和模型权限。")
                        if code == 429:
                            raise PrivateModelError(429, "模型服务额度或速率已达上限。")
                        raise PrivateModelError(502, "模型服务请求失败，请检查接口地址和模型名称。")
                    async for delta in read_text_response(response, completion):
                        yield delta
    except PrivateModelError:
        raise
    except Exception:
        raise PrivateModelError(502, "模型连接超时或返回格式无效。") from None
