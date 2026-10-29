"""Atomic admission control for outstanding document-processing jobs."""

import logging
import threading
from dataclasses import dataclass, field

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.redis import RedisManager
from app.models.document import Document

_ADMISSION_LOCK = "document-queue:admission"
_ACTIVE_STATUSES = ("pending", "processing")
logger = logging.getLogger(__name__)


@dataclass
class DocumentAdmissionLease:
    token: str
    ttl_seconds: int
    _stopped: threading.Event = field(default_factory=threading.Event)
    _lost: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._heartbeat,
            name="document-admission-lease",
            daemon=True,
        )
        self._thread.start()

    def _heartbeat(self) -> None:
        interval = max(1, self.ttl_seconds // 3)
        while not self._stopped.wait(interval):
            if not RedisManager.renew_lock(_ADMISSION_LOCK, self.token, self.ttl_seconds):
                self._lost.set()
                logger.error("Document queue admission lock lost before database commit")
                return

    def ensure_valid(self) -> None:
        if self._lost.is_set() or not RedisManager.renew_lock(
            _ADMISSION_LOCK, self.token, self.ttl_seconds
        ):
            self._lost.set()
            raise HTTPException(
                503,
                detail={
                    "error": {
                        "code": "DOCUMENT_QUEUE_LOCK_LOST",
                        "message": "文档队列调度暂不可用，请稍后重试。",
                    }
                },
                headers={"Retry-After": "5"},
            )

    def release(self) -> None:
        self._stopped.set()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=1)
        RedisManager.release_lock(_ADMISSION_LOCK, self.token)


def acquire_document_admission(
    db: Session,
    user_id: int,
    *,
    exclude_document_id: int | None = None,
) -> DocumentAdmissionLease:
    ttl = max(30, int(settings.DOCUMENT_ADMISSION_LOCK_TTL_SECONDS))
    token = RedisManager.acquire_lock(_ADMISSION_LOCK, ttl=ttl)
    if token is None:
        raise HTTPException(
            503,
            detail={
                "error": {
                    "code": "DOCUMENT_QUEUE_BUSY",
                    "message": "文档队列正在调度，请稍后重试。",
                }
            },
            headers={"Retry-After": "5"},
        )

    lease = DocumentAdmissionLease(token, ttl)
    lease.start()
    try:
        active = db.query(func.count(Document.id)).filter(
            Document.is_deleted.is_(False),
            Document.status.in_(_ACTIVE_STATUSES),
        )
        if exclude_document_id is not None:
            active = active.filter(Document.id != exclude_document_id)
        global_count = active.scalar() or 0
        user_count = active.filter(Document.user_id == user_id).scalar() or 0
        if user_count >= settings.DOCUMENT_MAX_OUTSTANDING_PER_USER:
            raise HTTPException(
                429,
                detail={
                    "error": {
                        "code": "USER_DOCUMENT_QUEUE_FULL",
                        "message": "你的文档处理队列已满，请等待当前任务完成。",
                    }
                },
                headers={"Retry-After": "30"},
            )
        if global_count >= settings.DOCUMENT_MAX_OUTSTANDING_GLOBAL:
            raise HTTPException(
                429,
                detail={
                    "error": {
                        "code": "DOCUMENT_QUEUE_FULL",
                        "message": "文档处理队列已满，请稍后重试。",
                    }
                },
                headers={"Retry-After": "30"},
            )
        lease.ensure_valid()
        return lease
    except Exception:
        lease.release()
        raise


def release_document_admission(lease: DocumentAdmissionLease | None) -> None:
    if lease:
        lease.release()
