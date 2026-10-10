#!/usr/bin/env python3
"""Render controlled SMTP values as YAML-compatible JSON scalar strings."""

import json
import os
import re
import sys
from pathlib import Path


def render(template_path: Path, output_path: Path) -> None:
    values = {
        "@@ALERT_EMAIL_TO@@": os.getenv("ALERT_EMAIL_TO", "admin@example.com"),
        "@@ALERT_EMAIL_FROM@@": os.getenv(
            "ALERT_EMAIL_FROM", "GeiIt企业知识库 <onboarding@resend.dev>"
        ),
        "@@SMTP_USER@@": os.getenv("SMTP_USER", "resend"),
        "@@SMTP_PASSWORD@@": os.getenv("SMTP_PASSWORD", ""),
    }
    host = os.getenv("SMTP_HOST", "smtp.resend.com")
    port = os.getenv("SMTP_PORT", "587")
    label = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    if len(host) > 253 or not re.fullmatch(rf"{label}(?:\.{label})*", host):
        raise ValueError("SMTP_HOST must be a hostname")
    if not re.fullmatch(r"[0-9]{1,5}", port) or not 1 <= int(port) <= 65535:
        raise ValueError("SMTP_PORT must be a valid TCP port")
    values["@@SMTP_ADDRESS@@"] = f"{host}:{port}"

    rendered = template_path.read_text(encoding="utf-8")
    for placeholder, value in values.items():
        rendered = rendered.replace(placeholder, json.dumps(value, ensure_ascii=False))
    if "@@" in rendered:
        raise ValueError("Alertmanager template contains an unresolved placeholder")

    fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    if hasattr(os, "fchmod"):
        os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(rendered)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: render_config.py TEMPLATE OUTPUT")
    render(Path(sys.argv[1]), Path(sys.argv[2]))
