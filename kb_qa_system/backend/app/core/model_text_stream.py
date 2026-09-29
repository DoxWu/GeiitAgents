"""Bounded compatible text responses for workbench chat, independent of KB SSE."""
import json

MAX_BYTES = 2 * 1024 * 1024
MAX_TEXT = 1_000_000  # UTF-16 units, matching JS and Rust.


def finish_reason(value):
    return value if value in ("stop", "length", "content_filter", "tool_calls") else "unknown"


def first_choice(value):
    if not isinstance(value, dict) or value.get("error") is not None:
        raise ValueError("Invalid model response")
    choices = value.get("choices")
    if not isinstance(choices, list):
        raise ValueError("Invalid model choices")
    return next((choice for choice in choices if isinstance(choice, dict) and (
        type(choice.get("index")) is int and choice["index"] == 0
        or len(choices) == 1 and choice.get("index") is None)), None)


class TextStream:
    def __init__(self):
        self.line = bytearray()
        self.data = []
        self.after_cr = False
        self.first_line = True
        self.error_event = False
        self.done = False
        self.reason = "unknown"
        self.text_units = 0
        self.has_text = False

    def text(self, content):
        if not isinstance(content, str):
            raise ValueError("Unsupported model text")
        self.text_units += len(content.encode("utf-16-le")) // 2
        if self.text_units > MAX_TEXT:
            raise ValueError("Model text too large")
        self.has_text |= bool(content.strip())
        return content

    def event(self):
        if self.error_event:
            raise ValueError("Model stream failed")
        raw = "\n".join(self.data).strip()
        self.data.clear()
        if not raw:
            return None
        if raw == "[DONE]":
            self.done = True
            return None
        choice = first_choice(json.loads(raw))
        if choice is None:
            return None
        delta = choice.get("delta")
        if delta is None:
            delta = {}
        if not isinstance(delta, dict):
            raise ValueError("Invalid model delta")
        content = self.text(delta["content"]) if delta.get("content") is not None else None
        reason = choice.get("finish_reason")
        if isinstance(reason, str) and reason:
            self.reason = finish_reason(reason)
            self.done = True
        return content

    def consume_line(self):
        line = self.line.decode("utf-8")
        self.line.clear()
        if self.first_line:
            line = line.removeprefix("\ufeff")
            self.first_line = False
        if not line:
            result = self.event()
            self.error_event = False
            return result
        field, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if field == "data":
            self.data.append(value)
        elif field == "event":
            self.error_event = value == "error"
        return None

    def feed(self, chunk):
        for byte in chunk:
            if self.done:
                break
            if self.after_cr and byte == 10:
                self.after_cr = False
                continue
            self.after_cr = byte == 13
            if byte in (10, 13):
                text = self.consume_line()
                if text:
                    yield text
            else:
                self.line.append(byte)

    def finish(self):
        if not self.done and self.line:
            text = self.consume_line()
            if text:
                yield text
        if not self.done:
            text = self.event()
            if text:
                yield text
        if not self.done or not self.has_text:
            raise ValueError("Model stream ended before completion")


async def read_text_response(response, completion=None):
    """Yield deltas; successful EOF requires terminal proof or complete JSON."""
    sse = response.headers.get("content-type", "").split(";")[0].strip().lower() == "text/event-stream"
    parser, total, body = TextStream(), 0, bytearray()
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > MAX_BYTES:
            raise ValueError("Model response too large")
        if sse:
            for text in parser.feed(chunk):
                yield text
            if parser.done:
                break
        else:
            body.extend(chunk)
    if sse:
        for text in parser.finish():
            yield text
    else:
        choice = first_choice(json.loads(body.decode("utf-8-sig")))
        if not choice or not isinstance(choice.get("message"), dict):
            raise ValueError("Missing model answer")
        text = parser.text(choice["message"].get("content"))
        if not parser.has_text:
            raise ValueError("Empty model answer")
        parser.reason = finish_reason(choice.get("finish_reason"))
        yield text
    if completion is not None:
        completion["finish_reason"] = parser.reason
