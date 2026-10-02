"""Ephemeral model requests. Credentials are deliberately absent from the body."""

import base64
import binascii
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class PrivateMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["system", "user", "assistant"]
    content: str | list[dict] = Field(min_length=1, max_length=100000)

    @model_validator(mode="after")
    def validate_content(self):
        if isinstance(self.content, str):
            return self
        if len(self.content) > 4 or not self.content or self.content[0].get("type") != "text":
            raise ValueError("Invalid multimodal message")
        images = 0
        for part in self.content:
            if part.get("type") == "text":
                if set(part) != {"type", "text"} or not isinstance(part["text"], str) or len(part["text"]) > 100000:
                    raise ValueError("Invalid text part")
            elif part.get("type") == "image_url":
                images += 1
                image_url = part.get("image_url")
                if set(part) != {"type", "image_url"} or not isinstance(image_url, dict) or set(image_url) != {"url"}:
                    raise ValueError("Invalid image part")
                url = image_url.get("url")
                if not isinstance(url, str) or len(url) > 2_100_000:
                    raise ValueError("Invalid image data")
                try:
                    header, encoded = url.split(",", 1)
                    mime = header.removeprefix("data:").removesuffix(";base64")
                    if header != f"data:{mime};base64" or mime not in {"image/png", "image/jpeg", "image/webp"}:
                        raise ValueError("Invalid image type")
                    data = base64.b64decode(encoded, validate=True)
                except (ValueError, binascii.Error):
                    raise ValueError("Invalid image encoding") from None
                if not data or len(data) > 1_500_000 or not _image_signature(mime, data):
                    raise ValueError("Invalid image content")
            else:
                raise ValueError("Invalid content part")
        if images > 3:
            raise ValueError("Too many images")
        return self


def _image_signature(mime: str, data: bytes) -> bool:
    return (
        mime == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n")
        or mime == "image/jpeg" and data.startswith(b"\xff\xd8\xff")
        or mime == "image/webp" and len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    )


class PrivateModelList(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str = Field(min_length=8, max_length=2048)


class AccountCompletion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: list[PrivateMessage] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def limit_context(self):
        if sum(len(item.content) if isinstance(item.content, str) else sum(len(part.get("text", "")) for part in item.content) for item in self.messages) > 200000:
            raise ValueError("Context too large")
        return self


class PrivateCompletion(AccountCompletion):
    base_url: str = Field(min_length=8, max_length=2048)
    model: str = Field(min_length=1, max_length=200, pattern=r"^[^\r\n]+$")
    max_tokens: int | None = Field(default=None, ge=1, le=2147483647)
