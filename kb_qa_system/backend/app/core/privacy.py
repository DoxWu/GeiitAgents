"""Drop transient model requests from error and tracing exports."""


def filter_monitoring_event(event, hint):
    request = event.get("request", {})
    if "/private-models/" in request.get("url", "") or "/private-models/" in event.get("transaction", ""):
        return None
    headers = request.get("headers", {})
    if isinstance(headers, dict):
        request["headers"] = {
            name: value for name, value in headers.items()
            if name.lower() not in ("authorization", "cookie", "x-model-api-key")
        }
    return event
