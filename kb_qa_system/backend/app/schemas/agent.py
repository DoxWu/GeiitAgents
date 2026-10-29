"""Strict public agent definitions with approved isolated capabilities; no credentials."""
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


from app.schemas.agent_fields import AgentField
from app.schemas.capability import CapabilitySpec


class AgentSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    name: str = Field(min_length=1, max_length=100)
    summary: str = Field(default="", max_length=300)
    instructions: str = Field(min_length=1, max_length=5000)
    input_fields: list[AgentField] = Field(min_length=1, max_length=10, alias="inputFields")
    output_fields: list[AgentField] = Field(min_length=1, max_length=10, alias="outputFields")

    capabilities: list[CapabilitySpec] = Field(default_factory=list, max_length=12)

    @field_validator("name", "instructions")
    @classmethod
    def trim_required(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Required text is empty")
        return value

    @model_validator(mode="after")
    def unique_fields(self):
        for fields in (self.input_fields, self.output_fields):
            keys = [item.key for item in fields]
            if len(keys) != len(set(keys)):
                raise ValueError("Duplicate field key")
        return self


class SharedAgentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    agent: AgentSpec
    organization_id: int | None = Field(default=None, alias="organizationId", ge=1)


class SharedAgentOut(BaseModel):
    id: str
    ownerName: str
    agent: AgentSpec
    createdAt: str
    updatedAt: str
