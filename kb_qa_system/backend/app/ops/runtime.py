"""Recovery runs outside the event loop; readiness stays separate from liveness."""
import asyncio
import logging

from app.ops.config import OpsSettings
from app.ops.monitor import checks
from app.ops.recovery import recover_once

logger = logging.getLogger(__name__)


def application_config(settings):
    # Keep the operations model independent from the application settings,
    # while explicitly carrying over startup/recovery controls. Previously
    # these environment-backed flags were silently replaced by OpsSettings'
    # defaults, so Railway's release migration could not disable startup
    # migrations and runtime recovery could not be disabled per deployment.
    return OpsSettings(
        DATABASE_URL=settings.DATABASE_URL,
        REDIS_URL=settings.REDIS_URL,
        MIGRATE_ON_STARTUP=settings.MIGRATE_ON_STARTUP,
        DB_RECOVERY_ENABLED=settings.DB_RECOVERY_ENABLED,
        DB_STARTUP_TIMEOUT_SECONDS=settings.DB_STARTUP_TIMEOUT_SECONDS,
        DB_RETRY_INTERVAL_SECONDS=settings.DB_RETRY_INTERVAL_SECONDS,
        DB_CONNECT_TIMEOUT_SECONDS=settings.DB_CONNECT_TIMEOUT_SECONDS,
        DB_OPERATION_TIMEOUT_SECONDS=settings.DB_OPERATION_TIMEOUT_SECONDS,
        OPS_INTERVAL_SECONDS=settings.OPS_INTERVAL_SECONDS,
    )


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
