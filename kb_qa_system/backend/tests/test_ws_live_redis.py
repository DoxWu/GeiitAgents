"""Live Redis coverage for the notification WebSocket lifecycle in CI."""

import asyncio
import importlib.util
import os
import uuid
from pathlib import Path

import pytest
from fastapi import FastAPI, WebSocketDisconnect
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_active_user
from app.core import security
from app.core.database import Base
from app.core.redis import RedisManager, redis_client
from app.models import User


def load_route(filename):
    path = Path(__file__).parents[1] / "app/api" / filename
    spec = importlib.util.spec_from_file_location("live_ws_notifications", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(
    os.getenv("GEIIT_WS_INTEGRATION") != "1",
    reason="requires the disposable Redis service enabled by CI",
)
def test_live_redis_notification_revocation_and_ticket_replay(monkeypatch):
    try:
        redis_client.ping()
    except Exception as exc:
        pytest.fail(f"GEIIT_WS_INTEGRATION requires reachable Redis: {exc}")

    ws = load_route("routes/ws_notifications.py")
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine, tables=[User.__table__])
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    user_id = 2_000_000_000 + uuid.uuid4().int % 1_000_000_000
    user = User(
        id=user_id,
        username=f"ws-{user_id}",
        email=f"ws-{user_id}@example.test",
        hashed_password="not-a-password",
        is_active=True,
    )
    with factory() as db:
        db.add(user)
        db.commit()

    token = security.create_access_token({"sub": str(user_id)})
    ticket_key = None
    lease_key = RedisManager.make_key(f"auth:ws:connections:{user_id}")
    blacklist_key = RedisManager.make_key(security.RedisKeys.token_blacklist(token))
    app = FastAPI()
    app.include_router(ws.router)
    monkeypatch.setattr(ws, "SessionLocal", factory)
    app.dependency_overrides[get_current_active_user] = lambda: user
    app.dependency_overrides[ws.oauth2_scheme] = lambda: token

    try:
        with TestClient(app) as client:
            response = client.post(ws.settings.API_V1_PREFIX + "/auth/ws-ticket")
            assert response.status_code == 200, response.text
            ticket = response.json()["ticket"]
            ticket_key = ws._ticket_key(ticket)

            with client.websocket_connect(f"/ws/notifications?ticket={ticket}") as socket:
                notification = {"type": "fixture", "id": str(uuid.uuid4())}
                asyncio.run(ws.publish_notification(user_id, notification))
                while True:
                    message = socket.receive_json()
                    if message.get("type") == "ping":
                        socket.send_json({"type": "pong"})
                        continue
                    assert message == notification
                    break
                redis_client.set(blacklist_key, "1", ex=60)
                with pytest.raises(WebSocketDisconnect):
                    socket.receive_json()

            assert redis_client.zcard(lease_key) == 0
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(f"/ws/notifications?ticket={ticket}"):
                    pass
            assert redis_client.zcard(lease_key) == 0
    finally:
        redis_client.delete(blacklist_key, lease_key)
        if ticket_key:
            redis_client.delete(ticket_key)
        engine.dispose()
