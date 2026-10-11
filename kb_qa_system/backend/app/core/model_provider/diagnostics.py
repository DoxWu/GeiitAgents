"""Bounded diagnostics for third-party model provider failures."""


def safe_error_label(exc: BaseException) -> str:
    """Return a short status label without response bodies, URLs, or headers."""
    status = getattr(exc, "status_code", None)
    if status is not None:
        try:
            return f"http_{int(status)}"
        except (TypeError, ValueError):
            pass
    try:
        import httpx

        if isinstance(exc, httpx.TimeoutException):
            return "timeout"
        if isinstance(exc, httpx.RequestError):
            return "connection_error"
    except ImportError:
        pass
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, (ConnectionError, OSError)):
        return "connection_error"
    return type(exc).__name__
