"""Real pinned ChatOpenAI serialization against HTTP fixtures, no real credentials."""
import asyncio
import json
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

import httpx
import pytest

langchain = pytest.importorskip("langchain_openai")
# The legacy model-provider suite injects MagicMock modules at collection time.
# This integration test must run separately with real optional dependencies.
if not isinstance(langchain, ModuleType):
    pytest.skip("Run separately with real LangChain dependencies, not legacy module mocks", allow_module_level=True)
from langchain_openai import ChatOpenAI
from app.core.model_provider.clients.openai_text import OpenAITextClient
from app.schemas.office_tools import AccountToolCompletion
from app.services.office_tools import complete_account_tools
from app.services.private_model import PrivateModelError


def test_account_client_serializes_real_tool_transcript_and_does_not_retry():
    async def run():
        seen = []
        call = {"id": "read1", "type": "function", "function": {"name": "inspect_csv", "arguments": "{}"}}
        def handler(request):
            body = json.loads(request.content)
            seen.append(body)
            assert body["tool_choice"] == "auto" and len(body["tools"]) == 3
            assert "max_tokens" not in body
            if len(seen) == 3:
                return httpx.Response(500, json={"error": {"message": "fixture-secret"}})
            message = {"role": "assistant", "content": None, "tool_calls": [call]} if len(seen) == 1 else {"role": "assistant", "content": "完成"}
            return httpx.Response(200, json={"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1, "model": "fixture",
                                           "choices": [{"index": 0, "finish_reason": "tool_calls" if len(seen) == 1 else "stop", "message": message}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as transport:
            llm = ChatOpenAI(model="fixture", api_key="fixture-key", base_url="https://fixture.example/v1", http_async_client=transport, max_retries=0)
            provider = OpenAITextClient.__new__(OpenAITextClient)
            provider.config = SimpleNamespace(model="fixture")
            provider._tools_llm = llm
            provider.breaker = Mock()
            provider.breaker.is_open.return_value = False
            messages = [{"role": "system", "content": "Use tools"}, {"role": "user", "content": "goal"}]
            with patch("app.services.account_model.select_account_client", return_value=provider):
                first = await complete_account_tools(AccountToolCompletion(messages=messages))
                assert first["tool_calls"] == [call]
                messages.extend([{"role": "assistant", "content": None, "tool_calls": first["tool_calls"]}, {"role": "tool", "tool_call_id": "read1", "content": '{"ok":true}'}])
                assert (await complete_account_tools(AccountToolCompletion(messages=messages)))["content"] == "完成"
                assert seen[1]["messages"][-1] == {"role": "tool", "tool_call_id": "read1", "content": '{"ok":true}'}
                with pytest.raises(PrivateModelError) as error:
                    await complete_account_tools(AccountToolCompletion(messages=messages))
                assert "fixture-secret" not in str(error.value)
            assert len(seen) == 3
            assert provider.breaker.record_success.call_count == 2
            assert provider.breaker.record_failure.call_count == 1
            assert llm.model_kwargs == {} and llm.max_retries == 0
    asyncio.run(run())
