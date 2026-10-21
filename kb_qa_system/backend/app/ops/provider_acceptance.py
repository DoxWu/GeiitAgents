"""One-shot provider and email acceptance checks using process environment only."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import smtplib
import ssl
import sys
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import urlparse

import httpx
import yaml
from openai import OpenAI

BACKEND_DIR = Path(__file__).resolve().parents[2]
PROVIDER_CONFIG = BACKEND_DIR / "app" / "core" / "model_provider" / "providers.yaml"
PLACEHOLDER = re.compile(r"\$\{([^${}:]+)(?::([^${}]*))?\}")


def resolve_environment(text: str) -> str:
    """Resolve providers.yaml placeholders without loading backend settings or .env."""
    for _ in range(10):
        updated = PLACEHOLDER.sub(
            lambda match: os.environ.get(match.group(1), match.group(2) or ""), text
        )
        if updated == text:
            return text
        text = updated
    return text


def load_provider_config() -> dict:
    raw = yaml.safe_load(resolve_environment(PROVIDER_CONFIG.read_text(encoding="utf-8")))
    if not isinstance(raw, dict) or not isinstance(raw.get("providers"), dict):
        raise ValueError("provider configuration shape is invalid")
    return raw["providers"]


def is_enabled(endpoint: dict) -> bool:
    value = endpoint.get("enabled", True)
    return value is True or str(value).strip().lower() in {"true", "1", "yes", "on"}


def endpoint(providers: dict, model_type: str, name: str) -> dict:
    candidates = providers.get(model_type, [])
    return next((item for item in candidates if item.get("name") == name), {})


def validate_endpoint(item: dict, label: str, vendor: str) -> list[str]:
    missing = [key for key in ("model", "api_key", "api_base") if not item.get(key)]
    if missing:
        return [f"{label}: missing configured {', '.join(missing)}"]
    parsed = urlparse(item["api_base"])
    if parsed.scheme != "https" or not parsed.hostname:
        return [f"{label}: endpoint must use HTTPS"]
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return [f"{label}: endpoint must not include user info, query parameters, or fragments"]
    host = parsed.hostname.lower().rstrip(".")
    if vendor == "aliyun" and not host.endswith(".aliyuncs.com"):
        return [f"{label}: endpoint host does not match the selected Aliyun provider"]
    if vendor == "deepseek" and not (host == "deepseek.com" or host.endswith(".deepseek.com")):
        return [f"{label}: endpoint host does not match the selected DeepSeek provider"]
    return []


def safe_failure(error: BaseException) -> str:
    status = getattr(error, "status_code", None)
    if status == 401 or status == 403:
        return "unauthorized"
    if status == 429:
        return "rate_limited"
    if isinstance(error, (TimeoutError, httpx.TimeoutException)):
        return "timeout"
    if isinstance(error, smtplib.SMTPResponseException):
        return f"smtp_{error.smtp_code}"
    if isinstance(error, (smtplib.SMTPServerDisconnected, ConnectionError)):
        return "connection_error"
    if isinstance(error, (httpx.RequestError,)):
        return "connection_error"
    if status is not None:
        return f"http_{status}"
    return type(error).__name__


def probe_chat(item: dict, label: str) -> None:
    client = OpenAI(api_key=item["api_key"], base_url=item["api_base"], timeout=30, max_retries=0)
    try:
        response = client.chat.completions.create(
            model=item["model"],
            messages=[{"role": "user", "content": "Reply with OK. Synthetic acceptance probe."}],
            max_tokens=256,
            temperature=0,
        )
        if not response.choices or not response.choices[0].message.content:
            raise ValueError("empty_completion")
        print(f"PASS {label}: chat completion")
    except Exception as error:
        status = safe_failure(error)
        print(f"FAIL {label}: {status}")
        raise RuntimeError(f"{label}:{status}") from None
    finally:
        client.close()


def probe_tools(item: dict, label: str) -> None:
    client = OpenAI(api_key=item["api_key"], base_url=item["api_base"], timeout=30, max_retries=0)
    tool = {
        "type": "function",
        "function": {
            "name": "acceptance_probe",
            "description": "Return the fixed acceptance marker.",
            "parameters": {
                "type": "object",
                "properties": {"marker": {"type": "string"}},
                "required": ["marker"],
                "additionalProperties": False,
            },
        },
    }
    try:
        response = client.chat.completions.create(
            model=item["model"],
            messages=[{"role": "user", "content": "Call acceptance_probe with marker set to ok."}],
            tools=[tool],
            tool_choice="auto",
            max_tokens=256,
            temperature=0,
        )
        calls = response.choices[0].message.tool_calls if response.choices else None
        if not calls or len(calls) != 1 or calls[0].function.name != "acceptance_probe":
            raise ValueError("tool_call_not_returned")
        if json.loads(calls[0].function.arguments) != {"marker": "ok"}:
            raise ValueError("tool_arguments_invalid")
        print(f"PASS {label}: tool calling")
    except Exception as error:
        status = safe_failure(error)
        print(f"FAIL {label}: tool_call_{status}")
        raise RuntimeError(f"{label}:tool_call_{status}") from None
    finally:
        client.close()


def probe_embedding(item: dict, label: str, expected_dimension: int) -> None:
    client = OpenAI(api_key=item["api_key"], base_url=item["api_base"], timeout=30, max_retries=0)
    request: dict = {
        "model": item["model"],
        "input": "GeiIt provider acceptance probe; synthetic text only.",
    }
    if str(item.get("supports_dimensions", False)).strip().lower() in {"true", "1", "yes", "on"}:
        request["dimensions"] = expected_dimension
    try:
        response = client.embeddings.create(**request)
        if len(response.data) != 1:
            raise ValueError("embedding_count_mismatch")
        vector = response.data[0].embedding
        actual = len(vector)
        if actual != expected_dimension:
            raise ValueError("embedding_dimension_mismatch")
        configured = int(item.get("dimension") or 0)
        if configured != expected_dimension:
            raise ValueError("configured_dimension_mismatch")
        if not all(
            isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)
            for value in vector
        ) or not any(vector):
            raise ValueError("embedding_values_invalid")
        print(f"PASS {label}: embedding dimension={actual}")
    except Exception as error:
        status = safe_failure(error)
        print(f"FAIL {label}: {status}")
        raise RuntimeError(f"{label}:{status}") from None
    finally:
        client.close()


def send_resend_test(recipient: str) -> str:
    api_key = os.environ.get("RESEND_API_KEY") or os.environ.get("SMTP_PASSWORD", "")
    sender = os.environ.get("EMAIL_FROM", "")
    if not api_key or not sender:
        raise ValueError("Resend requires RESEND_API_KEY or SMTP_PASSWORD, and EMAIL_FROM")
    payload = {
        "from": sender,
        "to": [recipient],
        "subject": "GeiIt deployment acceptance test",
        "html": "<p>This is a one-time deployment acceptance test. No account data was included.</p>",
    }
    try:
        with httpx.Client(timeout=httpx.Timeout(20, connect=8), follow_redirects=False) as client:
            response = client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload,
            )
    except (httpx.TimeoutException, httpx.RequestError) as error:
        return f"unknown:{safe_failure(error)}"
    if response.status_code >= 500:
        return f"unknown:http_{response.status_code}"
    if response.status_code >= 400:
        return f"rejected:http_{response.status_code}"
    if not 200 <= response.status_code < 300:
        return f"unknown:http_{response.status_code}"
    try:
        message_id = response.json().get("id")
    except (ValueError, AttributeError):
        message_id = None
    return (
        "accepted"
        if isinstance(message_id, str) and message_id.strip()
        else "unknown:missing_provider_id"
    )


def preflight_smtp(recipient: str) -> list[str]:
    issues: list[str] = []
    for name in ("SMTP_HOST", "EMAIL_FROM"):
        if not os.environ.get(name):
            issues.append(f"{name}: missing")
    if not (os.environ.get("SMTP_PASSWORD") or os.environ.get("RESEND_API_KEY")):
        issues.append("SMTP_PASSWORD or RESEND_API_KEY: missing")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", recipient):
        issues.append("email recipient: invalid address")
    try:
        port = int(os.environ.get("SMTP_PORT", "465"))
        if not 1 <= port <= 65535:
            raise ValueError
    except ValueError:
        issues.append("SMTP_PORT: must be between 1 and 65535")
    use_tls = os.environ.get("SMTP_USE_TLS", "true").lower() in {"true", "1", "yes", "on"}
    start_tls = os.environ.get("SMTP_START_TLS", "false").lower() in {"true", "1", "yes", "on"}
    if use_tls and start_tls:
        issues.append("SMTP_USE_TLS and SMTP_START_TLS: choose one TLS mode")
    return issues


def send_smtp_test(recipient: str) -> str:
    message = EmailMessage()
    message["From"] = os.environ["EMAIL_FROM"]
    message["To"] = recipient
    message["Subject"] = "GeiIt deployment acceptance test"
    message.set_content(
        "This is a one-time deployment acceptance test. No account or business data was included."
    )
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "465"))
    timeout = int(os.environ.get("SMTP_TIMEOUT", "15"))
    use_tls = os.environ.get("SMTP_USE_TLS", "true").lower() in {"true", "1", "yes", "on"}
    start_tls = os.environ.get("SMTP_START_TLS", "false").lower() in {"true", "1", "yes", "on"}
    client_type = smtplib.SMTP_SSL if use_tls else smtplib.SMTP
    options = {"context": ssl.create_default_context()} if use_tls else {}
    try:
        with client_type(host, port, timeout=timeout, **options) as client:
            if start_tls:
                client.starttls(context=ssl.create_default_context())
            username = os.environ.get("SMTP_USER", "")
            if username:
                client.login(
                    username, os.environ.get("SMTP_PASSWORD") or os.environ["RESEND_API_KEY"]
                )
            refused = client.send_message(message)
    except smtplib.SMTPRecipientsRefused:
        return "rejected:recipient_refused"
    except smtplib.SMTPResponseException as error:
        return f"rejected:{safe_failure(error)}"
    except (TimeoutError, httpx.TimeoutException) as error:
        return f"unknown:{safe_failure(error)}"
    except (smtplib.SMTPServerDisconnected, ConnectionError, OSError) as error:
        return f"unknown:{safe_failure(error)}"
    except Exception as error:
        return f"unknown:{safe_failure(error)}"
    return "rejected:recipient_refused" if refused else "accepted"


def preflight(providers: dict) -> list[str]:
    issues: list[str] = []
    primary_llm = endpoint(providers, "llm", "primary")
    backup_llm = endpoint(providers, "llm", "fallback")
    embedding = endpoint(providers, "embedding", "primary")
    issues.extend(validate_endpoint(primary_llm, "aliyun_primary_llm", "aliyun"))
    issues.extend(validate_endpoint(embedding, "aliyun_embedding", "aliyun"))
    issues.extend(validate_endpoint(backup_llm, "deepseek_backup_llm", "deepseek"))
    if not is_enabled(backup_llm):
        issues.append("deepseek_backup_llm: endpoint is disabled")
    if is_enabled(endpoint(providers, "embedding", "cloud_fallback")):
        issues.append(
            "embedding fallback must be disabled unless a compatible embedding service is configured"
        )
    try:
        expected_dimension = int(os.environ.get("EMBEDDING_DIMENSION", ""))
        if expected_dimension < 1:
            raise ValueError
    except ValueError:
        expected_dimension = 0
        issues.append("EMBEDDING_DIMENSION: set a positive integer matching the pgvector column")
    try:
        configured_dimension = int(embedding.get("dimension"))
    except (TypeError, ValueError):
        configured_dimension = 0
    if configured_dimension < 1:
        issues.append("aliyun_embedding: configured dimension is invalid")
    elif expected_dimension and configured_dimension != expected_dimension:
        issues.append("aliyun_embedding: configured dimension does not match EMBEDDING_DIMENSION")
    return issues


def verify_database_dimension(expected: int) -> tuple[bool, str]:
    dsn = os.environ.get("DATABASE_URL", "")
    if not dsn:
        return False, "DATABASE_URL missing"
    if dsn.startswith("postgresql+psycopg://"):
        dsn = "postgresql://" + dsn.removeprefix("postgresql+psycopg://")
    try:
        import psycopg

        with psycopg.connect(dsn, connect_timeout=8) as connection:
            with connection.transaction():
                connection.execute("SET TRANSACTION READ ONLY")
                row = connection.execute(
                    "SELECT format_type(a.atttypid, a.atttypmod) "
                    "FROM pg_catalog.pg_attribute AS a "
                    "WHERE a.attrelid = pg_catalog.to_regclass('document_chunks') "
                    "AND a.attname = 'content_vector' AND a.attnum > 0 "
                    "AND NOT a.attisdropped"
                ).fetchone()
        match = re.fullmatch(r"vector\((\d+)\)", row[0] if row else "")
        if not match:
            return False, "content_vector schema is missing or dimensioned unexpectedly"
        actual = int(match.group(1))
        if actual != expected:
            return False, f"database_dimension_mismatch:{actual}"
        return True, f"database_dimension={actual}"
    except Exception as error:
        return False, f"database_check_{safe_failure(error)}"


def preflight_resend(recipient: str) -> list[str]:
    issues = []
    if not (os.environ.get("RESEND_API_KEY") or os.environ.get("SMTP_PASSWORD")):
        issues.append("RESEND_API_KEY or SMTP_PASSWORD: missing")
    if not os.environ.get("EMAIL_FROM"):
        issues.append("EMAIL_FROM: missing")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", recipient):
        issues.append("email recipient: invalid address")
    return issues


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run one-shot provider and email deployment checks using environment variables only."
    )
    parser.add_argument(
        "--preflight", action="store_true", help="check configuration without network calls"
    )
    parser.add_argument(
        "--live", action="store_true", help="send synthetic model probes and one test email"
    )
    parser.add_argument(
        "--email-provider",
        choices=("http", "smtp"),
        default=os.environ.get("EMAIL_PROVIDER", "http").lower(),
        help="email transport for the one-time test",
    )
    parser.add_argument("--email-to", help="recipient; defaults to ADMIN_NOTIFY_EMAIL")
    args = parser.parse_args()
    if args.live == args.preflight:
        parser.error("choose exactly one of --preflight or --live")
    recipient = args.email_to or os.environ.get("ADMIN_NOTIFY_EMAIL", "")
    if args.live and not recipient:
        parser.error("--email-to or ADMIN_NOTIFY_EMAIL is required with --live")
    if args.live and os.environ.get("EMAIL_ENABLED", "").lower() not in {"true", "1", "yes", "on"}:
        parser.error("EMAIL_ENABLED must be enabled before live acceptance")

    try:
        providers = load_provider_config()
    except Exception as error:
        print(f"FAIL configuration: {safe_failure(error)}")
        return 2
    issues = preflight(providers)
    if args.live:
        issues.extend(
            preflight_resend(recipient)
            if args.email_provider == "http"
            else preflight_smtp(recipient)
        )
    if issues:
        for issue in issues:
            print(f"FAIL preflight: {issue}")
        return 2
    print("PASS preflight: Aliyun primary LLM/Embedding and DeepSeek LLM fallback are configured")
    if args.preflight:
        print("INFO vision: not configured and not tested")
        print("INFO data processing region/retention: deployment operator must verify separately")
        return 0

    primary = endpoint(providers, "llm", "primary")
    backup = endpoint(providers, "llm", "fallback")
    embedding = endpoint(providers, "embedding", "primary")
    dimension = int(os.environ["EMBEDDING_DIMENSION"])
    database_ok, database_status = verify_database_dimension(dimension)
    if not database_ok:
        print(f"FAIL embedding schema: {database_status}")
        return 2
    print(f"PASS embedding schema: {database_status}")
    failed = False
    for check in (
        lambda: probe_chat(primary, "aliyun_primary_llm"),
        lambda: probe_tools(primary, "aliyun_primary_llm"),
        lambda: probe_chat(backup, "deepseek_backup_llm"),
        lambda: probe_tools(backup, "deepseek_backup_llm"),
        lambda: probe_embedding(embedding, "aliyun_embedding", dimension),
    ):
        try:
            check()
        except RuntimeError:
            failed = True

    email_result = (
        send_resend_test(recipient) if args.email_provider == "http" else send_smtp_test(recipient)
    )
    if email_result == "accepted":
        print(
            f"PASS {args.email_provider}: server accepted the one-time test message; check the recipient inbox"
        )
    elif email_result.startswith("unknown:"):
        event_source = (
            "Resend Events"
            if args.email_provider == "http"
            else "the SMTP provider's delivery logs"
        )
        print(
            f"UNKNOWN {args.email_provider}: {email_result[8:]}; check {event_source} before any retry"
        )
        failed = True
    else:
        print(
            f"FAIL {args.email_provider}: {email_result}; check configuration without sharing credentials"
        )
        failed = True
    print("INFO vision: not configured and not tested")
    print(
        "INFO application failover routing: static regression tests cover routing; live probe called each endpoint directly"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
