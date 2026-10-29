"""Strict public agent definitions. Credentials and executable code are excluded."""
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AgentField(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    key: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    label: str = Field(min_length=1, max_length=80)
    type: str = Field(pattern=r"^(string|number|boolean)$")
    required: bool
    description: str = Field(default="", max_length=240)

    @field_validator("label")
    @classmethod
    def trim_label(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Invalid field label")
        return value
