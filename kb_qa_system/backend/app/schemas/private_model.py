"""Ephemeral model requests. Credentials are deliberately absent from the body."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class PrivateMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=100000)


class PrivateModelList(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str = Field(min_length=8, max_length=2048)


class AccountCompletion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: list[PrivateMessage] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def limit_context(self):
        if sum(len(item.content) for item in self.messages) > 200000:
            raise ValueError("Context too large")
        return self


class PrivateCompletion(AccountCompletion):
    base_url: str = Field(min_length=8, max_length=2048)
    model: str = Field(min_length=1, max_length=200, pattern=r"^[^\r\n]+$")
    max_tokens: int | None = Field(default=None, ge=1, le=2147483647)
