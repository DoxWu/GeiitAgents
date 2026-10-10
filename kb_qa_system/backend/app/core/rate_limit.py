"""
限流模块

作用：
    基于 Redis 的限流实现，支持：
    1. 通用限流（按用户ID或IP，时间窗口内最大请求数）
    2. 登录失败锁定（连续失败 N 次后锁定 M 分钟）
    3. 接口级限流（提问、上传等接口独立限流）

实现方式：
    1. 使用 Redis INCR + EXPIRE 实现固定窗口计数
    2. 登录失败用独立计数器，达到阈值后设置锁定 key
    3. FastAPI 依赖注入，便于在路由中使用

使用方式：
    # 通用限流
    @router.get("/xxx", dependencies=[Depends(rate_limit("ask", per_minute=20))])

    # 登录失败检查
    check_login_lock(username)  # 抛异常或通过
    record_login_failure(username)  # 记录失败
    clear_login_failure(username)  # 登录成功后清除
"""

import logging
from typing import Optional

from fastapi import HTTPException, status, Request

from app.core.redis import RedisManager, RedisKeys
from app.core.config import settings
from app.core.client_ip import get_client_ip

logger = logging.getLogger(__name__)


# ============================================
# 通用限流
# ============================================

def rate_limit(
    action: str,
    per_minute: Optional[int] = None,
    per_hour: Optional[int] = None,
):
    """
    通用限流依赖工厂

    作用：
        生成 FastAPI 依赖，按用户ID或IP进行限流。
        超出限制返回 429 Too Many Requests。

    实现方式：
        1. 从请求中提取用户ID（已认证）或IP（未认证）
        2. 用 Redis INCR 计数，首次设置 EXPIRE
        3. 超过阈值返回 429

    参数：
        action: str - 动作名称（如 "ask", "upload"），用于 key 隔离
        per_minute: Optional[int] - 每分钟最大请求数
        per_hour: Optional[int] - 每小时最大请求数

    返回:
        FastAPI 依赖函数

    使用方式：
        @router.post("/ask", dependencies=[Depends(rate_limit("ask", per_minute=20))])
        def ask(...):
            ...
    """
    def _check_limit(request: Request) -> None:
        # 限流总开关
        if not settings.ENABLE_RATE_LIMIT:
            return

        # 获取标识符（优先用用户ID，其次用IP）
        # 作用：认证用户用ID，未认证用户用IP
        identifier = _get_identifier(request)

        # C-6 修复：限流使用 strict=True（fail-closed）
        # 作用：原实现 increment 异常返回 0，count > limit 永远为 False，限流完全失效
        #       修复后：Redis 故障时抛异常，捕获后返回 503 拒绝请求（安全优先）
        try:
            # 检查每分钟限制
            if per_minute:
                key = RedisKeys.rate_limit(f"{action}:1min:{identifier}", "1min")
                count = RedisManager.increment(key, ttl=60, strict=True)
                if count > per_minute:
                    raise HTTPException(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        detail={
                            "error": {
                                "code": "RATE_LIMIT_EXCEEDED",
                                "message": f"请求过于频繁，每分钟最多 {per_minute} 次",
                                "retry_after": 60
                            }
                        },
                        headers={"Retry-After": "60"},
                    )

            # 检查每小时限制
            if per_hour:
                key = RedisKeys.rate_limit(f"{action}:1hour:{identifier}", "1hour")
                count = RedisManager.increment(key, ttl=3600, strict=True)
                if count > per_hour:
                    raise HTTPException(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        detail={
                            "error": {
                                "code": "RATE_LIMIT_EXCEEDED",
                                "message": f"请求过于频繁，每小时最多 {per_hour} 次",
                                "retry_after": 3600
                            }
                        },
                        headers={"Retry-After": "3600"},
                    )
        except HTTPException:
            # 限流命中（429），正常传播
            raise
        except Exception:
            # C-6: Redis 故障，限流 fail-closed，拒绝请求
            # 作用：无法计数时拒绝请求，防止限流绕过导致 LLM 被刷调用
            logger.exception("限流 Redis 异常，fail-closed 拒绝请求")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"error": {"code": "RATE_LIMIT_UNAVAILABLE", "message": "服务暂不可用，请稍后重试"}},
            )

    return _check_limit


def _get_identifier(request: Request) -> str:
    """
    获取请求标识符

    作用：
        优先使用认证用户的ID，未认证则使用客户端IP。
        用于限流的标识。

    实现方式：
        1. 优先从 request.state.user_id 获取（若认证中间件已设置）
        2. 回退：从 Authorization header 解析 Access Token 获取 sub（用户ID）
           作用：rate_limit 作为 dependencies 时在 get_current_user 之前执行，
                 此时 request.state.user_id 尚未设置，直接解码 Token 获取用户ID
        3. 最终回退到客户端 IP（未认证请求）

    参数：
        request: Request - FastAPI 请求对象

    返回:
        str - 标识符（"user:{id}" 或 "ip:{addr}" 或 "unknown"）
    """
    # 1. 尝试从 state 中获取用户ID（由认证中间件设置）
    # 作用：认证后的请求用用户ID限流，更精确
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        return f"user:{user_id}"

    # 2. 从 Authorization header 解析 Token 获取用户ID
    # 作用：rate_limit 作为 dependencies 在 get_current_user 之前执行，
    #       request.state.user_id 未设置时，直接解码 Token 获取 sub
    #       注意：此处仅解码不查黑名单（黑名单检查由 get_current_user 负责），
    #             避免额外 Redis 调用；解码失败静默回退到 IP
    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
        if token:
            try:
                from app.core.security import decode_access_token
                payload = decode_access_token(token)
                if payload:
                    sub = payload.get("sub")
                    if sub:
                        return f"user:{sub}"
            except Exception:
                # Token 解码失败（无效/过期），回退到 IP 限流
                pass

    # Only trust forwarding headers from configured proxy peers.
    client_ip = get_client_ip(request)
    if client_ip:
        return f"ip:{client_ip}"

    return "unknown"


# ============================================
# 登录失败锁定
# ============================================

def check_login_lock(username: str) -> None:
    """
    检查用户是否被登录锁定（C-7: fail-closed）

    作用：
        登录前检查用户是否因连续失败被锁定。
        锁定则抛 423 Locked 异常。

    实现方式：
        查询 Redis 中是否存在用户锁定 key。
        C-7 修复：使用 exists_strict（fail-closed），Redis 故障时拒绝登录，
                  防止已锁定账号在 Redis 故障期间被暴力破解。
                  原实现使用 exists（fail-open），Redis 故障返回 False，锁定机制失效。

    参数：
        username: str - 用户名

    异常:
        HTTPException 423: 用户被锁定
        HTTPException 503: Redis 故障（C-7 fail-closed，拒绝登录）
    """
    if not settings.ENABLE_RATE_LIMIT:
        return

    lock_key = RedisKeys.user_lock(username)
    # C-7: 改用 exists_strict，fail-closed
    try:
        is_locked = RedisManager.exists_strict(lock_key)
    except Exception:
        # Redis 故障，安全场景 fail-closed：拒绝登录
        # 作用：防止已锁定账号在 Redis 故障期间绕过锁定机制暴力破解
        logger.exception("登录锁定检查 Redis 异常，fail-closed 拒绝登录")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": {"code": "AUTH_SERVICE_UNAVAILABLE", "message": "认证服务暂时不可用，请稍后重试"}},
        )

    if is_locked:
        # 获取剩余锁定时间
        from app.core.redis import redis_client
        full_key = RedisManager.make_key(lock_key)
        ttl = redis_client.ttl(full_key)
        remaining_minutes = max(1, ttl // 60) if ttl > 0 else settings.LOGIN_FAILURE_LOCK_MINUTES

        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail={
                "error": {
                    "code": "ACCOUNT_LOCKED",
                    "message": f"账号因多次登录失败被锁定，请 {remaining_minutes} 分钟后再试",
                    "retry_after": ttl if ttl > 0 else settings.LOGIN_FAILURE_LOCK_MINUTES * 60
                }
            },
            headers={"Retry-After": str(ttl if ttl > 0 else settings.LOGIN_FAILURE_LOCK_MINUTES * 60)},
        )


def record_login_failure(username: str) -> int:
    """
    记录登录失败

    作用：
        登录失败时调用，递增失败计数。
        达到阈值则锁定用户。

    实现方式：
        1. INCR 失败计数（15分钟过期）
        2. 达到 LOGIN_FAILURE_LOCK_THRESHOLD 设置锁定 key

    参数：
        username: str - 用户名

    返回:
        int - 当前失败次数
    """
    if not settings.ENABLE_RATE_LIMIT:
        return 0

    fail_key = RedisKeys.login_failure(username)
    # 失败计数 15 分钟过期（与锁定时间一致）
    # C-6 修复：使用 strict=True（fail-closed）
    # 作用：原实现 increment 异常返回 0，登录失败计数不递增，锁定机制失效
    #       修复后：Redis 故障时抛异常，调用方捕获返回 503 拒绝登录，防止暴力破解
    try:
        count = RedisManager.increment(
            fail_key,
            ttl=settings.LOGIN_FAILURE_LOCK_MINUTES * 60,
            strict=True,
        )
    except Exception:
        # C-6: Redis 故障，登录失败计数 fail-closed
        # 作用：无法计数时拒绝登录，防止暴力破解防护失效
        logger.exception("登录失败计数 Redis 异常，fail-closed 拒绝登录")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": {"code": "AUTH_SERVICE_UNAVAILABLE", "message": "认证服务暂时不可用，请稍后重试"}},
        )

    # 达到阈值，锁定用户
    if count >= settings.LOGIN_FAILURE_LOCK_THRESHOLD:
        lock_key = RedisKeys.user_lock(username)
        RedisManager.set(
            lock_key,
            "1",
            ttl=settings.LOGIN_FAILURE_LOCK_MINUTES * 60,
        )
        logger.warning(
            f"用户 {username} 因连续 {count} 次登录失败被锁定 "
            f"{settings.LOGIN_FAILURE_LOCK_MINUTES} 分钟"
        )

    return count


def clear_login_failure(username: str) -> None:
    """
    清除登录失败计数

    作用：
        登录成功后调用，清除失败计数。
        避免历史失败影响后续登录。

    参数：
        username: str - 用户名
    """
    fail_key = RedisKeys.login_failure(username)
    RedisManager.delete(fail_key)


def get_login_failure_count(username: str) -> int:
    """
    获取登录失败次数

    作用：
        返回当前失败次数，用于响应中提示用户剩余尝试次数。

    参数：
        username: str - 用户名

    返回:
        int - 失败次数
    """
    fail_key = RedisKeys.login_failure(username)
    count = RedisManager.get(fail_key, default=0)
    return int(count) if count else 0
