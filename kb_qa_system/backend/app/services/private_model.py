"""Request-scoped BYOK relay. No provider registry, cache, queue, or persistence."""

import asyncio
import ipaddress
import json
import socket
from collections.abc import AsyncGenerator
from urllib.parse import urlsplit

import httpx

from app.schemas.private_model import PrivateCompletion


class PrivateModelError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


async def public_endpoint(base_url: str) -> tuple[str, str, str]:
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
        path = parsed.path.rstrip("/") + "/chat/completions"
        return f"https://{authority}{path}", hostname, hostname
    except (ValueError, UnicodeError, OSError, asyncio.TimeoutError):
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


async def stream_private(request: PrivateCompletion, api_key: str) -> AsyncGenerator[str, None]:
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
    total = 0
    emitted = False
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
                    async for line in response.aiter_lines():
                        total += len(line.encode("utf-8"))
                        if total > 2 * 1024 * 1024:
                            raise PrivateModelError(502, "模型响应超过大小限制。")
                        if not line.startswith("data:"):
                            continue
                        value = line[5:].strip()
                        if not value or value == "[DONE]":
                            continue
                        try:
                            delta = json.loads(value).get("choices", [{}])[0].get("delta", {}).get("content")
                        except (IndexError, TypeError, ValueError, AttributeError):
                            raise PrivateModelError(502, "模型连接超时或返回格式无效。") from None
                        if isinstance(delta, str) and delta:
                            emitted = True
                            yield delta
        if not emitted:
            raise PrivateModelError(502, "模型连接超时或返回格式无效。")
    except PrivateModelError:
        raise
    except Exception:
        raise PrivateModelError(502, "模型连接超时或返回格式无效。") from None
