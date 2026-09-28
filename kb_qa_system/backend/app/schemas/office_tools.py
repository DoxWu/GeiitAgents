"""Bounded, ordered text/function messages. Credentials never belong in JSON."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ToolName = Literal["inspect_csv", "render_chart", "create_document"]


class ToolFunction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ToolName
    arguments: str = Field(max_length=100000)


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")
    type: Literal["function"]
    function: ToolFunction


class ToolMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = Field(default=None, max_length=100000)
    tool_calls: list[ToolCall] | None = Field(default=None, max_length=4)
    tool_call_id: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{1,100}$")


class AccountToolCompletion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: list[ToolMessage] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def ordered_messages(self):
        if len(self.model_dump_json()) > 200000:
            raise ValueError("Context too large")
        seen, pending = set(), set()
        for message in self.messages:
            if message.role == "tool":
                if message.tool_call_id not in pending or message.content is None or message.tool_calls:
                    raise ValueError("Invalid tool result")
                pending.remove(message.tool_call_id)
            else:
                if pending or message.tool_call_id:
                    raise ValueError("Missing tool results")
                if message.role != "assistant" and (not message.content or message.tool_calls):
                    raise ValueError("Invalid text message")
                if message.role == "assistant":
                    if not message.tool_calls and not (message.content or "").strip():
                        raise ValueError("Empty assistant message")
                    for call in message.tool_calls or []:
                        if call.id in seen:
                            raise ValueError("Repeated tool call")
                        seen.add(call.id)
                        pending.add(call.id)
        if pending:
            raise ValueError("Missing tool results")
        return self


class PrivateToolCompletion(AccountToolCompletion):
    base_url: str = Field(min_length=8, max_length=2048)
    model: str = Field(min_length=1, max_length=200, pattern=r"^[^\r\n]+$")
    max_tokens: int | None = Field(default=None, ge=1, le=2147483647)
