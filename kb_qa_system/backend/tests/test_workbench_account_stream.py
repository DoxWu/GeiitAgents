"""Actual selected-provider strict transport without SDK/network or user data."""
import asyncio
import json
from types import SimpleNamespace
from contextlib import aclosing
from unittest.mock import Mock, patch

import httpx
import pytest

from app.services.account_model import stream_account
from app.services.private_model import PrivateModelError
from app.schemas.private_model import AccountCompletion


@pytest.mark.parametrize("mode", ["done", "length", "truncated", "cancel", "json"])
def test_selected_account_transport_proves_completion_and_closes(mode):
    from app.core.model_provider.clients.openai_text import OpenAITextClient

    class Wire(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            yield b'data: {"choices":[{"delta":{"content":"synthetic"}}]}\n\n'
            if mode == "done":
                yield b'data: [DONE]\n\n'
                raise AssertionError("read beyond completion")
            if mode == "length":
                yield b'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'

        async def aclose(self):
            self.closed = True

    async def run():
        selected = SimpleNamespace(config=SimpleNamespace(api_base="http://127.0.0.1:1234/v1", api_key="fixture-key", model="selected-model", temperature=0.25), breaker=Mock())
        selected.breaker.is_open.return_value = False
        selected.astream_workbench = lambda messages, completion: OpenAITextClient.astream_workbench(selected, messages, completion)
        wire, calls, original = Wire(), [], httpx.AsyncClient

        def handler(request):
            calls.append(json.loads(request.content))
            assert request.headers["authorization"] == "Bearer fixture-key"
            if mode == "json":
                return httpx.Response(200, json={"choices": [{"message": {"content": "synthetic"}, "finish_reason": "stop"}]})
            return httpx.Response(200, stream=wire, headers={"content-type": "text/event-stream"})

        with patch("app.services.account_model.select_account_client", return_value=selected), patch("app.core.model_provider.clients.openai_text.httpx.AsyncClient", side_effect=lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs)):
            metadata = {}
            request = AccountCompletion(messages=[{"role": "user", "content": "hi"}])
            async with aclosing(stream_account(request, metadata)) as stream:
                if mode == "cancel":
                    assert await anext(stream) == "synthetic"
                elif mode == "truncated":
                    with pytest.raises(PrivateModelError):
                        _ = [text async for text in stream]
                    assert metadata == {}
                else:
                    assert [text async for text in stream] == ["synthetic"]
                    assert metadata["finish_reason"] == {"done": "unknown", "length": "length", "json": "stop"}[mode]
            assert len(calls) == 1  # No SDK/transport retries or provider failover.
            assert calls[0] == {"model": "selected-model", "messages": [{"role": "user", "content": "hi"}], "stream": True, "temperature": 0.25}
            if mode != "json":
                assert wire.closed
    asyncio.run(run())
