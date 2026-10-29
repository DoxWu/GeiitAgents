"""Distributed in-flight limits for model-backed requests."""

from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import suppress
from dataclasses import dataclass

from fastapi import Depends, HTTPException

from app.core.config import settings
from app.core.redis import RedisManager, async_redis_client

logger = logging.getLogger(__name__)

_ACQUIRE_SCRIPT = """
local user_limit = tonumber(ARGV[1])
local global_limit = tonumber(ARGV[2])
local token = ARGV[3]
local ttl = tonumber(ARGV[4])
local user_slot = 0
local global_slot = 0
for i = 1, user_limit do
    if redis.call('EXISTS', KEYS[i]) == 0 then
        user_slot = i
        break
    end
end
for i = 1, global_limit do
    local index = user_limit + i
    if redis.call('EXISTS', KEYS[index]) == 0 then
        global_slot = index
        break
    end
end
if user_slot == 0 or global_slot == 0 then
    return nil
end
redis.call('SET', KEYS[user_slot], token, 'EX', ttl)
redis.call('SET', KEYS[global_slot], token, 'EX', ttl)
return {user_slot, global_slot}
"""

_RENEW_SCRIPT = """
local renewed = 0
for i = 1, #KEYS do
    if redis.call('GET', KEYS[i]) == ARGV[1] then
        redis.call('EXPIRE', KEYS[i], tonumber(ARGV[2]))
        renewed = renewed + 1
    end
end
return renewed
"""

_RELEASE_SCRIPT = """
local released = 0
for i = 1, #KEYS do
    if redis.call('GET', KEYS[i]) == ARGV[1] then
        redis.call('DEL', KEYS[i])
        released = released + 1
    end
end
return released
"""


@dataclass(frozen=True)
class ConcurrencyLease:
    keys: tuple[str, str]
    token: str
    ttl_seconds: int

    async def renew(self) -> bool:
        renewed = await async_redis_client.eval(
            _RENEW_SCRIPT, len(self.keys), *self.keys, self.token, self.ttl_seconds
        )
        return renewed == len(self.keys)

    async def release(self) -> None:
        try:
            await async_redis_client.eval(_RELEASE_SCRIPT, len(self.keys), *self.keys, self.token)
        except Exception:
            logger.exception("Unable to release request concurrency lease")

    async def heartbeat(self, owner: asyncio.Task) -> None:
        interval = max(1, self.ttl_seconds // 3)
        loop = asyncio.get_running_loop()
        last_success = loop.time()
        while True:
            await asyncio.sleep(interval)
            try:
                renewed = await self.renew()
            except Exception:
                logger.exception("Unable to renew request concurrency lease")
                if loop.time() - last_success >= self.ttl_seconds / 2:
                    logger.error("Request concurrency lease cannot be renewed; cancelling request")
                    owner.cancel()
                    return
                continue
            if not renewed:
                logger.error("Request concurrency lease expired before renewal; cancelling request")
                owner.cancel()
                return
            last_success = loop.time()


async def acquire_lease(
    action: str, user_id: int, per_user: int, global_limit: int
) -> ConcurrencyLease | None:
    if per_user < 1 or global_limit < 1:
        raise ValueError("Concurrency limits must be positive")
    ttl = max(30, int(settings.REQUEST_CONCURRENCY_LEASE_SECONDS))
    user_keys = [f"concurrency:{action}:user:{user_id}:{slot}" for slot in range(per_user)]
    global_keys = [f"concurrency:{action}:global:{slot}" for slot in range(global_limit)]
    keys = [RedisManager.make_key(key) for key in user_keys + global_keys]
    token = uuid.uuid4().hex
    selected = await async_redis_client.eval(
        _ACQUIRE_SCRIPT, len(keys), *keys, per_user, global_limit, token, ttl
    )
    if not selected:
        return None
    user_slot, global_slot = (int(value) - 1 for value in selected)
    return ConcurrencyLease((keys[user_slot], keys[global_slot]), token, ttl)


def concurrency_limit(action: str, *, per_user: int, global_limit: int):
    """FastAPI dependency that holds a distributed lease through streaming responses."""
    from app.api.deps import get_current_active_user

    async def _hold(user=Depends(get_current_active_user)):  # noqa: B008 - FastAPI dependency injection
        try:
            lease = await acquire_lease(action, user.id, per_user, global_limit)
        except Exception:
            logger.exception("Request concurrency service unavailable")
            raise HTTPException(
                503, "并发控制服务暂不可用，请稍后重试。", headers={"Retry-After": "5"}
            ) from None
        if lease is None:
            raise HTTPException(
                429,
                "当前请求较多，请等待已有任务完成后重试。",
                headers={"Retry-After": "5"},
            )

        owner = asyncio.current_task()
        heartbeat = asyncio.create_task(lease.heartbeat(owner))
        try:
            yield
        finally:
            heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat
            await lease.release()

    return _hold
