"""Independent monitor fault recovery; no database, real mail or environment file."""

import errno
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import httpx
import pytest

from app.ops import alerts


@pytest.fixture
def monitor(tmp_path, monkeypatch):
    cfg = SimpleNamespace(
        OPS_STATE_FILE=str(tmp_path / "state.json"),
        OPS_FAILURE_THRESHOLD=2,
        OPS_ALERT_COOLDOWN_SECONDS=60,
        BACKUP_SOURCE_ID="synthetic",
    )
    send = Mock(return_value=True)
    monkeypatch.setattr(alerts, "deliver", send)
    return cfg, Path(cfg.OPS_STATE_FILE), send


@pytest.mark.parametrize(
    "raw",
    [b"[]", b"null", b"42", b"{", b"\xff", b"oversized", b"deep"],
    ids=["list", "null", "number", "truncated", "invalid-utf8", "oversized", "deep"],
)
def test_invalid_state_file_does_not_stop_monitor(monitor, caplog, raw):
    cfg, path, send = monitor
    if raw == b"oversized":
        raw = b" " * 65537
    elif raw == b"deep":
        raw = b"[" * 1500 + b"0" + b"]" * 1500
    path.write_bytes(raw)
    incidents = alerts.Incidents(cfg)
    incidents.record("database", False, now=1)
    incidents.record("database", False, now=2)
    assert send.call_count == 1
    assert json.loads(path.read_text())["database"]["notified"] is True
    assert "deduplication state was reset" in caplog.text


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        [],
        {},
        {"failures": "2", "notified": False, "last": 0},
        {"failures": -1, "notified": False, "last": 0},
        {"failures": True, "notified": False, "last": 0},
        {"failures": 1, "notified": "false", "last": 0},
        {"failures": 1, "notified": False, "last": True},
        {"failures": 1, "notified": False, "last": -1},
        {"failures": 1, "notified": False, "last": float("nan")},
        {"failures": 1, "notified": False, "last": float("inf")},
        {"failures": 1, "notified": False, "last": 10**400},
    ],
)
def test_bad_entry_does_not_discard_other_component_cooldown(monitor, invalid, caplog):
    cfg, path, send = monitor
    path.write_text(
        json.dumps(
            {
                "database": invalid,
                "redis": {"failures": 2, "notified": True, "last": 2},
            }
        ),
        encoding="utf-8",
    )
    incidents = alerts.Incidents(cfg)
    incidents.record("redis", False, now=3)
    assert send.call_count == 0
    incidents.record("database", False, now=3)
    incidents.record("database", False, now=4)
    assert send.call_count == 1
    assert "valid entries were retained" in caplog.text


def test_unreadable_state_uses_memory_without_leaking_error(monitor, monkeypatch, caplog):
    cfg, path, send = monitor
    monkeypatch.setattr(Path, "open", Mock(side_effect=PermissionError("private-error")))
    incidents = alerts.Incidents(cfg)
    incidents.record("database", False, now=1)
    incidents.record("database", False, now=2)
    incidents.record("database", False, now=3)
    assert send.call_count == 1
    assert "private-error" not in caplog.text
    assert "deduplication state was reset" in caplog.text


def test_unique_temp_does_not_overwrite_existing_sibling(monitor):
    cfg, path, send = monitor
    old_temp = path.with_suffix(".tmp")
    old_temp.write_text("another-file", encoding="utf-8")
    alerts.Incidents(cfg).record("database", True, now=1)
    assert old_temp.read_text() == "another-file"
    assert json.loads(path.read_text())["database"]["failures"] == 0
    assert not list(path.parent.glob(".state.json.*.tmp"))
    assert not send.called


@pytest.mark.parametrize("winerror", [5, 32, 33])
def test_transient_windows_replace_retries_and_retains_cooldown(
    monitor,
    monkeypatch,
    winerror,
):
    cfg, path, send = monitor
    incidents = alerts.Incidents(cfg)
    incidents.record("database", False, now=1)
    original = Path.replace
    calls = []
    error = PermissionError(errno.EACCES, "private-error")
    error.winerror = winerror

    def replace(source, destination):
        calls.append(source)
        if len(calls) < 3:
            raise error
        return original(source, destination)

    pause = Mock()
    monkeypatch.setattr(Path, "replace", replace)
    monkeypatch.setattr(alerts.time, "sleep", pause)
    incidents.record("database", False, now=2)
    assert len(calls) == 3
    assert pause.call_count == 2
    monkeypatch.setattr(Path, "replace", original)
    alerts.Incidents(cfg).record("database", False, now=3)
    assert send.call_count == 1
    assert not list(path.parent.glob(".state.json.*.tmp"))


@pytest.mark.parametrize("stage", ["write", "flush", "replace"])
def test_failed_persistence_preserves_last_file_and_in_memory_deduplication(
    monitor,
    monkeypatch,
    caplog,
    stage,
):
    cfg, path, send = monitor
    incidents = alerts.Incidents(cfg)
    incidents.record("database", False, now=1)
    original = path.read_bytes()
    failure = Mock(side_effect=OSError(errno.ENOSPC, "private-error"))
    with monkeypatch.context() as failing:
        if stage == "write":
            failing.setattr(alerts.json, "dump", failure)
        elif stage == "flush":
            failing.setattr(alerts.os, "fsync", failure)
        else:
            failing.setattr(Path, "replace", failure)
        incidents.record("database", False, now=2)
        incidents.record("database", False, now=3)
    assert send.call_count == 1
    assert path.read_bytes() == original
    assert not list(path.parent.glob(".state.json.*.tmp"))
    assert "memory-only" in caplog.text
    assert "private-error" not in caplog.text
    incidents.record("database", False, now=4)
    alerts.Incidents(cfg).record("database", False, now=5)
    assert send.call_count == 1


def test_permanent_windows_replace_failure_is_bounded(monitor, monkeypatch, caplog):
    cfg, path, _send = monitor
    incidents = alerts.Incidents(cfg)
    incidents.record("database", True, now=1)
    original = path.read_bytes()
    error = PermissionError(errno.EACCES, "private-error")
    error.winerror = 32
    replace = Mock(side_effect=error)
    pause = Mock()
    monkeypatch.setattr(Path, "replace", replace)
    monkeypatch.setattr(alerts.time, "sleep", pause)
    incidents.record("database", False, now=2)
    assert replace.call_count == 3
    assert pause.call_count == 2
    assert path.read_bytes() == original
    assert not list(path.parent.glob(".state.json.*.tmp"))
    assert "private-error" not in caplog.text


@pytest.mark.skipif(sys.platform != "win32", reason="Requires native Windows file sharing")
def test_native_windows_locked_state_retries_after_handle_is_released(monitor, monkeypatch):
    import ctypes
    from ctypes import wintypes

    cfg, path, send = monitor
    incidents = alerts.Incidents(cfg)
    incidents.record("database", False, now=1)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    # Allow ordinary reads/writes but hold back FILE_SHARE_DELETE, so a real
    # Windows replace fails until this handle closes. Only the test file is held.
    handle = kernel.CreateFileW(str(path), 0x80000000, 0x3, None, 3, 0x80, None)
    assert handle != ctypes.c_void_p(-1).value
    released = False

    def release(_delay):
        nonlocal released
        assert kernel.CloseHandle(handle)
        released = True

    pause = Mock(side_effect=release)
    monkeypatch.setattr(alerts.time, "sleep", pause)
    try:
        incidents.record("database", False, now=2)
    finally:
        if not released:
            kernel.CloseHandle(handle)
    pause.assert_called_once_with(0.05)
    alerts.Incidents(cfg).record("database", False, now=3)
    assert send.call_count == 1
    assert json.loads(path.read_text())["database"]["notified"] is True
    assert not list(path.parent.glob(".state.json.*.tmp"))


@pytest.mark.parametrize(
    ("status", "body", "accepted"),
    [
        (200, b'{"id":"synthetic-id"}', True),
        (201, b'{"id":"synthetic-id"}', True),
        (200, b"{}", False),
        (200, b"[]", False),
        (200, b'{"id":42}', False),
        (200, b'{"id":" "}', False),
        (200, b"invalid-private-response", False),
        (204, b"", False),
        (302, b'{"id":"synthetic-id"}', False),
        (401, b"private-response", False),
        (503, b"private-response", False),
    ],
)
def test_ops_http_requires_2xx_and_message_id(monkeypatch, status, body, accepted):
    cfg = SimpleNamespace(
        OPS_ALERTS_ENABLED=True,
        ADMIN_NOTIFY_EMAIL="recipient@example.invalid",
        EMAIL_FROM="sender@example.invalid",
        EMAIL_PROVIDER="http",
        RESEND_API_KEY="synthetic-key",
        SMTP_PASSWORD="",
    )
    response = httpx.Response(status, content=body)
    client = MagicMock()
    client.__enter__.return_value = client
    client.post.return_value = response
    factory = Mock(return_value=client)
    monkeypatch.setattr(alerts.httpx, "Client", factory)
    if accepted:
        assert alerts.deliver(cfg, "Synthetic", "Synthetic") is True
    else:
        with pytest.raises(RuntimeError) as error:
            alerts.deliver(cfg, "Synthetic", "Synthetic")
        assert "private" not in str(error.value)
    factory.assert_called_once_with(timeout=15, follow_redirects=False)
    client.post.assert_called_once()
