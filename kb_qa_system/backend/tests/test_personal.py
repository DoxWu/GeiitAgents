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
from app.models import EmailLog, Reminder, ReminderDelivery, User
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


def test_reschedule_retires_queued_revision_and_uses_new_anchor_and_content(fixture):
    rid = seeded(fixture.factory, recurrence="daily")
    dispatch(fixture.factory, Mock(), NOW)
    old_log = logs(fixture.factory)[0].id
    scheduled = datetime.now(timezone.utc) + timedelta(days=2)
    changed = fixture.client.patch(f"/personal/reminders/{rid}", json={"revision": 1, "subject": "New weekly", "body": "Updated", "timezone": "America/New_York", "recurrence": "weekly", "next_run_at": scheduled.isoformat()})
    assert changed.status_code == 200, changed.text
    assert changed.json()["revision"] == 2
    with fixture.factory() as db:
        item = db.get(Reminder, rid)
        assert item.anchor_at.replace(tzinfo=timezone.utc) == scheduled
        assert db.query(ReminderDelivery).one().status == "cancelled"
        assert db.get(EmailLog, old_log).status == "cancelled"
    send = Mock()
    assert deliver(fixture.factory, old_log, send, lambda: True, scheduled)["status"] == "cancelled"
    send.assert_not_called()
    assert dispatch(fixture.factory, Mock(), scheduled)["created"] == 1
    new_log = logs(fixture.factory)[-1]
    assert new_log.subject == "New weekly" and "Updated" in new_log.html_body
    assert deliver(fixture.factory, new_log.id, send, lambda: True, scheduled)["status"] == "sent"
    send.assert_called_once()
    with fixture.factory() as db:
        item = db.get(Reminder, rid)
        assert item.next_run_at > scheduled.replace(tzinfo=None)
    # Stale edit must not replace the plan after the scheduler advances it.
    assert fixture.client.patch(f"/personal/reminders/{rid}", json={"revision": 2, "body": "stale"}).status_code == 409


@pytest.mark.parametrize("change", [{"timezone": "UTC"}, {"recurrence": "weekly"}])
def test_rule_change_requires_explicit_next_schedule(fixture, change):
    rid = seeded(fixture.factory)
    response = fixture.client.patch(f"/personal/reminders/{rid}", json={"revision": 1, **change})
    assert response.status_code == 422
    assert response.json()["detail"] == "rule_change_requires_schedule"
    with fixture.factory() as db:
        assert db.get(Reminder, rid).revision == 1


def test_reminder_detail_is_owned_and_ended_reminders_cannot_reopen(fixture):
    rid = seeded(fixture.factory)
    c = fixture.client
    assert c.get(f"/personal/reminders/{rid}").json()["id"] == rid
    fixture.state["id"] = 2
    assert c.get(f"/personal/reminders/{rid}").status_code == 404
    fixture.state["id"] = 1
    c.delete(f"/personal/reminders/{rid}")
    response = c.patch(f"/personal/reminders/{rid}", json={"revision": 2, "status": "active", "next_run_at": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()})
    assert response.status_code == 409 and response.json()["detail"] == "reminder_closed"


def test_unknown_paused_attempt_can_be_explicitly_dismissed_then_rescheduled(fixture):
    rid = seeded(fixture.factory)
    dispatch(fixture.factory, Mock(), NOW)
    log_id = logs(fixture.factory)[0].id
    deliver(fixture.factory, log_id, Mock(side_effect=TimeoutError()), lambda: True, NOW)
    c = fixture.client
    did = c.get(f"/personal/reminders/{rid}/deliveries").json()[0]["id"]
    assert c.patch(f"/personal/reminders/{rid}", json={"revision": 1, "status": "paused"}).status_code == 200
    scheduled = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    edit = {"revision": 2, "next_run_at": scheduled, "status": "active"}
    assert c.patch(f"/personal/reminders/{rid}", json=edit).json()["detail"] == "delivery_in_flight_or_unknown"
    url = f"/personal/reminders/{rid}/deliveries/{did}/dismiss"
    assert c.post(url, json={}).status_code == 409
    fixture.state["id"] = 2
    assert c.post(url, json={"acknowledge_delivery_uncertainty": True}).status_code == 404
    fixture.state["id"] = 1
    response = c.post(url, json={"acknowledge_delivery_uncertainty": True})
    assert response.status_code == 200
    assert response.json()["error_code"] == "uncertain_delivery_dismissed"
    assert c.post(url, json={"acknowledge_delivery_uncertainty": True}).json()["id"] == did
    with fixture.factory() as db:
        assert db.get(EmailLog, log_id).error_message == "uncertain_delivery_dismissed"
        assert db.get(Reminder, rid).status == "paused"
    assert c.patch(f"/personal/reminders/{rid}", json=edit).status_code == 200
    send = Mock()
    assert deliver(fixture.factory, log_id, send, lambda: True, NOW)["status"] == "cancelled"
    send.assert_not_called()


@pytest.mark.parametrize("recurrence", ["once", "daily"])
def test_dismissing_active_unknown_advances_without_claiming_delivery(fixture, recurrence):
    rid = seeded(fixture.factory, recurrence=recurrence)
    dispatch(fixture.factory, Mock(), NOW)
    deliver(fixture.factory, logs(fixture.factory)[0].id, Mock(side_effect=TimeoutError()), lambda: True, NOW)
    with fixture.factory() as db:
        did = db.query(ReminderDelivery).one().id
    url = f"/personal/reminders/{rid}/deliveries/{did}/dismiss"
    assert fixture.client.post(url, json={"acknowledge_delivery_uncertainty": True}).status_code == 200
    with fixture.factory() as db:
        item = db.get(Reminder, rid)
        assert item.last_run_at is None
        assert item.revision == 2
        assert item.status == ("completed" if recurrence == "once" else "active")
        assert (item.next_run_at is None) == (recurrence == "once")


def test_sending_cannot_be_dismissed_and_pause_does_not_claim_recall(fixture):
    rid = seeded(fixture.factory)
    dispatch(fixture.factory, Mock(), NOW)
    log_id = logs(fixture.factory)[0].id
    with fixture.factory() as db:
        did = db.query(ReminderDelivery).one().id
    def send(**kwargs):
        c = fixture.client
        assert c.post(f"/personal/reminders/{rid}/deliveries/{did}/dismiss", json={"acknowledge_delivery_uncertainty": True}).status_code == 409
        assert c.patch(f"/personal/reminders/{rid}", json={"revision": 1, "body": "changed"}).status_code == 409
        assert c.patch(f"/personal/reminders/{rid}", json={"revision": 1, "status": "paused"}).status_code == 200
    assert deliver(fixture.factory, log_id, send, lambda: True, NOW)["status"] == "sent"
    with fixture.factory() as db:
        assert db.get(Reminder, rid).status == "paused"
        assert db.get(ReminderDelivery, did).status == "sent"


def test_reminder_pages_do_not_skip_when_schedules_change_or_records_are_inserted_deleted(fixture):
    ids = [seeded(fixture.factory) for _ in range(61)]
    c = fixture.client
    first = c.get("/personal/reminders/page", params={"limit": 20}).json()
    assert [item["id"] for item in first["items"]] == ids[-20:][::-1]
    boundary = first["snapshot_id"]
    assert boundary == ids[-1]
    new_id = seeded(fixture.factory)
    deleted = ids[12]
    with fixture.factory() as db:
        db.delete(db.get(Reminder, deleted))
        db.get(Reminder, ids[5]).next_run_at = datetime(2099, 1, 1, tzinfo=timezone.utc)
        db.get(Reminder, ids[8]).status = "cancelled"
        db.commit()
    seen = [item["id"] for item in first["items"]]
    current = first
    while current["next_cursor"] is not None:
        current = c.get("/personal/reminders/page", params={"limit": 20, "snapshot_id": boundary, "cursor": current["next_cursor"]}).json()
        assert current["snapshot_id"] == boundary
        seen.extend(item["id"] for item in current["items"])
    assert seen == [item for item in reversed(ids) if item != deleted]
    # Going back uses the same upper boundary; refreshing starts a new window.
    previous = c.get("/personal/reminders/page", params={"snapshot_id": boundary}).json()
    assert previous["items"][0]["id"] == ids[-1]
    assert c.get("/personal/reminders/page").json()["items"][0]["id"] == new_id
    assert isinstance(c.get("/personal/reminders").json(), list)


def test_page_cursor_is_not_a_permission_and_does_not_require_the_boundary_row_to_exist(fixture):
    ids = [seeded(fixture.factory) for _ in range(4)]
    c = fixture.client
    first = c.get("/personal/reminders/page", params={"limit": 2}).json()
    with fixture.factory() as db:
        db.delete(db.get(Reminder, first["next_cursor"]))
        db.commit()
    rest = c.get("/personal/reminders/page", params={"limit": 2, "snapshot_id": first["snapshot_id"], "cursor": first["next_cursor"]}).json()
    assert [item["id"] for item in rest["items"]] == ids[:2][::-1]
    fixture.state["id"] = 2
    forged = c.get("/personal/reminders/page", params={"cursor": first["next_cursor"], "snapshot_id": first["snapshot_id"]})
    assert forged.json()["items"] == []
    assert forged.headers["cache-control"] == "no-store"
    assert c.get(f"/personal/reminders/{ids[0]}/deliveries/page").status_code == 404


def test_delivery_pages_keep_their_window_during_new_dispatch_and_status_updates(fixture):
    rid = seeded(fixture.factory)
    with fixture.factory() as db:
        ids = []
        for index in range(55):
            log = EmailLog(recipient="user1@example.test", subject="fixture", html_body="fixture", email_type="reminder", reminder_id=rid)
            db.add(log)
            db.flush()
            row = ReminderDelivery(reminder_id=rid, revision=index+1, email_log_id=log.id, scheduled_at=NOW, next_attempt_at=NOW, status="sent")
            db.add(row)
            db.flush()
            ids.append(row.id)
        db.commit()
    url = f"/personal/reminders/{rid}/deliveries/page"
    first = fixture.client.get(url).json()
    assert len(first["items"]) == 20
    with fixture.factory() as db:
        db.get(ReminderDelivery, ids[5]).status = "cancelled"
        log = EmailLog(recipient="user1@example.test", subject="new", html_body="fixture", email_type="reminder", reminder_id=rid)
        db.add(log)
        db.flush()
        db.add(ReminderDelivery(reminder_id=rid, revision=100, email_log_id=log.id, scheduled_at=NOW, next_attempt_at=NOW))
        db.commit()
    seen = [row["id"] for row in first["items"]]
    current = first
    while current["next_cursor"] is not None:
        current = fixture.client.get(url, params={"cursor": current["next_cursor"], "snapshot_id": first["snapshot_id"]}).json()
        seen.extend(row["id"] for row in current["items"])
    assert seen == list(reversed(ids))
    assert fixture.client.get(url).json()["items"][0]["id"] > ids[-1]
    assert isinstance(fixture.client.get(f"/personal/reminders/{rid}/deliveries").json(), list)


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 101}, {"cursor": 0}, {"cursor": 10}, {"cursor": 10, "snapshot_id": 9}, {"snapshot_id": -1}])
def test_invalid_page_queries_are_rejected_without_echoing_inputs(fixture, params):
    response = fixture.client.get("/personal/reminders/page", params=params)
    assert response.status_code == 422
    assert response.json()["detail"] in {"invalid_personal_request", "invalid_page_cursor"}
    assert response.headers["cache-control"] == "no-store"


def test_empty_page_is_terminal(fixture):
    response = fixture.client.get("/personal/reminders/page")
    assert response.json() == {"items": [], "snapshot_id": 0, "next_cursor": None}
