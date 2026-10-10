import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from app.middleware import prometheus_middleware as middleware_module


class MetricProbe:
    def __init__(self):
        self.calls = []

    def labels(self, **labels):
        self.calls.append(("labels", labels))
        return self

    def inc(self, amount=1):
        self.calls.append(("inc", amount))

    def dec(self, amount=1):
        self.calls.append(("dec", amount))

    def observe(self, value):
        self.calls.append(("observe", value))


def install_metric_probes(monkeypatch):
    names = (
        "http_request_duration_seconds",
        "http_requests_in_progress",
        "http_requests_total",
        "http_stream_cancelled_total",
        "http_stream_duration_seconds",
        "http_stream_first_event_seconds",
        "http_streams_in_progress",
    )
    probes = {name: MetricProbe() for name in names}
    for name, probe in probes.items():
        monkeypatch.setattr(middleware_module, name, probe)
    monkeypatch.setattr(middleware_module, "is_prometheus_enabled", lambda: True)
    monkeypatch.setattr(middleware_module, "record_db_pool_metrics", lambda: None)
    monkeypatch.setattr(middleware_module.settings, "PROMETHEUS_INCLUDE_PATH_LABEL", True)
    return probes


def make_scope(path="/items/17"):
    return {"type": "http", "method": "GET", "path": path, "headers": []}


def test_sse_metrics_cover_full_response_and_use_route_template(monkeypatch):
    probes = install_metric_probes(monkeypatch)
    sent = []

    async def app(scope, receive, send):
        scope["route"] = SimpleNamespace(path="/items/{item_id}")
        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/event-stream")],
        })
        await send({"type": "http.response.body", "body": b"data: first\n\n", "more_body": True})
        await send({"type": "http.response.body", "body": b"data: done\n\n", "more_body": False})

    async def send(message):
        sent.append(message)

    asyncio.run(middleware_module.PrometheusMiddleware(app)(make_scope(), lambda: None, send))

    endpoint_labels = [
        labels["endpoint"]
        for name in ("http_requests_total", "http_stream_duration_seconds")
        for kind, labels in probes[name].calls
        if kind == "labels"
    ]
    assert endpoint_labels == ["/items/{item_id}", "/items/{item_id}"]
    assert any(kind == "observe" for kind, _ in probes["http_stream_duration_seconds"].calls)
    assert any(kind == "observe" for kind, _ in probes["http_stream_first_event_seconds"].calls)
    assert ("dec", 1) in probes["http_streams_in_progress"].calls
    assert ("dec", 1) in probes["http_requests_in_progress"].calls
    assert len(sent) == 3


def test_sse_cancellation_records_cancel_status_and_releases_gauges(monkeypatch):
    probes = install_metric_probes(monkeypatch)

    async def app(scope, receive, send):
        scope["route"] = SimpleNamespace(path="/stream")
        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/event-stream")],
        })
        await send({"type": "http.response.body", "body": b"data: first\n\n", "more_body": True})
        raise asyncio.CancelledError

    async def send(message):
        return None

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(middleware_module.PrometheusMiddleware(app)(make_scope("/stream"), lambda: None, send))

    request_labels = [
        labels for kind, labels in probes["http_requests_total"].calls if kind == "labels"
    ]
    assert request_labels == [{"method": "GET", "endpoint": "/stream", "status": "499"}]
    assert any(kind == "inc" for kind, _ in probes["http_stream_cancelled_total"].calls)
    assert ("dec", 1) in probes["http_streams_in_progress"].calls
    assert ("dec", 1) in probes["http_requests_in_progress"].calls


def load_alertmanager_renderer():
    path = Path(__file__).parents[2] / "monitoring" / "alertmanager" / "render_config.py"
    spec = importlib.util.spec_from_file_location("alertmanager_render_config", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_alertmanager_renderer_quotes_environment_values_as_yaml_scalars(tmp_path, monkeypatch):
    renderer = load_alertmanager_renderer()
    template = tmp_path / "template.yml"
    output = tmp_path / "alertmanager.yml"
    template.write_text(
        "receivers:\n  - email_configs:\n      - to: @@ALERT_EMAIL_TO@@\n"
        "        from: @@ALERT_EMAIL_FROM@@\n        smarthost: @@SMTP_ADDRESS@@\n"
        "        auth_username: @@SMTP_USER@@\n        auth_password: @@SMTP_PASSWORD@@\n",
        encoding="utf-8",
    )
    values = {
        "ALERT_EMAIL_TO": "alerts: team #1@example.test",
        "ALERT_EMAIL_FROM": 'Example: "Ops" <ops@example.test>',
        "SMTP_USER": "user #2",
        "SMTP_PASSWORD": "line one\nline: two #literal",
        "SMTP_HOST": "smtp.example.test",
        "SMTP_PORT": "587",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)

    renderer.render(template, output)
    parsed = yaml.safe_load(output.read_text(encoding="utf-8"))
    email = parsed["receivers"][0]["email_configs"][0]
    assert email["to"] == values["ALERT_EMAIL_TO"]
    assert email["from"] == values["ALERT_EMAIL_FROM"]
    assert email["smarthost"] == "smtp.example.test:587"
    assert email["auth_username"] == values["SMTP_USER"]
    assert email["auth_password"] == values["SMTP_PASSWORD"]


@pytest.mark.parametrize("host", ["bad host", "smtp.example.test\nattacker.test", "-invalid"])
def test_alertmanager_renderer_rejects_invalid_smtp_hosts(tmp_path, monkeypatch, host):
    renderer = load_alertmanager_renderer()
    template = tmp_path / "template.yml"
    output = tmp_path / "alertmanager.yml"
    template.write_text("receivers: []\n", encoding="utf-8")
    monkeypatch.setenv("SMTP_HOST", host)

    with pytest.raises(ValueError, match="SMTP_HOST"):
        renderer.render(template, output)


@pytest.mark.parametrize("port", ["0", "65536", "587\nsmuggled"])
def test_alertmanager_renderer_rejects_invalid_smtp_ports(tmp_path, monkeypatch, port):
    renderer = load_alertmanager_renderer()
    template = tmp_path / "template.yml"
    output = tmp_path / "alertmanager.yml"
    template.write_text("receivers: []\n", encoding="utf-8")
    monkeypatch.setenv("SMTP_PORT", port)

    with pytest.raises(ValueError, match="SMTP_PORT"):
        renderer.render(template, output)


def test_prometheus_scrape_uses_runtime_api_credentials():
    monitoring_dir = Path(__file__).parents[2] / "monitoring"
    prometheus = yaml.safe_load((monitoring_dir / "prometheus.yml").read_text(encoding="utf-8"))
    scrape = next(job for job in prometheus["scrape_configs"] if job["job_name"] == "kb_qa_api")
    assert scrape["basic_auth"] == {
        "username": "$PROMETHEUS_AUTH_USER",
        "password": "$PROMETHEUS_AUTH_PASSWORD",
    }

    compose = yaml.safe_load(
        (monitoring_dir / "docker-compose.monitoring.yml").read_text(encoding="utf-8")
    )
    service = compose["services"]["prometheus"]
    assert "--config.expand-env" in service["command"]
    assert service["environment"]["PROMETHEUS_AUTH_USER"] == "${PROMETHEUS_AUTH_USER:-prometheus}"
    assert service["environment"]["PROMETHEUS_AUTH_PASSWORD"] == "${PROMETHEUS_AUTH_PASSWORD:-}"
