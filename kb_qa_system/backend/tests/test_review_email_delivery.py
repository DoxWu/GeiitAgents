"""Resend response handling; tests never connect to the real service."""

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.email_log import EmailLog
from app.services import email_service
from app.tasks import email_tasks


class FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self.payload = payload

    def json(self):
        return self.payload


def install_response(monkeypatch, response=None, error=None):
    calls = []

    class Client:
        def __init__(self, **kwargs):
            calls.append({"options": kwargs})

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, url, **kwargs):
            calls.append({"url": url, "request": kwargs})
            if error:
                raise error
            return response

    monkeypatch.setattr(email_service.httpx, "Client", Client)
    monkeypatch.setattr(email_service.settings, "RESEND_API_KEY", "test-secret")
    monkeypatch.setattr(email_service.settings, "SMTP_PASSWORD", "")
    monkeypatch.setattr(email_service.settings, "EMAIL_FROM", "test@example.invalid")
    return calls


def test_resend_acceptance_requires_provider_message_id(monkeypatch):
    calls = install_response(monkeypatch, FakeResponse(200, {"id": "msg-test"}))
    assert (
        email_service._send_via_http_api("recipient@example.invalid", "subject", "body")
        == "msg-test"
    )
    assert len([call for call in calls if call.get("url")]) == 1
    assert calls[1]["url"] == "https://api.resend.com/emails"
    assert calls[1]["request"]["headers"]["Authorization"] == "Bearer test-secret"


@pytest.mark.parametrize("status", [400, 401, 403, 429])
def test_resend_explicit_http_rejection_is_traceable_without_body(monkeypatch, status):
    install_response(monkeypatch, FakeResponse(status, {"message": "private response body"}))
    with pytest.raises(email_service.EmailDeliveryRejected) as error:
        email_service._send_via_http_api("recipient@example.invalid", "subject", "body")
    assert error.value.error_code == f"resend_http_{status}"
    assert "private response body" not in str(error.value)


@pytest.mark.parametrize(
    "response",
    [
        FakeResponse(503, {"message": "private response body"}),
        FakeResponse(200, {}),
        FakeResponse(302, {"id": "synthetic-id"}),
        FakeResponse(200, {"id": " "}),
    ],
)
def test_resend_ambiguous_response_is_not_claimed_as_sent(monkeypatch, response):
    install_response(monkeypatch, response)
    with pytest.raises(email_service.EmailDeliveryOutcomeUnknown) as error:
        email_service._send_via_http_api("recipient@example.invalid", "subject", "body")
    assert "private response body" not in str(error.value)


def test_resend_timeout_is_unknown_and_attempted_once(monkeypatch):
    calls = install_response(monkeypatch, error=httpx.ReadTimeout("private response body"))
    with pytest.raises(email_service.EmailDeliveryOutcomeUnknown) as error:
        email_service._send_via_http_api("recipient@example.invalid", "subject", "body")
    assert "private response body" not in str(error.value)
    assert len([call for call in calls if call.get("url")]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("password", ["", "smtp-synthetic"])
async def test_smtp_application_uses_configured_password_or_api_key(monkeypatch, password):
    calls = []

    async def send(message, **options):
        calls.append((message, options))

    monkeypatch.setattr(email_service.aiosmtplib, "send", send)
    monkeypatch.setattr(email_service.settings, "SMTP_PASSWORD", password)
    monkeypatch.setattr(email_service.settings, "RESEND_API_KEY", "api-synthetic")
    await email_service._send_via_smtp_async("recipient@example.invalid", "Synthetic", "body")
    assert len(calls) == 1
    assert calls[0][1]["password"] == (password or "api-synthetic")
    assert calls[0][0]["To"] == "recipient@example.invalid"


@pytest.mark.parametrize("password", ["", "smtp-synthetic"])
def test_ops_smtp_uses_same_api_key_fallback(monkeypatch, password):
    from types import SimpleNamespace

    from app.ops import alerts

    logins = []
    sends = []

    class Client:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def login(self, username, password):
            logins.append((username, password))

        def send_message(self, message):
            sends.append(message)

    monkeypatch.setattr(alerts.smtplib, "SMTP_SSL", Client)
    cfg = SimpleNamespace(
        OPS_ALERTS_ENABLED=True,
        ADMIN_NOTIFY_EMAIL="recipient@example.invalid",
        EMAIL_FROM="sender@example.invalid",
        EMAIL_PROVIDER="smtp",
        SMTP_USE_TLS=True,
        SMTP_START_TLS=False,
        SMTP_HOST="smtp.example.invalid",
        SMTP_PORT=465,
        SMTP_TIMEOUT=15,
        SMTP_USER="synthetic-user",
        SMTP_PASSWORD=password,
        RESEND_API_KEY="api-synthetic",
    )
    assert alerts.deliver(cfg, "Synthetic", "body") is True
    assert logins == [("synthetic-user", password or "api-synthetic")]
    assert len(sends) == 1


@pytest.fixture
def email_task_database(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[EmailLog.__table__])
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(email_tasks, "SessionLocal", factory)
    monkeypatch.setattr(email_tasks.settings, "EMAIL_ENABLED", True)
    with factory() as db:
        log = EmailLog(
            recipient="recipient@example.invalid",
            subject="Synthetic acceptance",
            html_body="<p>synthetic</p>",
            email_type="test",
            status=EmailLog.STATUS_PENDING,
        )
        db.add(log)
        db.commit()
        email_log_id = log.id
    yield factory, email_log_id
    engine.dispose()


def test_duplicate_email_task_does_not_send_concurrently(monkeypatch, email_task_database):
    factory, email_log_id = email_task_database
    duplicate_results = []
    sends = []

    def send_once(**_kwargs):
        sends.append(True)
        duplicate_results.append(
            email_tasks.send_email_task.apply(
                args=(email_log_id,), task_id="duplicate-task", throw=True
            ).get()
        )

    monkeypatch.setattr(email_tasks, "send_email_sync", send_once)
    result = email_tasks.send_email_task.apply(
        args=(email_log_id,), task_id="original-task", throw=True
    ).get()

    assert result["status"] == "sent"
    assert duplicate_results == [{"email_log_id": email_log_id, "status": "delivery_in_progress"}]
    assert len(sends) == 1
    with factory() as db:
        assert db.get(EmailLog, email_log_id).status == EmailLog.STATUS_SENT


def test_redelivered_task_marks_interrupted_send_unknown(monkeypatch, email_task_database):
    factory, email_log_id = email_task_database
    with factory() as db:
        log = db.get(EmailLog, email_log_id)
        log.status = EmailLog.STATUS_SENDING
        log.celery_task_id = "interrupted-task"
        db.commit()

    sends = []
    monkeypatch.setattr(email_tasks, "send_email_sync", lambda **_kwargs: sends.append(True))
    result = email_tasks.send_email_task.apply(
        args=(email_log_id,), task_id="interrupted-task", throw=True
    ).get()

    assert result["status"] == "delivery_outcome_unknown"
    assert not sends
    with factory() as db:
        assert db.get(EmailLog, email_log_id).status == EmailLog.STATUS_UNKNOWN


def test_disabled_email_task_leaves_message_pending(monkeypatch, email_task_database):
    factory, email_log_id = email_task_database
    monkeypatch.setattr(email_tasks.settings, "EMAIL_ENABLED", False)
    sends = []
    monkeypatch.setattr(email_tasks, "send_email_sync", lambda **_kwargs: sends.append(True))

    result = email_tasks.send_email_task.apply(
        args=(email_log_id,), task_id="disabled-task", throw=True
    ).get()

    assert result["status"] == "disabled"
    assert not sends
    with factory() as db:
        assert db.get(EmailLog, email_log_id).status == EmailLog.STATUS_PENDING
