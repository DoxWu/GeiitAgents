"""Prometheus instrumentation that records the complete ASGI response lifecycle."""

import time
from typing import Any

from app.core.config import settings
from app.core.prometheus_metrics import (
    http_request_duration_seconds,
    http_requests_in_progress,
    http_requests_total,
    http_stream_cancelled_total,
    http_stream_duration_seconds,
    http_stream_first_event_seconds,
    http_streams_in_progress,
    is_prometheus_enabled,
    record_db_pool_metrics,
)


def _endpoint_label(scope: dict[str, Any]) -> str:
    if not settings.PROMETHEUS_INCLUDE_PATH_LABEL:
        return "unlabeled"
    route = scope.get("route")
    return getattr(route, "path", None) or "unmatched"


class PrometheusMiddleware:
    """ASGI middleware; labels are read after routing and streams end at final body."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not is_prometheus_enabled():
            await self.app(scope, receive, send)
            return

        if scope.get("path") == settings.PROMETHEUS_METRICS_PATH:
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET")
        started = time.perf_counter()
        status = 500
        response_started = False
        is_stream = False
        first_event_recorded = False
        completed = False
        endpoint = "unmatched"

        http_requests_in_progress.inc()
        record_db_pool_metrics()

        def record_completion(final_status: int) -> None:
            nonlocal completed
            if completed:
                return
            completed = True
            duration = time.perf_counter() - started
            label = _endpoint_label(scope)
            http_requests_total.labels(
                method=method, endpoint=label, status=str(final_status)
            ).inc()
            http_request_duration_seconds.labels(
                method=method, endpoint=label
            ).observe(duration)
            if is_stream:
                http_stream_duration_seconds.labels(
                    endpoint=label, status=str(final_status)
                ).observe(duration)
                http_streams_in_progress.labels(endpoint=label).dec()
            http_requests_in_progress.dec()

        async def send_instrumented(message):
            nonlocal status, response_started, is_stream, first_event_recorded, endpoint
            if message["type"] == "http.response.start":
                response_started = True
                status = int(message["status"])
                endpoint = _endpoint_label(scope)
                headers = dict(message.get("headers", []))
                content_type = headers.get(b"content-type", b"").lower()
                is_stream = b"text/event-stream" in content_type
                if is_stream:
                    http_streams_in_progress.labels(endpoint=endpoint).inc()

            if (
                is_stream
                and not first_event_recorded
                and message["type"] == "http.response.body"
                and message.get("body")
            ):
                first_event_recorded = True
                http_stream_first_event_seconds.labels(endpoint=endpoint).observe(
                    time.perf_counter() - started
                )

            await send(message)
            if (
                message["type"] == "http.response.body"
                and not message.get("more_body", False)
            ):
                record_completion(status)

        try:
            await self.app(scope, receive, send_instrumented)
            record_completion(status)
        except BaseException:
            if not completed:
                if is_stream and response_started:
                    http_stream_cancelled_total.labels(endpoint=_endpoint_label(scope)).inc()
                    record_completion(499)
                else:
                    record_completion(status if response_started else 500)
            raise
