"""Celery adapter for the durable reminder outbox."""
from app.core.celery_app import celery_app
from app.core.config import settings
from app.core.database import SessionLocal
from app.services.personal_reminders import dispatch


@celery_app.task(name="app.tasks.reminder_tasks.dispatch_due_reminders", queue="email", acks_late=True)
def dispatch_due_reminders():
    if not settings.REMINDERS_ENABLED or not settings.EMAIL_ENABLED:
        return {"status": "disabled"}
    from app.tasks.email_tasks import send_email_task
    return dispatch(SessionLocal, send_email_task.delay)
