"""Account-owned personal records; local vault content is never auto-uploaded."""
import hashlib
import json
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy import or_, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import get_current_regular_user
from app.core.config import settings
from app.core.database import get_db
from app.models.email_log import EmailLog
from app.models.personal import Note, Reminder, ReminderDelivery, Todo
from app.models.user import User
from app.schemas.personal import (
    DeliveryDismiss, DeliveryOut, DeliveryPage, DeliveryRetry, NoteCreate, NoteOut, NoteUpdate,
    ReminderCreate, ReminderOut, ReminderPage, ReminderUpdate, TodoCreate, TodoOut, TodoUpdate,
)
from app.services.personal_reminders import cancel_pending, next_occurrence, utc


class PersonalRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def safe_handler(request):
            try:
                result = await handler(request)
            except RequestValidationError:
                result = JSONResponse(status_code=422, content={"detail": "invalid_personal_request"})
            except HTTPException as exc:
                result = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)
            except SQLAlchemyError:
                result = JSONResponse(status_code=503, content={"detail": "personal_storage_unavailable"})
            result.headers["Cache-Control"] = "no-store"
            return result
        return safe_handler


router = APIRouter(prefix="/personal", tags=["personal"], route_class=PersonalRoute)
UserDep = Depends(get_current_regular_user)
DbDep = Depends(get_db)


def owned(db, model, item_id, user, lock=False):
    query = db.query(model).filter(model.id == item_id, model.user_id == user.id)
    if lock:
        query = query.with_for_update()
    item = query.first()
    if not item:
        raise HTTPException(404, "record_not_found")
    return item


def output(item):
    fields = ("id", "title", "content", "revision", "created_at", "updated_at")
    if isinstance(item, Todo):
        fields += ("status", "priority", "due_at", "completed_at")
    return {**{key: getattr(item, key) for key in fields}, "tags": json.loads(item.tags)}


def limited_query(db, model, user, q):
    query = db.query(model).filter(model.user_id == user.id)
    if q:
        needle = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.filter(or_(*(field.ilike(needle, escape="\\") for field in (model.title, model.content, model.tags))))
    return query


def quota(db, model, user, maximum):
    # Serialize quota checks for this user, including independent API workers.
    db.query(User).filter(User.id == user.id).with_for_update().one()
    query = db.query(model).filter(model.user_id == user.id)
    if model is Reminder:
        query = query.filter(Reminder.status.in_(["active", "paused"]))
    if query.count() >= maximum:
        raise HTTPException(409, "personal_record_limit")


def create_record(db, model, body, user):
    quota(db, model, user, 1000)
    data = body.model_dump()
    data["tags"] = json.dumps(data["tags"], ensure_ascii=False)
    if model is Todo:
        data["completed_at"] = datetime.now(timezone.utc) if body.status == "completed" else None
    item = model(user_id=user.id, **data)
    db.add(item)
    db.commit()
    db.refresh(item)
    return output(item)


def cancel_todo_reminders(db, todo_id, user):
    for reminder in db.query(Reminder).filter(Reminder.todo_id == todo_id, Reminder.user_id == user.id).order_by(Reminder.id).with_for_update().all():
        reminder.status, reminder.next_run_at = "cancelled", None
        reminder.revision += 1
        cancel_pending(db, reminder)


def patch_record(db, model, item_id, body, user):
    item = owned(db, model, item_id, user)
    data = body.model_dump(exclude_unset=True, exclude={"revision"})
    if not data:
        raise HTTPException(422, "empty_update")
    if "tags" in data:
        data["tags"] = json.dumps(data["tags"], ensure_ascii=False)
    if model is Todo and "status" in data:
        data["completed_at"] = (item.completed_at or datetime.now(timezone.utc)) if data["status"] == "completed" else None
    result = db.execute(update(model).where(model.id == item_id, model.user_id == user.id, model.revision == body.revision).values(**data, revision=body.revision + 1))
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(409, "revision_conflict")
    if model is Todo and data.get("status") in {"completed", "cancelled"}:
        cancel_todo_reminders(db, item_id, user)
    db.commit()
    db.refresh(item)
    return output(item)


@router.get("/notes", response_model=list[NoteOut])
def list_notes(q: str | None = Query(None, max_length=200), limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=10000), user=UserDep, db: Session=DbDep):
    return [output(item) for item in limited_query(db, Note, user, q).order_by(Note.updated_at.desc(), Note.id.desc()).offset(offset).limit(limit).all()]


@router.post("/notes", response_model=NoteOut, status_code=201)
def create_note(body: NoteCreate, user=UserDep, db: Session=DbDep):
    return create_record(db, Note, body, user)


@router.patch("/notes/{note_id}", response_model=NoteOut)
def update_note(note_id: int, body: NoteUpdate, user=UserDep, db: Session=DbDep):
    return patch_record(db, Note, note_id, body, user)


@router.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: int, user=UserDep, db: Session=DbDep):
    db.delete(owned(db, Note, note_id, user, lock=True))
    db.commit()
    return Response(status_code=204)


@router.get("/todos", response_model=list[TodoOut])
def list_todos(q: str | None = Query(None, max_length=200), status: Literal["open", "completed", "cancelled"] | None = None, overdue: bool = False, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=10000), user=UserDep, db: Session=DbDep):
    query = limited_query(db, Todo, user, q)
    if status:
        query = query.filter(Todo.status == status)
    if overdue:
        query = query.filter(Todo.status == "open", Todo.due_at < datetime.now(timezone.utc))
    return [output(item) for item in query.order_by(Todo.due_at.asc().nullslast(), Todo.id.desc()).offset(offset).limit(limit).all()]


@router.post("/todos", response_model=TodoOut, status_code=201)
def create_todo(body: TodoCreate, user=UserDep, db: Session=DbDep):
    return create_record(db, Todo, body, user)


@router.patch("/todos/{todo_id}", response_model=TodoOut)
def update_todo(todo_id: int, body: TodoUpdate, user=UserDep, db: Session=DbDep):
    return patch_record(db, Todo, todo_id, body, user)


@router.delete("/todos/{todo_id}", status_code=204)
def delete_todo(todo_id: int, user=UserDep, db: Session=DbDep):
    item = owned(db, Todo, todo_id, user, lock=True)
    cancel_todo_reminders(db, item.id, user)
    db.delete(item)
    db.commit()
    return Response(status_code=204)


def future(value):
    if value is None or utc(value) <= datetime.now(timezone.utc):
        raise HTTPException(422, "future_schedule_required")


def open_todo(db, todo_id, user):
    if todo_id is not None and owned(db, Todo, todo_id, user).status != "open":
        raise HTTPException(409, "todo_not_open")


@router.get("/capabilities")
def capabilities(user=UserDep):
    return {"email_reminders_enabled": settings.REMINDERS_ENABLED and settings.EMAIL_ENABLED, "recipient_policy": "account_email", "scheduler_interval_seconds": 60}


@router.get("/reminders", response_model=list[ReminderOut])
def list_reminders(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=10000), user=UserDep, db: Session=DbDep):
    return db.query(Reminder).filter(Reminder.user_id == user.id).order_by(Reminder.next_run_at.asc().nullslast(), Reminder.id).offset(offset).limit(limit).all()


@router.post("/reminders", response_model=ReminderOut, status_code=201)
def create_reminder(body: ReminderCreate, response: Response, user=UserDep, db: Session=DbDep):
    fingerprint = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    db.query(User).filter(User.id == user.id).with_for_update().one()
    existing = db.query(Reminder).filter_by(user_id=user.id, request_id=str(body.request_id)).first()
    if existing:
        if existing.request_hash != fingerprint:
            raise HTTPException(409, "idempotency_conflict")
        response.status_code = 200
        return existing
    if not settings.REMINDERS_ENABLED or not settings.EMAIL_ENABLED:
        raise HTTPException(503, "email_reminders_disabled")
    quota(db, Reminder, user, 100)
    future(body.next_run_at)
    open_todo(db, body.todo_id, user)
    if not user.email or "@" not in user.email or any(ord(c) < 32 for c in user.email):
        raise HTTPException(409, "account_email_required")
    data = body.model_dump(exclude={"request_id"})
    item = Reminder(user_id=user.id, request_id=str(body.request_id), request_hash=fingerprint, recipient=user.email, anchor_at=body.next_run_at, **data)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def page_query(query, model, limit, cursor, snapshot_id):
    # Immutable IDs avoid skips when schedules/statuses change during browsing.
    # This is an insertion boundary, not a database transaction snapshot.
    if cursor is not None and (snapshot_id is None or cursor > snapshot_id):
        raise HTTPException(422, "invalid_page_cursor")
    if snapshot_id is not None:
        query = query.filter(model.id <= snapshot_id)
    if cursor is not None:
        query = query.filter(model.id < cursor)
    rows = query.order_by(model.id.desc()).limit(limit + 1).all()
    boundary = snapshot_id if snapshot_id is not None else rows[0].id if rows else 0
    return {"items": rows[:limit], "snapshot_id": boundary, "next_cursor": rows[limit - 1].id if len(rows) > limit else None}


@router.get("/reminders/page", response_model=ReminderPage)
def page_reminders(limit: int = Query(20, ge=1, le=100), cursor: int | None = Query(None, ge=1), snapshot_id: int | None = Query(None, ge=0), user=UserDep, db: Session=DbDep):
    return page_query(db.query(Reminder).filter(Reminder.user_id == user.id), Reminder, limit, cursor, snapshot_id)


@router.get("/reminders/{reminder_id}", response_model=ReminderOut)
def get_reminder(reminder_id: int, user=UserDep, db: Session=DbDep):
    return owned(db, Reminder, reminder_id, user)


@router.patch("/reminders/{reminder_id}", response_model=ReminderOut)
def update_reminder(reminder_id: int, body: ReminderUpdate, user=UserDep, db: Session=DbDep):
    item = owned(db, Reminder, reminder_id, user, lock=True)
    if item.revision != body.revision:
        raise HTTPException(409, "revision_conflict")
    data = body.model_dump(exclude_unset=True, exclude={"revision"})
    if not data:
        raise HTTPException(422, "empty_update")
    if item.status in {"cancelled", "completed"}:
        raise HTTPException(409, "reminder_closed")
    rule_changed = any(key in data and data[key] != getattr(item, key) for key in ("timezone", "recurrence"))
    if rule_changed and "next_run_at" not in data:
        raise HTTPException(422, "rule_change_requires_schedule")
    uncertain = db.query(ReminderDelivery).filter(ReminderDelivery.reminder_id == item.id, ReminderDelivery.status.in_(["sending", "unknown"])).first()
    if uncertain and not (set(data) == {"status"} and data["status"] in {"paused", "cancelled"}):
        raise HTTPException(409, "delivery_in_flight_or_unknown")
    if "next_run_at" in data:
        future(data["next_run_at"])
        data["anchor_at"] = data["next_run_at"]
    if data.get("status") == "active":
        future(data.get("next_run_at", item.next_run_at))
    if "todo_id" in data or data.get("status") == "active":
        open_todo(db, data.get("todo_id", item.todo_id), user)
    cancel_pending(db, item)
    for key, value in data.items():
        setattr(item, key, value)
    if item.status == "cancelled":
        item.next_run_at = None
    item.revision += 1
    db.commit()
    db.refresh(item)
    return item


@router.delete("/reminders/{reminder_id}", status_code=204)
def cancel_reminder(reminder_id: int, user=UserDep, db: Session=DbDep):
    item = owned(db, Reminder, reminder_id, user, lock=True)
    cancel_pending(db, item)
    item.status, item.next_run_at = "cancelled", None
    item.revision += 1
    db.commit()
    return Response(status_code=204)


@router.get("/reminders/{reminder_id}/deliveries", response_model=list[DeliveryOut])
def list_deliveries(reminder_id: int, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=10000), user=UserDep, db: Session=DbDep):
    owned(db, Reminder, reminder_id, user)
    return db.query(ReminderDelivery).filter_by(reminder_id=reminder_id).order_by(ReminderDelivery.id.desc()).offset(offset).limit(limit).all()


@router.post("/reminders/{reminder_id}/deliveries/{delivery_id}/retry", response_model=DeliveryOut)
def retry_delivery(reminder_id: int, delivery_id: int, body: DeliveryRetry, user=UserDep, db: Session=DbDep):
    item = owned(db, Reminder, reminder_id, user, lock=True)
    delivery = db.query(ReminderDelivery).filter_by(id=delivery_id, reminder_id=item.id).with_for_update().first()
    if not delivery:
        raise HTTPException(404, "delivery_not_found")
    if item.status != "active" or item.revision != delivery.revision or delivery.status not in {"failed", "unknown"}:
        raise HTTPException(409, "delivery_not_retryable")
    if delivery.status == "unknown" and not body.acknowledge_duplicate_risk:
        raise HTTPException(409, "duplicate_risk_acknowledgement_required")
    delivery.status, delivery.next_attempt_at, delivery.enqueued_at = "pending", datetime.now(timezone.utc), None
    delivery.retry_limit = delivery.attempts + 5
    delivery.error_code = "manual_retry_acknowledged" if body.acknowledge_duplicate_risk else None
    log = db.get(EmailLog, delivery.email_log_id)
    log.status, log.error_message = "pending", delivery.error_code
    db.commit()
    db.refresh(delivery)
    return delivery


@router.get("/reminders/{reminder_id}/deliveries/page", response_model=DeliveryPage)
def page_deliveries(reminder_id: int, limit: int = Query(20, ge=1, le=100), cursor: int | None = Query(None, ge=1), snapshot_id: int | None = Query(None, ge=0), user=UserDep, db: Session=DbDep):
    owned(db, Reminder, reminder_id, user)
    return page_query(db.query(ReminderDelivery).filter(ReminderDelivery.reminder_id == reminder_id), ReminderDelivery, limit, cursor, snapshot_id)


@router.post("/reminders/{reminder_id}/deliveries/{delivery_id}/dismiss", response_model=DeliveryOut)
def dismiss_delivery(reminder_id: int, delivery_id: int, body: DeliveryDismiss, user=UserDep, db: Session=DbDep):
    # Explicitly close an uncertain attempt, not a claim that it was never sent.
    item = owned(db, Reminder, reminder_id, user, lock=True)
    delivery = db.query(ReminderDelivery).filter_by(id=delivery_id, reminder_id=item.id).with_for_update().first()
    if not delivery:
        raise HTTPException(404, "delivery_not_found")
    if not body.acknowledge_delivery_uncertainty:
        raise HTTPException(409, "delivery_uncertainty_acknowledgement_required")
    if delivery.status == "cancelled" and delivery.error_code == "uncertain_delivery_dismissed":
        return delivery  # Safe replay if the HTTP response was lost.
    if delivery.status != "unknown":
        raise HTTPException(409, "delivery_not_dismissible")
    delivery.status, delivery.error_code = "cancelled", "uncertain_delivery_dismissed"
    log = db.get(EmailLog, delivery.email_log_id)
    log.status, log.error_message = "cancelled", delivery.error_code
    # A matching active occurrence must advance, otherwise the durable row
    # would block scheduling forever. Paused/edited reminders retain their plan.
    if item.status == "active" and item.revision == delivery.revision:
        item.next_run_at = next_occurrence(item, max(datetime.now(timezone.utc), utc(delivery.scheduled_at)))
        item.status = "active" if item.next_run_at else "completed"
        item.revision += 1
    db.commit()
    db.refresh(delivery)
    return delivery
