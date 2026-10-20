"""One-use notification tickets; every open socket remains subject to auth."""
import asyncio
import hashlib
import json
import logging
import secrets
import time
from typing import Annotated
from urllib.parse import urlsplit

import anyio
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)

from app.api.deps import get_current_active_user, oauth2_scheme
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.rate_limit import rate_limit
from app.core.redis import RedisManager, redis_client
from app.core.security import decode_access_token, is_token_blacklisted
from app.models.user import User

logger = logging.getLogger(__name__)
router = APIRouter()
TICKET_TTL = 30
LEASE_TTL = 90
MAX_CONNECTIONS = 3


def _get_notification_channel(user_id: int) -> str:
    return f"{settings.redis_key_prefix}notifications:{user_id}"


def _allowed_origin(origin: str) -> bool:
    parsed = urlsplit(settings.FRONTEND_BASE_URL)
    frontend = f"{parsed.scheme}://{parsed.netloc}"
    return not origin or origin in {*settings.CORS_ORIGINS, frontend}


def _ticket_key(ticket: str) -> str:
    return RedisManager.make_key("auth:ws:ticket:" + hashlib.sha256(ticket.encode()).hexdigest())


@router.post(settings.API_V1_PREFIX + "/auth/ws-ticket", dependencies=[Depends(rate_limit("ws_ticket", per_minute=12))])
def create_ws_ticket(request: Request, response: Response,
                     user: Annotated[User, Depends(get_current_active_user)],
                     token: Annotated[str, Depends(oauth2_scheme)]):
    origin = request.headers.get("origin", "")
    if not _allowed_origin(origin):
        raise HTTPException(403, detail="通知来源不在允许列表")
    ticket = secrets.token_urlsafe(32)
    try:
        if not redis_client.set(_ticket_key(ticket), json.dumps({"token": token, "origin": origin}), ex=TICKET_TTL):
            raise RuntimeError("ticket not acknowledged")
    except Exception:
        raise HTTPException(503, detail="通知认证服务暂时不可用") from None
    response.headers["Cache-Control"] = "no-store"
    return {"ticket": ticket, "expires_in": TICKET_TTL}


async def publish_notification(user_id: int, notification: dict) -> None:
    try:
        await asyncio.to_thread(redis_client.publish, _get_notification_channel(user_id),
                                json.dumps(notification, ensure_ascii=False, default=str))
    except Exception:
        logger.warning("通知发布失败")


def _active_user(token: str) -> int | None:
    payload = decode_access_token(token)
    if not payload or is_token_blacklisted(token):
        return None
    try:
        user_id = int(payload["sub"])
    except (KeyError, ValueError, TypeError):
        return None
    with SessionLocal() as db:
        user = db.get(User, user_id)
        return user_id if user and user.is_active else None


_LEASE_SCRIPT = """
redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
if not redis.call('zscore', KEYS[1], ARGV[3]) and redis.call('zcard', KEYS[1]) >= tonumber(ARGV[4]) then
    return 0
end
redis.call('zadd', KEYS[1], ARGV[2], ARGV[3])
redis.call('expire', KEYS[1], ARGV[5])
return 1
"""


@router.websocket("/ws/notifications")
async def websocket_notifications(websocket: WebSocket):
    ticket = websocket.query_params.get("ticket", "")
    origin = websocket.headers.get("origin", "")
    if not ticket or len(ticket) > 128 or not _allowed_origin(origin):
        await websocket.close(code=4001)
        return
    pubsub = None
    receiver = None
    lease_key = None
    lease_id = secrets.token_hex(16)
    try:
        raw = await asyncio.to_thread(redis_client.eval,
            "local v=redis.call('get',KEYS[1]);redis.call('del',KEYS[1]);return v", 1, _ticket_key(ticket))
        data = json.loads(raw) if raw else {}
        if data.get("origin") != origin or not data.get("token"):
            await websocket.close(code=4001)
            return
        token = data["token"]
        user_id = await asyncio.to_thread(_active_user, token)
        if user_id is None:
            await websocket.close(code=4001)
            return
        lease_key = RedisManager.make_key(f"auth:ws:connections:{user_id}")

        def renew():
            now = time.time()
            return redis_client.eval(_LEASE_SCRIPT, 1, lease_key, now, now + LEASE_TTL,
                                     lease_id, MAX_CONNECTIONS, LEASE_TTL)

        if not await asyncio.to_thread(renew):
            await websocket.close(code=4008)
            return
        pubsub = redis_client.pubsub()
        await asyncio.to_thread(pubsub.subscribe, _get_notification_channel(user_id))
        await websocket.accept()
        last_seen = time.monotonic()

        async def receive():
            nonlocal last_seen
            while True:
                message = await websocket.receive_text()
                if message != '{"type":"pong"}':
                    await websocket.close(code=4008)
                    return
                last_seen = time.monotonic()

        receiver = asyncio.create_task(receive())
        checked = 0.0
        heartbeat = 0.0
        while not receiver.done():
            now = time.monotonic()
            if now - last_seen > LEASE_TTL:
                await websocket.close(code=4008)
                break
            if now - checked >= 5:
                if await asyncio.to_thread(_active_user, token) != user_id or not await asyncio.to_thread(renew):
                    await websocket.close(code=4001)
                    break
                checked = now
            if not decode_access_token(token):
                await websocket.close(code=4001)
                break
            if now - heartbeat >= 25:
                await websocket.send_json({"type": "ping"})
                heartbeat = now
            message = await asyncio.to_thread(pubsub.get_message, timeout=1.0)
            if message and message["type"] == "message":
                if await asyncio.to_thread(_active_user, token) != user_id:
                    await websocket.close(code=4001)
                    break
                value = message["data"]
                await websocket.send_text(value.decode() if isinstance(value, bytes) else value)
            await asyncio.sleep(0.05)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.warning("通知连接因依赖或认证异常关闭")
        try:
            await websocket.close(code=1013)
        except Exception:
            pass
    finally:
        # An ASGI disconnect can cancel this scope immediately after the close
        # frame is sent. Give lease removal a bounded, shielded cleanup window.
        # The Redis TTL still releases the lease if Redis itself is unavailable.
        with anyio.move_on_after(5, shield=True):
            if receiver:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
            if lease_key:
                try:
                    await asyncio.to_thread(redis_client.zrem, lease_key, lease_id)
                except Exception:
                    pass
            if pubsub:
                try:
                    await asyncio.to_thread(pubsub.close)
                except Exception:
                    pass
