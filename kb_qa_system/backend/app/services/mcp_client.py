"""Credential-free HTTPS Streamable HTTP MCP. No process spawning or redirects."""
import json
import time
from uuid import uuid4
from app.core.public_http import public_request


def call_mcp(endpoint: str, tool: str, inputs: dict) -> dict:
    deadline = time.monotonic() + 20
    session_id = None
    protocol_version = "2025-03-26"

    def request(method, params=None, notification=False):
        nonlocal session_id
        if time.monotonic() >= deadline:
            raise ValueError("MCP deadline exceeded")
        call_id = str(uuid4())
        body = {"jsonrpc": "2.0", "method": method}
        if not notification:
            body["id"] = call_id
        if params is not None:
            body["params"] = params
        headers = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": protocol_version}
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        response = public_request("POST", endpoint, headers=headers, json=body, timeout=min(5, max(.1, deadline-time.monotonic())))
        try:
            if response.status_code not in (200, 202, 204):
                raise ValueError("MCP request failed")
            sid = response.headers.get("Mcp-Session-Id")
            if sid:
                if len(sid) > 200 or any(ord(c) < 33 or ord(c) > 126 for c in sid):
                    raise ValueError("Invalid MCP session")
                session_id = sid
            if notification:
                return None
            raw = bytearray()
            for chunk in response.iter_content(4096):
                raw.extend(chunk)
                if len(raw) > 131072 or time.monotonic() >= deadline:
                    raise ValueError("MCP response limit exceeded")
                if "text/event-stream" in response.headers.get("Content-Type", ""):
                    # A response stream may stay open. Finish at the matching JSON-RPC result.
                    for frame in bytes(raw).replace(b"\r\n", b"\n").split(b"\n\n")[:-1]:
                        data = "\n".join(line[5:].lstrip() for line in frame.decode("utf-8").splitlines() if line.startswith("data:"))
                        if data:
                            item = json.loads(data)
                            if isinstance(item, dict) and item.get("id") == call_id:
                                if item.get("jsonrpc") != "2.0" or "error" in item or not isinstance(item.get("result"), dict):
                                    raise ValueError("MCP remote error")
                                return item["result"]
            item = json.loads(raw)
            if not isinstance(item, dict) or item.get("jsonrpc") != "2.0" or item.get("id") != call_id or "error" in item or not isinstance(item.get("result"), dict):
                raise ValueError("Invalid MCP response")
            return item["result"]
        finally:
            response.close()

    initialized = request("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "GeiitAgents", "version": "1"}})
    if not isinstance(initialized, dict) or initialized.get("protocolVersion") not in ("2024-11-05", "2025-03-26", "2025-06-18"):
        raise ValueError("Unsupported MCP protocol")
    protocol_version = initialized["protocolVersion"]
    request("notifications/initialized", notification=True)
    result = request("tools/call", {"name": tool, "arguments": inputs})
    if result.get("isError"):
        raise ValueError("MCP tool failed")
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    text = "".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("MCP tool must return object")
    return parsed
