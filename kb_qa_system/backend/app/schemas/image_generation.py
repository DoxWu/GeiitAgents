"""Bounded request schemas for the server-side image model."""

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.image_request import image_output_fields, validate_reference_images


def validate_image_size(size: str) -> str:
    if not isinstance(size, str) or not re.fullmatch(r"[1-9][0-9]{2,3}x[1-9][0-9]{2,3}", size):
        raise ValueError("图片尺寸无效。")
    if any(n < 512 or n > 4096 or n % 16 for n in map(int, size.split("x"))):
        raise ValueError("图片宽高应为512–4096之间的16的倍数。")
    return size


class ImageGenerationOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=6000)
    size: str = "1024x1024"
    reference_images: list[str] = Field(default_factory=list, max_length=2)
    output_format: Literal["svg", "gif"] | None = None
    frame_count: int | None = Field(default=None, strict=True, ge=2, le=64)
    frame_duration_ms: int | None = Field(default=None, strict=True, ge=20, le=2000)

    @model_validator(mode="after")
    def valid_output(self):
        image_output_fields(self.output_format, self.frame_count, self.frame_duration_ms)
        if self.output_format and self.reference_images:
            raise ValueError("SVG/GIF仅支持文字生成，不支持参考图编辑。")
        if self.size == "auto" and self.output_format != "gif":
            raise ValueError("自动帧尺寸仅适用于GIF。")
        return self

    @field_validator("reference_images")
    @classmethod
    def valid_references(cls, value: list[str]) -> list[str]:
        return validate_reference_images(value)

    @field_validator("size")
    @classmethod
    def valid_size(cls, value: str) -> str:
        return value if value == "auto" else validate_image_size(value)


class ServerImageRequest(ImageGenerationOptions):
    model_config = ConfigDict(extra="forbid")
    endpoint_id: str = Field(min_length=1, max_length=40)
    consent: bool


class ServerImageEndpoint(BaseModel):
    id: str
    model: str
