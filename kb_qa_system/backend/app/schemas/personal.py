"""Strict contracts for account-owned records, separate from the local vault."""
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

Title = Annotated[str, Field(min_length=1, max_length=120)]
Tags = Annotated[list[Annotated[str, Field(min_length=1, max_length=40)]], Field(max_length=20)]
TodoStatus = Literal["open", "completed", "cancelled"]
Priority = Literal["low", "normal", "high"]
Recurrence = Literal["once", "daily", "weekly"]

class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("title", "subject", check_fields=False)
    @classmethod
    def clean_title(cls, value):
        if value is None or not value.strip() or any(ord(c) < 32 for c in value):
            raise ValueError("title must be nonempty and contain no control characters")
        return value.strip()

    @field_validator("tags", check_fields=False)
    @classmethod
    def clean_tags(cls, value):
        if value is None:
            raise ValueError("tags cannot be null")
        return list(dict.fromkeys(tag.strip() for tag in value if tag.strip()))

    @field_validator("timezone", check_fields=False)
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ValueError, TypeError, ZoneInfoNotFoundError):
            raise ValueError("invalid IANA timezone") from None
        return value

    @field_validator("due_at", "next_run_at", check_fields=False)
    @classmethod
    def utc_datetime(cls, value):
        if value is not None:
            if not 1970 <= value.year <= 2100:
                raise ValueError("date must be between 1970 and 2100")
            return value.astimezone(timezone.utc)
        return value

    @model_validator(mode="after")
    def reject_null_fields(self):
        for name in self.model_fields_set:
            if getattr(self, name) is None and name not in {"due_at", "todo_id"}:
                raise ValueError(f"{name} cannot be null")
        return self

class NoteCreate(Input):
    title: Title
    content: str = Field(default="", max_length=500_000)
    tags: Tags = Field(default_factory=list)

class NoteUpdate(Input):
    revision: int = Field(ge=1)
    title: Title | None = None
    content: str | None = Field(default=None, max_length=500_000)
    tags: Tags | None = None

class TodoCreate(NoteCreate):
    status: TodoStatus = "open"
    priority: Priority = "normal"
    due_at: AwareDatetime | None = None

class TodoUpdate(NoteUpdate):
    status: TodoStatus | None = None
    priority: Priority | None = None
    due_at: AwareDatetime | None = None

class ReminderCreate(Input):
    request_id: UUID
    subject: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=100_000)
    timezone: str = Field(default="UTC", max_length=64)
    recurrence: Recurrence = "once"
    next_run_at: AwareDatetime
    todo_id: int | None = Field(default=None, ge=1)

class ReminderUpdate(Input):
    revision: int = Field(ge=1)
    subject: str | None = Field(default=None, min_length=1, max_length=200)
    body: str | None = Field(default=None, max_length=100_000)
    timezone: str | None = Field(default=None, max_length=64)
    recurrence: Recurrence | None = None
    next_run_at: AwareDatetime | None = None
    todo_id: int | None = Field(default=None, ge=1)
    status: Literal["active", "paused", "cancelled"] | None = None

class DeliveryRetry(Input):
    acknowledge_duplicate_risk: bool = False

class Output(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    @field_validator("created_at", "updated_at", "due_at", "completed_at", "next_run_at", "last_run_at", "scheduled_at", "last_attempt_at", "next_attempt_at", check_fields=False)
    @classmethod
    def timezone_on_output(cls, value):
        return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value

class NoteOut(Output):
    id: int
    title: str
    content: str
    tags: list[str]
    revision: int
    created_at: datetime
    updated_at: datetime

class TodoOut(NoteOut):
    status: TodoStatus
    priority: Priority
    due_at: datetime | None
    completed_at: datetime | None

class ReminderOut(Output):
    id: int
    request_id: str
    revision: int
    todo_id: int | None
    recipient: str
    subject: str
    body: str
    timezone: str
    recurrence: Recurrence
    next_run_at: datetime | None
    status: str
    last_run_at: datetime | None
    created_at: datetime
    updated_at: datetime

class DeliveryOut(Output):
    id: int
    reminder_id: int
    revision: int
    scheduled_at: datetime
    status: str
    attempts: int
    retry_limit: int
    next_attempt_at: datetime
    last_attempt_at: datetime | None
    error_code: str | None
    created_at: datetime
