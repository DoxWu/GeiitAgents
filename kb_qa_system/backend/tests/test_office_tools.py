import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from pydantic import ValidationError

from app.schemas.office_tools import AccountToolCompletion, PrivateToolCompletion
from app.services.office_tools import complete_account_tools, complete_private_tools, normalize_reply
from app.services.private_model import PrivateModelError


def call(name="inspect_csv"):
    return {"id": "call1", "type": "function", "function": {"name": name, "arguments": "{}"}}


def request(**changes):
    return PrivateToolCompletion(base_url="https://models.example/v1", model="fixture", messages=[{"role": "user", "content": "goal"}], **changes)


def transport(handler):
    original = httpx.AsyncClient
    def client(**kwargs):
        assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
        return original(transport=httpx.MockTransport(handler), **kwargs)
    return patch("app.services.office_tools.httpx.AsyncClient", client)


@pytest.mark.parametrize("limit", [None, 1000])
def test_relay_uses_fixed_tools_and_header_key_with_optional_limit(limit):
    async def run():
        def provider(req):
            import json
            data = json.loads(req.content)
            assert req.headers["authorization"] == "Bearer fixture-key"
            assert req.headers["host"] == "models.example"
            assert req.extensions["sni_hostname"] == "models.example"
            assert [tool["function"]["name"] for tool in data["tools"]] == ["inspect_csv", "render_chart", "create_document"]
            render_chart = data["tools"][1]["function"]["parameters"]["properties"]
            assert "scatter" in render_chart["chart_type"]["enum"]
            assert "numeric X column" in render_chart["category_column"]["description"]
            assert "api_key" not in data
            if limit is None:
                assert "max_tokens" not in data
            else:
                assert data["max_tokens"] == limit
            return httpx.Response(200, json={"choices": [{"message": {"content": None, "tool_calls": [call()], "debug": "fixture-secret"}}]})
        with patch("app.services.office_tools.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), transport(provider):
            result = await complete_private_tools(request(max_tokens=limit), "fixture-key")
        assert result == {"content": None, "tool_calls": [call()], "model": "fixture"}
    asyncio.run(run())


def test_relay_advertises_search_tool_only_when_authorized():
    async def run():
        def provider(req):
            import json
            data = json.loads(req.content)
            assert [tool["function"]["name"] for tool in data["tools"]] == ["inspect_csv", "render_chart", "create_document", "search_wikipedia"]
            return httpx.Response(200, json={"choices": [{"message": {"content": "done", "tool_calls": []}}]})
        body = request(allow_web_search=True)
        with patch("app.services.office_tools.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), transport(provider):
            await complete_private_tools(body, "fixture-key")
    asyncio.run(run())


@pytest.mark.parametrize("status", [307, 401, 403, 429, 500])
def test_provider_errors_are_sanitized_and_not_followed(status):
    async def run():
        seen = []
        def provider(req):
            seen.append(req)
            return httpx.Response(status, text="fixture-secret", headers={"location": "https://elsewhere.example"})
        with patch("app.services.office_tools.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), transport(provider):
            with pytest.raises(PrivateModelError) as error:
                await complete_private_tools(request(), "fixture-key")
        assert "fixture-secret" not in str(error.value) and len(seen) == 1
    asyncio.run(run())


def test_messages_require_ordered_results_unique_calls_and_no_body_key():
    with pytest.raises(ValidationError):
        request(api_key="fixture-key")
    model = {"role": "assistant", "content": None, "tool_calls": [call()]}
    for messages in [[model], [{"role": "tool", "content": "{}", "tool_call_id": "unknown"}], [model, {"role": "user", "content": "missing"}]]:
        with pytest.raises(ValidationError):
            AccountToolCompletion(messages=messages)
    valid = [model, {"role": "tool", "content": "{}", "tool_call_id": "call1"}]
    assert len(AccountToolCompletion(messages=valid).messages) == 2
    with pytest.raises(ValidationError):
        AccountToolCompletion(messages=[*valid, model, valid[-1]])


def test_search_tool_is_exposed_only_with_strict_user_authorization():
    search = {"id": "search1", "type": "function", "function": {"name": "search_wikipedia", "arguments": '{"query":"test"}'}}
    history = [{"role": "assistant", "content": None, "tool_calls": [search]}, {"role": "tool", "content": '{"ok":true}', "tool_call_id": "search1"}]
    with pytest.raises(ValidationError):
        AccountToolCompletion(messages=history)
    with pytest.raises(ValidationError):
        AccountToolCompletion(messages=[{"role": "user", "content": "goal"}], allow_web_search="true")
    request = AccountToolCompletion(messages=history, allow_web_search=True)
    assert request.allow_web_search is True


@pytest.mark.parametrize("message", [{"tool_calls": [call("shell")]}, {"tool_calls": [call(), call()]}, {"content": ""}, {"content": ["image"]}, {"content": "done", "tool_calls": False}])
def test_unknown_tools_and_malformed_replies_never_escape(message):
    with pytest.raises(PrivateModelError):
        normalize_reply(message)


def test_response_call_metadata_is_stripped_but_request_fields_remain_strict():
    raw = {**call(), "index": 0, "provider_metadata": "fixture-secret", "function": {**call()["function"], "metadata": "fixture-secret"}}
    assert normalize_reply({"content": None, "tool_calls": [raw]}) == {"content": None, "tool_calls": [call()]}
    with pytest.raises(ValidationError):
        AccountToolCompletion(messages=[{"role": "assistant", "tool_calls": [raw]}, {"role": "tool", "tool_call_id": "call1", "content": "{}"}])


def test_account_tools_use_existing_client_without_accepting_client_side_model_or_key():
    async def run():
        provider = SimpleNamespace(config=SimpleNamespace(model="account-model", api_key="fixture-secret"), acomplete_tools=AsyncMock(return_value=SimpleNamespace(content="", additional_kwargs={"tool_calls": [call()]}, invalid_tool_calls=[])))
        with patch("app.services.account_model.select_account_client", return_value=provider):
            result = await complete_account_tools(AccountToolCompletion(messages=[{"role": "user", "content": "goal"}]))
        assert result == {"content": "", "tool_calls": [call()], "model": "account-model"}
        assert len(provider.acomplete_tools.await_args.args[1]) == 3
        with pytest.raises(ValidationError):
            AccountToolCompletion(messages=[{"role": "user", "content": "goal"}], model="arbitrary")
    asyncio.run(run())


def test_unsupported_account_provider_is_explicit_and_sanitized():
    async def run():
        with patch("app.services.account_model.select_account_client", return_value=SimpleNamespace()):
            with pytest.raises(PrivateModelError) as error:
                await complete_account_tools(AccountToolCompletion(messages=[{"role": "user", "content": "goal"}]))
        assert "暂不支持" in str(error.value)
    asyncio.run(run())


@pytest.mark.parametrize("content", [b"not json fixture-secret", b"x" * (2 * 1024 * 1024 + 1)], ids=["malformed", "oversized"])
def test_bad_response_is_bounded_and_sanitized(content):
    async def run():
        with patch("app.services.office_tools.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), transport(lambda _: httpx.Response(200, content=content)):
            with pytest.raises(PrivateModelError) as error:
                await complete_private_tools(request(), "fixture-key")
        assert "fixture-secret" not in str(error.value)
    asyncio.run(run())


def test_private_address_rejected_before_http_and_cancellation_propagates():
    async def run():
        with patch("app.services.office_tools.httpx.AsyncClient") as client:
            with pytest.raises(PrivateModelError):
                await complete_private_tools(PrivateToolCompletion(base_url="https://127.0.0.1/v1", model="fixture", messages=[{"role": "user", "content": "goal"}]), "fixture-key")
            client.assert_not_called()
        entered = asyncio.Event()
        async def pending(_):
            entered.set()
            await asyncio.Future()
        with patch("app.services.office_tools.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), transport(pending):
            task = asyncio.create_task(complete_private_tools(request(), "fixture-key"))
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
    asyncio.run(run())
