"""Shared wire contract plus real httpx streaming/cancellation, synthetic only."""
import asyncio
import json
from pathlib import Path
from contextlib import aclosing
from unittest.mock import patch, AsyncMock

import httpx
import pytest

from app.core.model_text_stream import TextStream, read_text_response
from app.services.private_model import stream_private, PrivateModelError
from app.schemas.private_model import PrivateCompletion

CASES = json.loads((Path(__file__).parents[2] / "test_fixtures/model_text_stream.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_protocol_at_every_byte_split(case):
    wire = case["wire"].encode()
    for split in range(len(wire) + 1):
        parser = TextStream()
        try:
            content = "".join([*parser.feed(wire[:split]), *parser.feed(wire[split:]), *parser.finish()])
        except ValueError:
            assert "content" not in case
        else:
            assert content == case["content"]
            assert parser.reason == case["reason"]


def test_json_fallback_utf16_size_invalid_encoding_and_wire_budget():
    async def run():
        metadata = {}
        response = httpx.Response(200, json={"choices": [{"message": {"content": "正文"}, "finish_reason": "length"}]})
        assert [text async for text in read_text_response(response, metadata)] == ["正文"]
        assert metadata == {"finish_reason": "length"}
        for response in [httpx.Response(200, content=b"x" * (2 * 1024 * 1024 + 1)),
                         httpx.Response(200, content=b"data: \xff\n\n", headers={"content-type": "text/event-stream"}),
                         httpx.Response(200, json={"choices": [{"message": {"content": "x" * 1_000_001}}]})]:
            with pytest.raises(ValueError):
                _ = [text async for text in read_text_response(response)]
        with pytest.raises(ValueError):
            TextStream().text("🌏" * 500_001)
    asyncio.run(run())


def test_relay_closes_on_terminal_or_early_consumer_close_and_rejects_truncation():
    class Wire(httpx.AsyncByteStream):
        def __init__(self, terminal):
            self.closed = False
            self.terminal = terminal

        async def __aiter__(self):
            yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            if self.terminal:
                yield b'data: [DONE]\n\n'
                raise AssertionError("Must stop reading after terminal marker")

        async def aclose(self):
            self.closed = True

    async def run():
        original = httpx.AsyncClient
        request = PrivateCompletion(base_url="https://models.example/v1", model="fixture", messages=[{"role": "user", "content": "hi"}])
        for terminal, early in [(True, False), (True, True), (False, False)]:
            wire = Wire(terminal)
            transport = httpx.MockTransport(lambda _: httpx.Response(200, stream=wire, headers={"content-type": "text/event-stream"}))
            with patch("app.services.private_model.public_endpoint", AsyncMock(return_value=("https://1.1.1.1/v1/chat/completions", "models.example", "models.example"))), patch("app.services.private_model.httpx.AsyncClient", side_effect=lambda **kwargs: original(transport=transport, **kwargs)):
                metadata = {}
                async with aclosing(stream_private(request, "fixture-key", metadata)) as stream:
                    if early:
                        assert await anext(stream) == "partial"
                    elif terminal:
                        assert [text async for text in stream] == ["partial"]
                        assert metadata["finish_reason"] == "unknown"
                    else:
                        with pytest.raises(PrivateModelError):
                            _ = [text async for text in stream]
                        assert metadata == {}
            assert wire.closed
    asyncio.run(run())
