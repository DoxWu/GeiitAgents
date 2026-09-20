"""Direct delivery, without main database, Redis, Celery or email_log."""
import html
import json
import logging
import smtplib
import ssl
import time
from email.message import EmailMessage
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)


def deliver(cfg, subject, text):
    if not cfg.OPS_ALERTS_ENABLED:
        return False
    if not cfg.ADMIN_NOTIFY_EMAIL or not cfg.EMAIL_FROM:
        raise ValueError("Alert sender/recipient not configured")
    if cfg.EMAIL_PROVIDER == "http":
        with httpx.Client(timeout=15, follow_redirects=False) as client:
            response = client.post("https://api.resend.com/emails", headers={
                "Authorization": "Bearer " + (cfg.RESEND_API_KEY or cfg.SMTP_PASSWORD),
            }, json={"from": cfg.EMAIL_FROM, "to": [cfg.ADMIN_NOTIFY_EMAIL], "subject": subject,
                     "html": "<pre>" + html.escape(text) + "</pre>"})
            response.raise_for_status()
    elif cfg.EMAIL_PROVIDER == "smtp":
        if cfg.SMTP_USE_TLS and cfg.SMTP_START_TLS:
            raise ValueError("Choose either implicit TLS or STARTTLS")
        message = EmailMessage()
        message["From"], message["To"], message["Subject"] = cfg.EMAIL_FROM, cfg.ADMIN_NOTIFY_EMAIL, subject
        message.set_content(text)
        cls = smtplib.SMTP_SSL if cfg.SMTP_USE_TLS else smtplib.SMTP
        options = {"context": ssl.create_default_context()} if cfg.SMTP_USE_TLS else {}
        with cls(cfg.SMTP_HOST, cfg.SMTP_PORT, timeout=cfg.SMTP_TIMEOUT, **options) as smtp:
            if cfg.SMTP_START_TLS:
                smtp.starttls(context=ssl.create_default_context())
            if cfg.SMTP_USER:
                smtp.login(cfg.SMTP_USER, cfg.SMTP_PASSWORD)
            smtp.send_message(message)
    else:
        raise ValueError("Unsupported email provider")
    return True


class Incidents:
    def __init__(self, cfg, path=None):
        self.cfg = cfg
        self.path = Path(path or cfg.OPS_STATE_FILE)
        try:
            self.states = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.states = {}

    def record(self, component, healthy, detail="", now=None):
        now = time.time() if now is None else now
        state = self.states.setdefault(component, {"failures": 0, "notified": False, "last": 0})
        state["failures"] = 0 if healthy else state["failures"] + 1
        recovery = healthy and state["notified"]
        failure = not healthy and state["failures"] >= self.cfg.OPS_FAILURE_THRESHOLD and (
            not state["notified"] or now - state["last"] >= self.cfg.OPS_ALERT_COOLDOWN_SECONDS)
        if recovery or failure:
            try:
                sent = deliver(self.cfg, f"[GeiIt] {'恢复' if recovery else '故障'}：{component}",
                               f"实例：{self.cfg.BACKUP_SOURCE_ID}\n组件：{component}\n状态：{'恢复正常' if healthy else '异常'}\n{detail}")
                if sent:
                    state.update(notified=not healthy, last=now)
            except Exception:
                logger.error("Admin alert delivery failed; will retry (credentials and provider errors omitted)")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self.states), encoding="utf-8")
            temporary.replace(self.path)
        except OSError:
            logger.error("Could not persist monitor state; alert deduplication is memory-only")
