"""Isolated HTTP/outbox regression tests; no real email or model calls."""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.core.database import Base, get_db
from app.models import EmailLog, Note, Reminder, ReminderDelivery, Todo, User
from app.services.personal_reminders import deliver, dispatch, next_occurrence

NOW = datetime(2026, 9, 29, 8, tzinfo=timezone.utc)


def route_module():
    spec = importlib.util.spec_from_file_location("isolated_personal_routes", Path(__file__).parents[1] / "app/api/routes/personal.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def fixture(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    event.listen(engine, "connect", lambda db, _: db.execute("PRAGMA foreign_keys=ON"))
    names = ["users", "registration_applications", "email_logs", "notes", "todos", "reminders", "reminder_deliveries"]
    Base.metadata.create_all(engine, tables=[Base.metadata.tables[n] for n in names])
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.add_all([User(id=n, username=f"user{n}", email=f"user{n}@example.test", hashed_password="fixture", is_active=True, user_type="regular") for n in [1, 2]])
        db.commit()
    state = {"id": 1}
    module = route_module()
    monkeypatch.setattr(module.settings, "REMINDERS_ENABLED", True)
    monkeypatch.setattr(module.settings, "EMAIL_ENABLED", True)
    app = FastAPI()
    app.include_router(module.router)
    def auth():
        if not state["id"]:
            raise HTTPException(401)
        with factory() as db:
            return db.get(User, state["id"])
    def database():
        with factory() as db:
            yield db
    app.dependency_overrides[get_current_user] = auth
    app.dependency_overrides[get_db] = database
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, factory=factory, state=state, module=module)
    engine.dispose()


def reminder_payload(**changes):
    return dict(request_id=str(uuid4()), subject="季度报告", body="确认数据", next_run_at=(datetime.now(timezone.utc) + timedelta(days=2)).isoformat(), timezone="Asia/Shanghai", **changes)


def seeded(factory, recurrence="once", todo_id=None):
    with factory() as db:
        reminder = Reminder(user_id=1, recipient="user1@example.test", request_id=str(uuid4()), request_hash="f"*64, subject="Review <report>", body="<script>bad</script>", timezone="Asia/Shanghai", recurrence=recurrence, anchor_at=NOW-timedelta(minutes=1), next_run_at=NOW-timedelta(minutes=1), todo_id=todo_id)
        db.add(reminder)
        db.commit()
        return reminder.id


def logs(factory):
    with factory() as db:
        return db.scalars(select(EmailLog)).all()


@pytest.mark.parametrize("kind", ["notes", "todos"])
def test_crud_search_revision_and_user_isolation(fixture, kind):
    c = fixture.client
    url = "/personal/" + kind
    response = c.post(url, json={"title": "预算100%", "content": "中文", "tags": ["工作", "工作"]})
    assert response.status_code == 201, response.text
    item = response.json()
    assert item["tags"] == ["工作"]
    assert response.headers["cache-control"] == "no-store"
    assert c.get(url, params={"q": "%"}).json()[0]["id"] == item["id"]
    assert c.get(url, params={"q": "_"}).json() == []
    edited = c.patch(f"{url}/{item['id']}", json={"revision": 1, "content": "new"})
    assert edited.status_code == 200
    assert edited.json()["revision"] == 2
    assert c.patch(f"{url}/{item['id']}", json={"revision": 1, "content": "stale"}).status_code == 409
    fixture.state["id"] = 2
    assert c.get(url).json() == []
    assert c.patch(f"{url}/{item['id']}", json={"revision": 2, "content": "cross-user"}).status_code == 404
    assert c.delete(f"{url}/{item['id']}").status_code == 404
    fixture.state["id"] = 1
    assert c.delete(f"{url}/{item['id']}").status_code == 204


@pytest.mark.parametrize("data", [{"title": None}, {"content": None}, {"tags": None}, {"title": "  "}, {"title": "bad\r\nheader"}, {"due_at": "2026-09-29T12:00:00"}, {"status": "wrong"}, {"admin": True}])
def test_invalid_patch_is_redacted(fixture, data):
    c = fixture.client
    item = c.post("/personal/todos", json={"title": "x"}).json()
    response = c.patch(f"/personal/todos/{item['id']}", json={"revision": 1, **data})
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": "invalid_personal_request"}


def test_todo_due_dates_completed_and_cancelled_reminders(fixture):
    c = fixture.client
    todo = c.post("/personal/todos", json={"title": "x", "due_at": "2020-01-01T09:00:00+08:00"}).json()
    assert todo["due_at"].startswith("2020-01-01T01:00:00")
    assert len(c.get("/personal/todos?overdue=true").json()) == 1
    rid = seeded(fixture.factory, todo_id=todo["id"])
    dispatch(fixture.factory, Mock(), NOW)
    changed = c.patch(f"/personal/todos/{todo['id']}", json={"revision": 1, "status": "completed", "due_at": None})
    assert changed.json()["completed_at"] is not None
    assert changed.json()["due_at"] is None
    assert c.get("/personal/todos?overdue=true").json() == []
    with fixture.factory() as db:
        assert db.get(Reminder, rid).status == "cancelled"
        assert db.query(ReminderDelivery).one().status == "cancelled"
    send = Mock()
    assert deliver(fixture.factory, logs(fixture.factory)[0].id, send, lambda: True, NOW)["status"] == "cancelled"
    send.assert_not_called()


def test_reminder_idempotency_ownership_and_disabled_email(fixture, monkeypatch):
    c = fixture.client
    payload = reminder_payload()
    item = c.post("/personal/reminders", json=payload)
    assert item.status_code == 201, item.text
    assert item.json()["recipient"] == "user1@example.test"
    replay = c.post("/personal/reminders", json=payload)
    assert replay.status_code == 200
    assert replay.json()["id"] == item.json()["id"]
    assert c.post("/personal/reminders", json={**payload, "body": "changed"}).status_code == 409
    assert c.post("/personal/reminders", json={**reminder_payload(), "recipient": "other@example.test"}).status_code == 422
    fixture.state["id"] = 2
    assert c.get(f"/personal/reminders/{item.json()['id']}/deliveries").status_code == 404
    fixture.state["id"] = 1
    monkeypatch.setattr(fixture.module.settings, "EMAIL_ENABLED", False)
    assert c.get("/personal/capabilities").json()["email_reminders_enabled"] is False
    assert c.post("/personal/reminders", json=reminder_payload()).status_code == 503


def test_auth_and_guest_rejected(fixture):
    fixture.state["id"] = None
    assert fixture.client.get("/personal/notes").status_code == 401
    fixture.state["id"] = 1
    with fixture.factory() as db:
        db.get(User, 1).user_type = "guest"
        db.commit()
    assert fixture.client.get("/personal/notes").status_code == 403


def test_dispatch_recovers_broker_failure_with_same_occurrence(fixture):
    seeded(fixture.factory)
    enqueue = Mock(side_effect=RuntimeError("synthetic broker unavailable"))
    result = dispatch(fixture.factory, enqueue, NOW)
    assert result == {"created": 1, "enqueued": 0, "enqueue_failed": 1, "unknown": 0}
    log_id = logs(fixture.factory)[0].id
    assert "<script>" not in logs(fixture.factory)[0].html_body
    assert "&lt;script&gt;" in logs(fixture.factory)[0].html_body
    good = Mock()
    assert dispatch(fixture.factory, good, NOW + timedelta(minutes=6))["created"] == 0
    good.assert_called_once_with(log_id)
    assert len(logs(fixture.factory)) == 1


def test_delivery_duplicate_and_reentrant_messages_do_not_send_twice(fixture):
    rid = seeded(fixture.factory)
    dispatch(fixture.factory, Mock(), NOW)
    log_id = logs(fixture.factory)[0].id
    second = Mock()
    def accept(**kwargs):
        assert deliver(fixture.factory, log_id, second, lambda: True, NOW)["status"] == "sending"
    first = Mock(side_effect=accept)
    assert deliver(fixture.factory, log_id, first, lambda: True, NOW)["status"] == "sent"
    assert deliver(fixture.factory, log_id, first, lambda: True, NOW)["status"] == "sent"
    first.assert_called_once()
    second.assert_not_called()
    with fixture.factory() as db:
        assert db.get(Reminder, rid).status == "completed"
        assert db.query(ReminderDelivery).one().attempts == 1


def test_known_failure_retries_same_log_and_honors_backoff(fixture):
    seeded(fixture.factory)
    dispatch(fixture.factory, Mock(), NOW)
    log_id = logs(fixture.factory)[0].id
    fail = Mock(side_effect=ConnectionRefusedError())
    assert deliver(fixture.factory, log_id, fail, lambda: True, NOW)["status"] == "failed"
    assert deliver(fixture.factory, log_id, fail, lambda: True, NOW)["status"] == "waiting"
    assert deliver(fixture.factory, log_id, Mock(), lambda: True, NOW + timedelta(minutes=2))["status"] == "sent"
    assert len(logs(fixture.factory)) == 1


def test_ambiguous_delivery_requires_explicit_acknowledged_retry(fixture):
    rid = seeded(fixture.factory)
    dispatch(fixture.factory, Mock(), NOW)
    log_id = logs(fixture.factory)[0].id
    fail = Mock(side_effect=TimeoutError("provider credential should never appear"))
    assert deliver(fixture.factory, log_id, fail, lambda: True, NOW)["status"] == "unknown"
    assert dispatch(fixture.factory, Mock(), NOW + timedelta(days=1))["created"] == 0
    with fixture.factory() as db:
        delivery = db.query(ReminderDelivery).one()
        did = delivery.id
        assert delivery.error_code == "delivery_outcome_unknown"
    url = f"/personal/reminders/{rid}/deliveries/{did}/retry"
    assert fixture.client.post(url, json={}).status_code == 409
    response = fixture.client.post(url, json={"acknowledge_duplicate_risk": True})
    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert "credential" not in fixture.client.get(f"/personal/reminders/{rid}/deliveries").text


def test_stale_sending_is_held_not_resent_and_disabled_does_not_consume(fixture):
    seeded(fixture.factory)
    dispatch(fixture.factory, Mock(), NOW)
    log_id = logs(fixture.factory)[0].id
    assert deliver(fixture.factory, log_id, Mock(), lambda: False, NOW)["status"] == "disabled"
    with fixture.factory() as db:
        d = db.query(ReminderDelivery).one()
        assert d.attempts == 0
        d.status, d.last_attempt_at = "sending", NOW-timedelta(minutes=15)
        db.commit()
    assert dispatch(fixture.factory, Mock(), NOW)["unknown"] == 1
    assert len(logs(fixture.factory)) == 1


def test_pause_cancels_queued_email_and_resume_requires_future(fixture):
    rid = seeded(fixture.factory)
    dispatch(fixture.factory, Mock(), NOW)
    c = fixture.client
    assert c.patch(f"/personal/reminders/{rid}", json={"revision": 1, "status": "paused"}).status_code == 200
    send = Mock()
    deliver(fixture.factory, logs(fixture.factory)[0].id, send, lambda: True, NOW)
    send.assert_not_called()
    assert c.patch(f"/personal/reminders/{rid}", json={"revision": 1, "status": "active"}).status_code == 409
    assert c.patch(f"/personal/reminders/{rid}", json={"revision": 2, "status": "active", "next_run_at": (datetime.now(timezone.utc)+timedelta(days=1)).isoformat()}).status_code == 200


@pytest.mark.parametrize("anchor,after,expected", [
    ("2026-03-07T07:30:00+00:00", "2026-03-07T07:30:00+00:00", "2026-03-08T07:30:00+00:00"),
    ("2026-03-07T07:30:00+00:00", "2026-03-08T07:30:00+00:00", "2026-03-09T06:30:00+00:00"),
    ("2026-10-31T05:30:00+00:00", "2026-10-31T05:30:00+00:00", "2026-11-01T05:30:00+00:00"),
    ("2026-10-31T05:30:00+00:00", "2026-11-01T05:30:00+00:00", "2026-11-02T06:30:00+00:00"),
])
def test_daily_wall_clock_dst_rules(anchor, after, expected):
    r = SimpleNamespace(recurrence="daily", timezone="America/New_York", anchor_at=datetime.fromisoformat(anchor))
    assert next_occurrence(r, datetime.fromisoformat(after)).isoformat() == expected


def test_weekly_downtime_skips_missed_occurrences():
    r = SimpleNamespace(recurrence="weekly", timezone="Asia/Shanghai", anchor_at=NOW)
    assert next_occurrence(r, NOW+timedelta(days=20)) == NOW+timedelta(days=21)
