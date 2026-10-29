"""Bounded request schemas for the server-side image model."""
from pydantic import BaseModel, ConfigDict, Field


class ServerImageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint_id: str = Field(min_length=1, max_length=40)
    prompt: str = Field(min_length=1, max_length=1000)
    consent: bool


class ServerImageEndpoint(BaseModel):
    id: str
    model: str
