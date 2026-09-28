"""Database outbox for reminders. Provider acceptance is not inbox delivery.

Transactions claim an occurrence before I/O; duplicate broker messages reuse it.
An interrupted/ambiguous send is held for review instead of automatically resent.
"""
import html
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import exists, or_

from app.models.email_log import EmailLog
from app.models.personal import Reminder, ReminderDelivery, Todo
from app.models.user import User


def utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def next_occurrence(reminder, after):
    if reminder.recurrence == "once":
        return None
    zone = ZoneInfo(reminder.timezone)
    anchor = utc(reminder.anchor_at).astimezone(zone)
    local_after = utc(after).astimezone(zone)
    days = 1 if reminder.recurrence == "daily" else 7
    elapsed = max(1, (local_after.date() - anchor.date()).days // days)
    for step in range(elapsed, elapsed + 4):
        day = anchor.date() + timedelta(days=step * days)
        wall = datetime.combine(day, anchor.time().replace(tzinfo=None), zone).replace(fold=0)
        # A missing spring-forward wall time shifts forward by the DST gap.
        candidate = wall.astimezone(timezone.utc)
        if candidate > utc(after):
            return candidate
    raise ValueError("cannot determine next occurrence")


def cancel_pending(db, reminder):
    rows = db.query(ReminderDelivery).filter(
        ReminderDelivery.reminder_id == reminder.id,
        ReminderDelivery.status.in_(["pending", "failed"]),
    ).with_for_update().all()
    for row in rows:
        row.status = "cancelled"
        log = db.get(EmailLog, row.email_log_id)
        if log:
            log.status = "cancelled"


def eligible(db, reminder):
    user = db.get(User, reminder.user_id)
    if not user or not user.is_active or user.user_type == "guest" or user.email != reminder.recipient:
        return False
    if reminder.todo_id is not None:
        todo = db.get(Todo, reminder.todo_id)
        if not todo or todo.user_id != reminder.user_id or todo.status != "open":
            return False
    return True


def dispatch(factory, enqueue, now=None):
    now = now or datetime.now(timezone.utc)
    counts = {"created": 0, "enqueued": 0, "enqueue_failed": 0, "unknown": 0}
    with factory() as db:
        stale = db.query(ReminderDelivery).filter(
            ReminderDelivery.status == "sending",
            ReminderDelivery.last_attempt_at < now - timedelta(minutes=10),
        ).with_for_update(skip_locked=True).limit(100).all()
        for delivery in stale:
            delivery.status = "unknown"
            delivery.error_code = "delivery_outcome_unknown"
            log = db.get(EmailLog, delivery.email_log_id)
            log.status = "unknown"
            log.error_message = "delivery_outcome_unknown"
            counts["unknown"] += 1
        db.commit()
        occurrence_exists = exists().where(
            ReminderDelivery.reminder_id == Reminder.id,
            ReminderDelivery.revision == Reminder.revision,
            ReminderDelivery.scheduled_at == Reminder.next_run_at,
        )
        reminders = db.query(Reminder).filter(
            Reminder.status == "active", Reminder.next_run_at <= now,
            ~occurrence_exists,
        ).order_by(Reminder.next_run_at, Reminder.id).with_for_update(skip_locked=True).limit(100).all()
        for reminder in reminders:
            if not eligible(db, reminder):
                reminder.status = "paused"
                reminder.revision += 1
                cancel_pending(db, reminder)
                continue
            log = EmailLog(
                recipient=reminder.recipient, subject=reminder.subject,
                email_type="reminder", reminder_id=reminder.id,
                html_body="<h1>" + html.escape(reminder.subject) + "</h1><pre>" + html.escape(reminder.body) + "</pre>",
            )
            db.add(log)
            db.flush()
            db.add(ReminderDelivery(
                reminder_id=reminder.id, revision=reminder.revision,
                scheduled_at=reminder.next_run_at, email_log_id=log.id,
                next_attempt_at=now,
            ))
            counts["created"] += 1
        # Keep the entire selected batch locked until all outbox rows are durable.
        db.commit()
        deliveries = db.query(ReminderDelivery).join(Reminder).filter(
            Reminder.status == "active", Reminder.revision == ReminderDelivery.revision,
            ReminderDelivery.status.in_(["pending", "failed"]),
            ReminderDelivery.attempts < ReminderDelivery.retry_limit,
            ReminderDelivery.next_attempt_at <= now,
            or_(ReminderDelivery.enqueued_at.is_(None), ReminderDelivery.enqueued_at < now - timedelta(minutes=5)),
        ).order_by(ReminderDelivery.id).with_for_update(of=ReminderDelivery, skip_locked=True).limit(100).all()
        ids = [row.email_log_id for row in deliveries]
        for row in deliveries:
            row.enqueued_at = now
        db.commit()
    # A lost broker publish is retried from the same durable rows after five minutes.
    for log_id in ids:
        try:
            enqueue(log_id)
            counts["enqueued"] += 1
        except Exception:
            counts["enqueue_failed"] += 1
    return counts


def deliver(factory, log_id, send, enabled, now=None):
    now = now or datetime.now(timezone.utc)
    if not enabled():
        return {"status": "disabled"}
    with factory() as db:
        metadata = db.query(ReminderDelivery).filter_by(email_log_id=log_id).first()
        if not metadata:
            return {"status": "missing"}
        # Consistent lock order: reminder, then delivery. Never hold locks during I/O.
        reminder = db.query(Reminder).filter_by(id=metadata.reminder_id).with_for_update().first()
        delivery = db.query(ReminderDelivery).filter_by(id=metadata.id).populate_existing().with_for_update().one()
        if delivery.status not in {"pending", "failed"}:
            return {"status": delivery.status}
        if reminder.status != "active" or reminder.revision != delivery.revision or not eligible(db, reminder):
            delivery.status = "cancelled"
            db.get(EmailLog, log_id).status = "cancelled"
            db.commit()
            return {"status": "cancelled"}
        if delivery.attempts >= delivery.retry_limit or utc(delivery.next_attempt_at) > now:
            return {"status": "waiting"}
        log = db.get(EmailLog, log_id)
        delivery.status = "sending"
        delivery.attempts += 1
        attempt = delivery.attempts
        delivery.last_attempt_at = now
        log.status = "sending"
        payload = dict(to=log.recipient, subject=log.subject, html_body=log.html_body)
        reminder_id, delivery_id = reminder.id, delivery.id
        db.commit()
    outcome, code = "sent", None
    try:
        send(**payload)
    except ConnectionRefusedError:
        # Connection was refused before a provider could accept the email.
        outcome, code = "failed", "delivery_not_started"
    except Exception:
        # Timeout/disconnection can follow acceptance; don't blindly send again.
        outcome, code = "unknown", "delivery_outcome_unknown"
    with factory() as db:
        reminder = db.query(Reminder).filter_by(id=reminder_id).with_for_update().first()
        delivery = db.query(ReminderDelivery).filter_by(id=delivery_id).with_for_update().first()
        if not delivery or delivery.attempts != attempt or delivery.status not in {"sending", "unknown"}:
            return {"status": "superseded"}
        log = db.get(EmailLog, log_id)
        delivery.status, delivery.error_code = outcome, code
        log.status, log.error_message = outcome, code
        log.retry_count = max(0, delivery.attempts - 1)
        if outcome == "sent":
            log.sent_at = now
            if reminder and reminder.revision == delivery.revision and reminder.status == "active":
                reminder.last_run_at = now
                reminder.next_run_at = next_occurrence(reminder, max(now, utc(delivery.scheduled_at)))
                reminder.status = "active" if reminder.next_run_at else "completed"
                reminder.revision += 1
        elif outcome == "failed":
            delivery.next_attempt_at = now + timedelta(seconds=min(3600, 60 * 2 ** min(attempt - 1, 6)))
            delivery.enqueued_at = None
        db.commit()
    return {"status": outcome}
