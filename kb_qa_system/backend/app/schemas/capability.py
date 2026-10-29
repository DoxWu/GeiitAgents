"""Portable capability contracts, never connection credentials."""
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.schemas.agent_fields import AgentField


class FunctionSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    id: UUID
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(max_length=300)
    version: int = Field(ge=1, le=1000000)
    code: str = Field(min_length=1, max_length=20000)
    reviewed: bool
    input_fields: list[AgentField] = Field(min_length=1, max_length=10, alias="inputFields")
    output_fields: list[AgentField] = Field(min_length=1, max_length=10, alias="outputFields")


class CapabilitySpec(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    id: UUID
    name: str = Field(min_length=1, max_length=100)
    kind: str = Field(pattern="^(tool|skill|mcp)$")
    version: int = Field(ge=1, le=1000000)
    description: str = Field(max_length=300)
    content: str = Field(max_length=5000)
    fn: FunctionSpec | None = None
    endpoint: str | None = Field(default=None, max_length=2048)
    toolName: str | None = Field(default=None, pattern=r"^[\w.-]{1,80}$")
    inputFields: list[AgentField] | None = Field(default=None, min_length=1, max_length=10)
    outputFields: list[AgentField] | None = Field(default=None, min_length=1, max_length=10)
    sharedId: UUID | None = None

    @model_validator(mode="after")
    def contract(self):
        if not self.name.strip():
            raise ValueError("empty name")
        if (self.kind == "tool") != (self.fn is not None):
            raise ValueError("function required only for tool")
        if self.kind == "mcp":
            url = urlsplit(self.endpoint or "")
            if (url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.port not in (None, 443) or url.query or url.fragment
                    or not self.toolName or not self.inputFields or not self.outputFields):
                raise ValueError("invalid MCP endpoint or contract")
        elif any(x is not None for x in (self.endpoint, self.toolName, self.inputFields, self.outputFields)):
            raise ValueError("unexpected connection fields")
        groups = (self.fn.input_fields, self.fn.output_fields) if self.fn else (self.inputFields, self.outputFields)
        for fields in groups:
            if fields and len({f.key for f in fields}) != len(fields):
                raise ValueError("duplicate contract fields")
        return self


class CapabilityPublish(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resource: CapabilitySpec
    organizationId: int | None = Field(default=None, ge=1)


class McpCall(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inputs: dict[str, str | int | float | bool] = Field(max_length=10)
    consent: bool
