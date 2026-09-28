"""Ephemeral tool planning. Tool execution happens only in the user's client."""
import asyncio
import json

import httpx
from pydantic import ValidationError

from app.schemas.office_tools import AccountToolCompletion, PrivateToolCompletion, ToolMessage
from app.services.private_model import PrivateModelError, _validate_api_key, public_endpoint


def _object(properties):
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


OFFICE_TOOLS = [
    {"type": "function", "function": {"name": "inspect_csv", "description": "Read this task's user-provided CSV; no other files.", "parameters": _object({})}},
    {"type": "function", "function": {"name": "render_chart", "description": "Render an SVG from this task's original CSV. Column indices are zero-based.", "parameters": _object({
        "title": {"type": "string", "maxLength": 80}, "category_column": {"type": "integer", "minimum": 0, "maximum": 11},
        "value_columns": {"type": "array", "minItems": 1, "maxItems": 6, "items": {"type": "integer", "minimum": 0, "maximum": 11}},
        "chart_type": {"type": "string", "enum": ["bar", "line"]}, "unit": {"type": "string", "maxLength": 20},
    })}},
    {"type": "function", "function": {"name": "create_document", "description": "Create a local Markdown artifact. Mark missing facts; never edit external files.", "parameters": _object({
        "title": {"type": "string", "maxLength": 80}, "markdown": {"type": "string", "maxLength": 50000},
    })}},
]


def normalize_reply(message: object) -> dict:
    try:
        if not isinstance(message, dict):
            raise ValueError
        calls = message.get("tool_calls")
        if calls is None:
            calls = []
        if isinstance(calls, list):
            calls = [
                {"id": call.get("id"), "type": call.get("type"), "function": {
                    "name": call["function"].get("name"), "arguments": call["function"].get("arguments"),
                }} if isinstance(call, dict) and isinstance(call.get("function"), dict) else call
                for call in calls
            ]
        # Whitelist response fields; never return debug metadata or raw errors.
        parsed = ToolMessage.model_validate({"role": "assistant", "content": message.get("content"), "tool_calls": calls})
        if not parsed.tool_calls and not (parsed.content or "").strip():
            raise ValueError
        if len({call.id for call in parsed.tool_calls}) != len(parsed.tool_calls):
            raise ValueError
        return {"content": parsed.content, "tool_calls": [call.model_dump() for call in parsed.tool_calls]}
    except (ValidationError, ValueError, TypeError):
        raise PrivateModelError(502, "模型工具响应无效或包含未允许的工具。") from None


async def complete_private_tools(request: PrivateToolCompletion, api_key: str) -> dict:
    _validate_api_key(api_key)
    url, host, tls_name = await public_endpoint(request.base_url)
    body = {"model": request.model, "messages": [{**message.model_dump(exclude_none=True), "content": message.content} for message in request.messages],
            "tools": OFFICE_TOOLS, "tool_choice": "auto", "stream": False}
    if request.max_tokens is not None:
        body["max_tokens"] = request.max_tokens
    try:
        async with asyncio.timeout(120):
            async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=httpx.Timeout(90, connect=10)) as client:
                async with client.stream("POST", url, headers={"Authorization": f"Bearer {api_key}", "Host": host},
                                         extensions={"sni_hostname": tls_name}, json=body) as response:
                    if response.status_code == 429:
                        raise PrivateModelError(429, "模型服务额度或速率已达上限。")
                    if response.status_code != 200:
                        raise PrivateModelError(502, "模型工具请求失败，请检查模型权限及工具调用兼容性。")
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(content) + len(chunk) > 2 * 1024 * 1024:
                            raise PrivateModelError(502, "模型工具响应超过大小限制。")
                        content.extend(chunk)
                    message = json.loads(content)["choices"][0]["message"]
                    return {**normalize_reply(message), "model": request.model}
    except PrivateModelError:
        raise
    except Exception:
        raise PrivateModelError(502, "模型工具请求超时或返回格式无效。") from None


async def complete_account_tools(request: AccountToolCompletion) -> dict:
    from app.services.account_model import select_account_client
    try:
        async with asyncio.timeout(120):
            client = await asyncio.to_thread(select_account_client)
            if not callable(getattr(client, "acomplete_tools", None)):
                raise PrivateModelError(502, "当前账号模型暂不支持工具协议，请使用普通文档或图表任务。")
            # Tool-only assistant turns still require an explicit content key
            # for LangChain's OpenAI-dict conversion.
            messages = [{**message.model_dump(exclude_none=True), "content": message.content} for message in request.messages]
            result = await client.acomplete_tools(messages, OFFICE_TOOLS)
            if getattr(result, "invalid_tool_calls", None):
                raise ValueError
            raw = {"content": result.content, "tool_calls": result.additional_kwargs.get("tool_calls", [])}
            if len(json.dumps(raw)) > 2 * 1024 * 1024:
                raise ValueError
            return {**normalize_reply(raw), "model": client.config.model}
    except PrivateModelError:
        raise
    except Exception:
        raise PrivateModelError(502, "账号模型工具请求失败，请检查模型是否支持工具调用。") from None
