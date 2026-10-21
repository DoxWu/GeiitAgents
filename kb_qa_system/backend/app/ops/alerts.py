"""Direct delivery, without main database, Redis, Celery or email_log."""

import html
import json
import logging
import math
import os
import smtplib
import ssl
import tempfile
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
            response = client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": "Bearer " + (cfg.RESEND_API_KEY or cfg.SMTP_PASSWORD),
                },
                json={
                    "from": cfg.EMAIL_FROM,
                    "to": [cfg.ADMIN_NOTIFY_EMAIL],
                    "subject": subject,
                    "html": "<pre>" + html.escape(text) + "</pre>",
                },
            )
            if not 200 <= response.status_code < 300:
                raise RuntimeError("Admin alert HTTP acceptance was not confirmed")
            try:
                payload = response.json()
            except ValueError:
                raise RuntimeError("Admin alert HTTP acceptance was not confirmed") from None
            message_id = payload.get("id") if isinstance(payload, dict) else None
            if not isinstance(message_id, str) or not message_id.strip():
                raise RuntimeError("Admin alert HTTP acceptance was not confirmed")
    elif cfg.EMAIL_PROVIDER == "smtp":
        if cfg.SMTP_USE_TLS and cfg.SMTP_START_TLS:
            raise ValueError("Choose either implicit TLS or STARTTLS")
        message = EmailMessage()
        message["From"], message["To"], message["Subject"] = (
            cfg.EMAIL_FROM,
            cfg.ADMIN_NOTIFY_EMAIL,
            subject,
        )
        message.set_content(text)
        cls = smtplib.SMTP_SSL if cfg.SMTP_USE_TLS else smtplib.SMTP
        options = {"context": ssl.create_default_context()} if cfg.SMTP_USE_TLS else {}
        with cls(cfg.SMTP_HOST, cfg.SMTP_PORT, timeout=cfg.SMTP_TIMEOUT, **options) as smtp:
            if cfg.SMTP_START_TLS:
                smtp.starttls(context=ssl.create_default_context())
            if cfg.SMTP_USER:
                smtp.login(cfg.SMTP_USER, cfg.SMTP_PASSWORD or cfg.RESEND_API_KEY)
            smtp.send_message(message)
    else:
        raise ValueError("Unsupported email provider")
    return True


class Incidents:
    def __init__(self, cfg, path=None):
        self.cfg = cfg
        self.path = Path(path or cfg.OPS_STATE_FILE)
        self.states = self._load_states()

    def _load_states(self):
        # This is a small deduplication file, not an unbounded application log.
        try:
            with self.path.open("rb") as stream:
                raw = stream.read(65537)
            if len(raw) > 65536:
                raise ValueError("Monitor state is too large")
            loaded = json.loads(raw)
            if not isinstance(loaded, dict):
                raise ValueError("Invalid monitor state root")
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, RecursionError):
            logger.warning("Monitor state unavailable or invalid; deduplication state was reset")
            return {}

        states = {}
        for component, state in loaded.items():
            try:
                valid = (
                    isinstance(state, dict)
                    and type(state.get("failures")) is int
                    and state["failures"] >= 0
                    and type(state.get("notified")) is bool
                    and type(state.get("last")) in (int, float)
                    and math.isfinite(state["last"])
                    and state["last"] >= 0
                )
            except OverflowError:
                valid = False
            if valid:
                states[component] = {key: state[key] for key in ("failures", "notified", "last")}
        if len(states) != len(loaded):
            logger.warning("Invalid monitor state entries were reset; valid entries were retained")
        return states

    def _persist(self):
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # A unique file in the same directory avoids stale .tmp collisions.
            # Close it before replace, as required on Windows.
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as stream:
                temporary = Path(stream.name)
                json.dump(self.states, stream, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            for attempt in range(3):
                try:
                    temporary.replace(self.path)
                    break
                except PermissionError as error:
                    # Antivirus/indexers may briefly hold a Windows file handle.
                    if getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 2:
                        raise
                    time.sleep(0.05 * (attempt + 1))
        except OSError:
            logger.error("Could not persist monitor state; alert deduplication is memory-only")
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove a temporary monitor state file")

    def record(self, component, healthy, detail="", now=None):
        now = time.time() if now is None else now
        state = self.states.setdefault(component, {"failures": 0, "notified": False, "last": 0})
        state["failures"] = 0 if healthy else state["failures"] + 1
        recovery = healthy and state["notified"]
        failure = (
            not healthy
            and state["failures"] >= self.cfg.OPS_FAILURE_THRESHOLD
            and (
                not state["notified"] or now - state["last"] >= self.cfg.OPS_ALERT_COOLDOWN_SECONDS
            )
        )
        if recovery or failure:
            try:
                sent = deliver(
                    self.cfg,
                    f"[GeiIt] {'恢复' if recovery else '故障'}：{component}",
                    f"实例：{self.cfg.BACKUP_SOURCE_ID}\n组件：{component}\n状态：{'恢复正常' if healthy else '异常'}\n{detail}",
                )
                if sent:
                    state.update(notified=not healthy, last=now)
            except Exception:
                logger.error(
                    "Admin alert delivery failed; will retry (credentials and provider errors omitted)"
                )
        self._persist()
