"""Durable filesystem outbox. No user FK: work survives account removal."""
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class FileCleanupJob(Base):
    __tablename__ = 'file_cleanup_jobs'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    paths: Mapped[list] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(24), default='pending', index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    manual_review: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    available_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
