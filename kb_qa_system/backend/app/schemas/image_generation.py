"""Bounded request schemas for the server-side image model."""
import re

from pydantic import BaseModel, ConfigDict, Field, field_validator


def validate_image_size(size: str) -> str:
    if not isinstance(size, str) or not re.fullmatch(r"[1-9][0-9]{2,3}x[1-9][0-9]{2,3}", size):
        raise ValueError("图片尺寸无效。")
    if any(n < 512 or n > 2048 or n % 16 for n in map(int, size.split("x"))):
        raise ValueError("图片宽高应为512–2048之间的16的倍数。")
    return size


class ImageGenerationOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=6000)
    size: str = "1024x1024"

    @field_validator("size")
    @classmethod
    def valid_size(cls, value: str) -> str:
        return validate_image_size(value)


class ServerImageRequest(ImageGenerationOptions):
    model_config = ConfigDict(extra="forbid")
    endpoint_id: str = Field(min_length=1, max_length=40)
    consent: bool


class ServerImageEndpoint(BaseModel):
    id: str
    model: str
