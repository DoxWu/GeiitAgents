"""Loopback-only UI QA fixture. SQLite memory DB; no Celery or email sender.

Run only via the frontend verify-reminder-edit.mjs script, never as an app server.
"""
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.core.config import settings
from app.core.database import Base, get_db
from app.models import EmailLog, Reminder, ReminderDelivery, User

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
names = ["users", "registration_applications", "email_logs", "notes", "todos", "reminders", "reminder_deliveries"]
Base.metadata.create_all(engine, tables=[Base.metadata.tables[name] for name in names])
factory = sessionmaker(bind=engine, expire_on_commit=False)
with factory() as db:
    db.add(User(id=1, username="qa-user", email="qa@example.test", hashed_password="fixture", is_active=True, user_type="regular"))
    db.commit()


def auth():
    with factory() as db:
        return db.get(User, 1)


def database():
    with factory() as db:
        yield db


# Flags expose scheduling controls only; this fixture never runs a scheduler.
settings.REMINDERS_ENABLED = settings.EMAIL_ENABLED = True
app = FastAPI()
spec = importlib.util.spec_from_file_location("qa_personal_routes", Path(__file__).parents[1] / "app/api/routes/personal.py")
routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routes)
app.include_router(routes.router, prefix="/api/v1")
app.dependency_overrides[get_current_user] = auth
app.dependency_overrides[get_db] = database


@app.get("/healthz")
def health():
    return {"fixture": "reminder-qa-memory-only"}


@app.post("/__qa__/unknown")
def unknown_fixture():
    now = datetime.now(timezone.utc)
    with factory() as db:
        item = Reminder(user_id=1, recipient="qa@example.test", request_id=str(uuid4()), request_hash="f" * 64,
                        subject="Uncertain fixture", body="No email was sent by this fixture.", timezone="Asia/Shanghai",
                        anchor_at=now - timedelta(minutes=10), next_run_at=now - timedelta(minutes=10))
        db.add(item)
        db.flush()
        log = EmailLog(recipient=item.recipient, subject=item.subject, html_body="fixture", email_type="reminder", reminder_id=item.id, status="unknown")
        db.add(log)
        db.flush()
        db.add(ReminderDelivery(reminder_id=item.id, revision=1, scheduled_at=item.next_run_at, email_log_id=log.id,
                               status="unknown", attempts=1, last_attempt_at=now, next_attempt_at=now, error_code="delivery_outcome_unknown"))
        db.commit()
        return {"id": item.id}


@app.post("/__qa__/pagination")
def pagination_fixture():
    now = datetime.now(timezone.utc)
    with factory() as db:
        for index in range(61):
            item = Reminder(user_id=1, recipient="qa@example.test", request_id=str(uuid4()), request_hash="f" * 64,
                            subject=f"分页提醒 {index:03}", body="合成历史记录，无邮件发送。", timezone="Asia/Shanghai",
                            anchor_at=now, next_run_at=None, status="completed")
            db.add(item)
        db.flush()
        rid = item.id
        for index in range(55):
            log = EmailLog(recipient=item.recipient, subject=item.subject, html_body="fixture", email_type="reminder", reminder_id=rid, status="sent")
            db.add(log)
            db.flush()
            db.add(ReminderDelivery(reminder_id=rid, revision=index + 1, scheduled_at=now - timedelta(days=index), email_log_id=log.id,
                                   status="sent", attempts=1, next_attempt_at=now))
        db.commit()
        return {"reminder_id": rid, "reminders": 61, "deliveries": 55}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=18763, log_level="warning", access_log=False)
