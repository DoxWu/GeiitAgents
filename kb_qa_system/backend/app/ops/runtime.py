"""Recovery runs outside the event loop; readiness stays separate from liveness."""
import asyncio
import logging

from app.ops.config import OpsSettings
from app.ops.monitor import checks
from app.ops.recovery import recover_once

logger = logging.getLogger(__name__)


def application_config(settings):
    return OpsSettings(DATABASE_URL=settings.DATABASE_URL, REDIS_URL=settings.REDIS_URL)


def readiness(cfg):
    # Do not recursively request our own website monitor URL.
    results = checks(cfg.model_copy(update={"OPS_MONITOR_URL": "", "BACKUP_ENABLED": False, "OPS_API_ENABLED": False, "DB_OPERATION_TIMEOUT_SECONDS": 5}))
    healthy = bool(results.get("database")) and bool(results.get("redis"))
    return healthy, {key: {"status": "healthy" if ok else "unhealthy"} for key, ok in results.items()}


async def recovery_loop(cfg):
    while True:
        try:
            result = await asyncio.to_thread(recover_once, cfg)
            if result != "ready":
                logger.warning("Runtime database recovery completed: %s", result)
        except Exception as exc:
            logger.warning("Runtime database recovery pending (%s)", type(exc).__name__)
        await asyncio.sleep(cfg.OPS_INTERVAL_SECONDS)
