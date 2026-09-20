"""
统一限流中间件（E1-03）

作用：
    作为全局限流兜底，对未在路由级别配置限流的端点应用默认限流。
    路由级别显式配置的限流（通过 rate_limit 依赖）优先级更高，
    中间件仅对未匹配规则的路径生效。

    规则配置表支持基于路径模式的限流：
    - 精确匹配：/api/v1/registration/apply
    - 前缀匹配：/api/v1/documents/*（匹配所有文档相关接口）

实现方式：
    - 基于 Starlette BaseHTTPMiddleware
    - 使用 Redis INCR + EXPIRE 固定窗口计数
    - 复用 rate_limit.py 中的 _get_identifier 获取标识符
    - 已有路由级限流的端点可通过 exclude_paths 排除

使用方式：
    在 main.py 中注册（在 PrometheusMiddleware 之后）：
    from app.middleware.rate_limit_middleware import RateLimitMiddleware
    app.add_middleware(RateLimitMiddleware)
"""

import logging
import re
from typing import Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.core.config import settings
from app.core.redis import RedisManager, RedisKeys
from app.core.rate_limit import _get_identifier

logger = logging.getLogger(__name__)


# ============================================
# 限流规则配置
# ============================================

# 默认限流：每用户/IP 每分钟 60 次
DEFAULT_RATE_LIMIT_PER_MINUTE = 60

# 路径规则：已配置路由级限流的路径（避免重复限流）
# 这些路径已在路由中通过 dependencies=[Depends(rate_limit(...))] 配置限流
EXCLUDE_PATH_PATTERNS = [
    r"^/api/v1/private-models/",          # 20次/分钟（路由级）
    r"^/api/v1/registration/apply",       # 3次/小时（路由级）
    r"^/api/v1/registration/status",      # 10次/分钟（路由级）
    r"^/api/v1/registration/set-password", # 5次/小时（路由级）
    r"^/api/v1/chat/",                     # 20次/分钟（路由级）
    r"^/api/v1/documents/.+/reprocess",   # 重新处理限流（路由级）
    r"^/api/v1/auth/login",               # 登录失败锁定（独立机制）
    r"^/api/v1/auth/refresh",             # Token 刷新限流（路由级）
]

# 编译正则模式（启动时编译一次）
_compiled_exclude_patterns = [re.compile(p) for p in EXCLUDE_PATH_PATTERNS]


def _is_excluded(path: str) -> bool:
    """
    检查路径是否已被排除（已有路由级限流）

    作用：
        避免对已配置路由级限流的端点重复限流。

    参数：
        path: str - 请求路径

    返回：
        bool - True 表示已排除（跳过中间件限流）
    """
    return any(pattern.match(path) for pattern in _compiled_exclude_patterns)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    统一限流中间件

    作用：
        对未配置路由级限流的端点应用默认限流（每分钟 60 次/用户或IP）。
        已配置路由级限流的端点通过 exclude_paths 自动跳过。

    实现方式：
        - 继承 BaseHTTPMiddleware
        - dispatch 方法中检查路径是否需限流
        - 使用 Redis INCR + EXPIRE 固定窗口计数
        - 限流关闭时直接放行
    """

    async def dispatch(self, request: Request, call_next):
        """
        请求拦截处理

        作用：
            对未排除的路径应用默认限流。
            限流命中时返回 429 Too Many Requests。

        参数：
            request: Request - Starlette 请求对象
            call_next: callable - 下一层处理函数

        返回：
            Response - 响应对象
        """
        # 限流总开关
        if not settings.ENABLE_RATE_LIMIT:
            return await call_next(request)

        path = request.url.path

        # 跳过非 API 路径（健康检查、文档、静态资源等）
        if not path.startswith("/api/"):
            return await call_next(request)

        # 跳过已有路由级限流的路径
        if _is_excluded(path):
            return await call_next(request)

        # 获取标识符（用户ID 或 IP）
        identifier = _get_identifier(request)

        # 应用默认限流
        try:
            key = RedisKeys.rate_limit(
                f"global:1min:{identifier}:{path}",
                "1min",
            )
            count = RedisManager.increment(key, ttl=60, strict=False)

            if count > DEFAULT_RATE_LIMIT_PER_MINUTE:
                logger.warning(
                    f"全局限流命中: path={path}, identifier={identifier}, "
                    f"count={count}"
                )
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": {
                            "code": "RATE_LIMIT_EXCEEDED",
                            "message": f"请求过于频繁，每分钟最多 {DEFAULT_RATE_LIMIT_PER_MINUTE} 次",
                            "retry_after": 60,
                        }
                    },
                    headers={"Retry-After": "60"},
                )

        except Exception as e:
            # 非关键限流（兜底），Redis 故障时放行而非拒绝
            # 作用：与路由级限流的 fail-closed 不同，全局兜底限流采用 fail-open，
            #       避免全局中间件故障导致所有 API 不可用
            logger.debug(f"全局限流 Redis 异常（fail-open 放行）: {e}")

        return await call_next(request)
