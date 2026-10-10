"""
认证路由模块（生产版）

作用：
    定义用户认证相关的 API 接口，包括：
    - 注册
    - 登录（含失败锁定机制，返回 Access + Refresh Token）
    - 刷新 Token（用 Refresh Token 换取新的 Access Token）
    - 登出（将 Token 加入黑名单，主动失效）
    - 获取当前用户信息

实现方式：
    1. 使用 FastAPI 的 APIRouter 组织路由
    2. 通过 Depends 注入数据库会话和当前用户
    3. 使用 Pydantic Schema 进行数据验证
    4. 登录失败基于 Redis 计数 + 锁定，防止暴力破解
    5. Token 黑名单支持主动登出
"""

from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import Any, Optional
from datetime import datetime, timezone
import hashlib
import logging
import os

from app.core.database import get_db
from app.core.config import settings
from app.core.redis import RedisManager
from app.core.security import (
    hash_password,
    verify_password,
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
    create_token_pair,
    blacklist_token,
    is_token_blacklisted,
    decode_access_token,
    consume_refresh_token,
    token_remaining_ttl,
)
from app.core.rate_limit import (
    rate_limit,
    check_login_lock,
    record_login_failure,
    clear_login_failure,
)
from app.api.deps import get_current_active_user
from app.models.user import User
from app.models.document import Document
from app.models.conversation import Conversation, Message
from app.schemas.user import (
    UserCreate,
    UserLogin,
    UserResponse,
    TokenResponse,
    RefreshTokenRequest,
    RefreshTokenResponse,
    AccountDeleteRequest,
)
from app.services.audit_service import audit_service

# 模块日志器
# 作用：记录 Token 刷新锁异常等关键事件
logger = logging.getLogger(__name__)

# 创建路由器
# prefix: 路由前缀，所有路由都会加上 /auth
# tags: Swagger UI 中的分组标签
router = APIRouter(prefix="/auth", tags=["认证"])


# ============================================
# 注册接口
# ============================================

@router.post(
    "/register",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    summary="用户注册",
    # 限流：每小时最多 5 次注册
    # 作用：防止批量注册机器人
    dependencies=[Depends(rate_limit("register", per_hour=5))],
)
def register(
    user_data: UserCreate,
    db: Session = Depends(get_db),
) -> Any:
    """
    用户注册接口

    作用：
        创建新用户账号，密码会被加密存储。

    实现方式：
        1. 检查用户名和邮箱是否已存在（快速失败）
        2. 加密密码（bcrypt）
        3. 创建用户记录并保存到数据库（捕获 IntegrityError 防竞态）
        4. 并发注册相同用户名/邮箱时通过数据库唯一约束兜底

    请求体：
        {
            "username": "zhangsan",
            "email": "zhangsan@example.com",
            "password": "secure123"
        }

    响应（201）：
        {
            "id": 1,
            "username": "zhangsan",
            "email": "zhangsan@example.com",
            "is_active": true,
            "created_at": "2026-07-05T10:00:00"
        }

    错误：
        400: 用户名或邮箱已存在
        429: 注册过于频繁
    """
    # 检查用户名是否已存在（快速失败，减少不必要的 bcrypt 计算）
    # 作用：确保用户名唯一，提前返回友好错误
    existing_user = db.query(User).filter(
        (User.username == user_data.username) | (User.email == user_data.email)
    ).first()

    if existing_user:
        # 判断是用户名还是邮箱重复
        if existing_user.username == user_data.username:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": {"code": "USERNAME_EXISTS", "message": "用户名已存在"}}
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": {"code": "EMAIL_EXISTS", "message": "邮箱已被注册"}}
            )

    # 加密密码
    # 作用：不存储明文密码，提升安全性
    hashed_password = hash_password(user_data.password)

    # 创建用户对象
    db_user = User(
        username=user_data.username,
        email=user_data.email,
        hashed_password=hashed_password,
    )

    # 保存到数据库（捕获 IntegrityError 防止 TOCTOU 竞态）
    # 作用：在"先查后插"之间可能有并发请求通过了查询检查，
    #       数据库唯一约束会抛 IntegrityError，此处捕获并返回友好错误
    try:
        db.add(db_user)
        db.commit()
        db.refresh(db_user)  # 刷新以获取自增ID和默认值
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": {"code": "USERNAME_EXISTS", "message": "用户名或邮箱已存在（并发冲突）"}},
        )

    return db_user


# ============================================
# 登录接口（生产版：失败锁定 + 双 Token）
# ============================================

@router.post(
    "/login",
    response_model=TokenResponse,
    summary="用户登录",
    # 限流：每分钟最多 5 次登录尝试
    # 作用：配合账号锁定机制，防止暴力破解
    dependencies=[Depends(rate_limit("login", per_minute=settings.RATE_LIMIT_LOGIN_PER_MINUTE))],
)
def login(
    credentials: UserLogin,
    db: Session = Depends(get_db),
) -> Any:
    """
    用户登录接口（生产版）

    作用：
        验证用户凭证，成功后返回 Access Token + Refresh Token。
        内置失败锁定机制，防止暴力破解。

    实现流程：
        1. 检查账号是否被锁定（连续失败达阈值）
        2. 查询用户并验证密码（恒定时间，防时序攻击）
        3. 失败：递增失败计数，达到阈值自动锁定，返回剩余尝试次数
        4. 成功：清除失败计数，生成 Access + Refresh Token 对
        5. 返回双 Token 和用户信息

    安全特性：
        - 时序攻击防护：即使用户不存在也执行 bcrypt 验证，保持响应时间一致
        - 账号锁定：连续失败达阈值后锁定 15 分钟
        - 限流：每分钟最多 5 次登录尝试

    请求体：
        {
            "username": "zhangsan",
            "password": "secure123"
        }

    响应（200）：
        {
            "access_token": "eyJhbGci...",
            "refresh_token": "eyJhbGci...",
            "token_type": "bearer",
            "expires_in": 900,
            "user": { ... }
        }

    错误：
        401: 用户名或密码错误（含剩余尝试次数）
        400: 用户已被禁用
        423: 账号被锁定
        429: 登录过于频繁
    """
    username = credentials.username

    # 第一步：检查账号是否被锁定
    # 作用：连续失败达阈值的账号在锁定期内直接拒绝
    # 抛出 423 异常（在函数内部）
    check_login_lock(username)

    # 查询用户（支持用户名或邮箱登录）
    # 修复 401 Bug：前端 LoginForm 将邮箱作为 username 字段传入，
    #              原实现仅按 User.username 查询，邮箱登录必然 401。
    #              改为同时匹配 username 和 email 字段，兼容两种登录方式。
    user = db.query(User).filter(
        (User.username == username) | (User.email == username)
    ).first()

    # 时序攻击防护：即使用户不存在也执行 bcrypt 验证
    # 作用：原实现 bool(user) and verify_password(...) 会短路，
    #       用户不存在时立即返回，响应时间远小于用户存在时，
    #       攻击者可通过响应时间差异判断用户名是否存在。
    #       修复：对不存在的用户用 dummy_hash 执行一次 bcrypt 验证，
    #       保持响应时间一致。
    # dummy_hash 是一个合法的 bcrypt 哈希，仅用于消耗时间，不匹配任何密码
    _DUMMY_HASH = "$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"
    hashed_to_check = user.hashed_password if user else _DUMMY_HASH
    password_ok = verify_password(credentials.password, hashed_to_check)
    # 用户不存在时，password_ok 必须为 False
    password_ok = password_ok and bool(user)

    if not password_ok:
        # 登录失败：记录失败次数（可能触发锁定）
        failure_count = record_login_failure(username)
        remaining = settings.LOGIN_FAILURE_LOCK_THRESHOLD - failure_count

        if remaining <= 0:
            # 已达阈值，账号被锁定
            raise HTTPException(
                status_code=status.HTTP_423_LOCKED,
                detail={
                    "error": {
                        "code": "ACCOUNT_LOCKED",
                        "message": f"账号因连续 {settings.LOGIN_FAILURE_LOCK_THRESHOLD} 次登录失败被锁定，"
                                   f"请 {settings.LOGIN_FAILURE_LOCK_MINUTES} 分钟后再试",
                        "retry_after": settings.LOGIN_FAILURE_LOCK_MINUTES * 60,
                    }
                },
                headers={
                    "Retry-After": str(settings.LOGIN_FAILURE_LOCK_MINUTES * 60)
                },
            )

        # 未锁定但失败，返回剩余尝试次数
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": {
                    "code": "INVALID_CREDENTIALS",
                    "message": "用户名或密码错误",
                },
                "remaining_attempts": remaining,
            },
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 检查用户是否活跃
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": {"code": "USER_INACTIVE", "message": "用户已被禁用"}}
        )

    # 登录成功：清除失败计数
    # 作用：避免历史失败影响下次登录
    clear_login_failure(username)

    # 生成 Access + Refresh Token 对
    # 作用：一次性生成双 Token，Access 短期用，Refresh 长期用于续期
    access_token, refresh_token, expires_in = create_token_pair(
        user_id=user.id,
        username=user.username,
    )

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "user": user,
    }


# ============================================
# 临时登录（游客）接口 - 任务5
# ============================================

@router.post(
    "/guest-login",
    response_model=TokenResponse,
    summary="临时登录（游客）",
    # 限流：每分钟最多 5 次临时登录，防止滥用
    # 作用：避免攻击者批量创建 guest 账号消耗数据库资源
    dependencies=[Depends(rate_limit("guest_login", per_minute=5))],
)
def guest_login(db: Session = Depends(get_db)) -> Any:
    """
    临时登录接口（任务5）

    作用：
        创建临时 guest 用户，返回 JWT Token。
        guest 用户权限受限：
        - 最多 GUEST_QUESTION_LIMIT（默认 20）次提问
        - 禁止上传文档 / URL 导入
        - 检索仅命中公共文档库（不可访问任何私人文档）

    实现方式：
        1. 生成随机用户名（guest_ + 16 hex）和随机密码
        2. 创建 User 记录，user_type='guest'
        3. 生成 JWT Token（复用 create_token_pair）
        4. 返回 Token + 用户信息

    响应（200）：
        {
            "access_token": "...",
            "refresh_token": "...",
            "token_type": "bearer",
            "expires_in": 900,
            "user": { ... }
        }

    错误：
        429: 临时登录过于频繁
    """
    import secrets as _secrets

    # 生成随机临时用户名（guest_ + 16 位 hex）
    # 作用：避免与正式用户名冲突，且不可预测
    random_suffix = _secrets.token_hex(8)
    guest_username = f"{settings.GUEST_USERNAME_PREFIX}{random_suffix}"
    # guest 邮箱使用 @guest.local 域名，不发送邮件，仅满足唯一约束
    guest_email = f"{guest_username}@guest.local"

    # 生成随机密码（guest 用户不需要密码登录，但 hashed_password 字段不能为空）
    random_password = _secrets.token_urlsafe(32)
    hashed_pw = hash_password(random_password)

    # 创建 guest 用户
    guest_user = User(
        username=guest_username,
        email=guest_email,
        hashed_password=hashed_pw,
        is_active=True,
        is_superuser=False,
        user_type="guest",
    )
    try:
        db.add(guest_user)
        db.commit()
        db.refresh(guest_user)
    except IntegrityError:
        # 极低概率用户名/邮箱冲突（token_hex 碰撞），重试一次
        # 作用：保证接口可用性，避免极小概率冲突导致 500
        db.rollback()
        random_suffix = _secrets.token_hex(12)
        guest_username = f"{settings.GUEST_USERNAME_PREFIX}{random_suffix}"
        guest_user.username = guest_username
        guest_user.email = f"{guest_username}@guest.local"
        db.add(guest_user)
        db.commit()
        db.refresh(guest_user)

    # 生成 Access + Refresh Token 对（复用正式登录逻辑）
    access_token, refresh_token, expires_in = create_token_pair(
        user_id=guest_user.id,
        username=guest_user.username,
    )

    logger.info(f"临时用户登录: user_id={guest_user.id}, username={guest_username}")

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "user": guest_user,
    }


# ============================================
# 刷新 Token 接口
# ============================================

@router.post(
    "/refresh",
    response_model=RefreshTokenResponse,
    summary="刷新 Access Token",
    # H-12 修复：refresh 接口加限流，防止刷新接口被高频调用
    # 作用：原实现无限流，攻击者可用有效 Refresh Token 高频刷新消耗服务器资源
    #       修复后：每分钟最多 10 次刷新，覆盖正常使用（Access Token 15 分钟过期）
    dependencies=[Depends(rate_limit("refresh", per_minute=10))],
)
def refresh_token(
    body: RefreshTokenRequest,
    db: Session = Depends(get_db),
) -> Any:
    """
    刷新 Access Token 接口（生产版：Token 轮换 + 黑名单）

    作用：
        前端在 Access Token 过期后，用 Refresh Token 换取新的 Access Token。
        避免用户频繁重新登录。

    实现流程（Token 轮换机制）：
        1. 接收 Refresh Token
        2. 检查是否在黑名单中（已登出的 Refresh Token 不能再用）
        3. 解码验证（必须是 refresh 类型且未过期）
        4. 检查用户是否仍然存在且活跃
        5. 签发新的 Access Token + 新的 Refresh Token（轮换）
        6. 将旧的 Refresh Token 加入黑名单（一次性使用）

    安全特性：
        - Refresh Token 黑名单：登出后 Refresh Token 也失效
        - Token 轮换：每次刷新都签发新的 Refresh Token，旧的立即失效
        - 防重放攻击：已使用的 Refresh Token 不能再次使用

    请求体：
        {
            "refresh_token": "eyJhbGci..."
        }

    响应（200）：
        {
            "access_token": "eyJhbGci...",
            "refresh_token": "eyJhbGci...",  // 新的 Refresh Token
            "token_type": "bearer",
            "expires_in": 900
        }

    错误：
        401: Refresh Token 无效/过期/已使用/用户已禁用
    """
    invalid_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"error": {"code": "INVALID_REFRESH_TOKEN", "message": "Refresh Token 无效或已过期，请重新登录"}},
        headers={"WWW-Authenticate": "Bearer"},
    )

    # C-9 修复：Redis SETNX 锁，防止并发刷新同一 Refresh Token
    # 作用：原实现无互斥，两个并发请求都通过黑名单检查（都未拉黑），
    #       各自签发新 Token，形成两条并行 Token 链，破坏"一次性使用"语义
    # 修复：用 Redis SETNX 锁，保证同一 Refresh Token 串行处理
    #       第二个请求发现锁存在，说明正在处理，拒绝（409）
    #       锁 TTL 30 秒，覆盖正常处理时间（含 DB 查询 + Token 签发）
    #       finally 块保证锁释放（无论成功或失败）；TTL 兜底防死锁
    token_hash = hashlib.sha256(body.refresh_token.encode()).hexdigest()[:16]
    refresh_lock_key = f"auth:refresh:lock:{token_hash}"
    # H-2 修复：使用 acquire_lock 获取唯一 token，防误删
    refresh_lock_token = RedisManager.acquire_lock(refresh_lock_key, ttl=30)
    if refresh_lock_token is None:
        # 已有刷新请求在处理中，拒绝并发刷新
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": {"code": "REFRESH_IN_PROGRESS", "message": "刷新请求正在处理中，请勿重复提交"}},
        )

    try:
        # 1. 检查 Refresh Token 是否在黑名单中（已登出或已轮换过的 Token，fail-closed）
        # 作用：防止已使用的 Refresh Token 被重放攻击
        # 安全要求：is_token_blacklisted 使用 exists_strict（fail-closed），
        #           Redis 故障时抛出异常，此处捕获并返回 503，拒绝请求而非放行
        try:
            if is_token_blacklisted(body.refresh_token):
                raise invalid_exception
        except HTTPException:
            # 黑名单命中，正常抛出 401
            raise
        except Exception:
            # Redis 故障，安全场景 fail-closed：拒绝刷新请求
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"error": {"code": "AUTH_SERVICE_UNAVAILABLE", "message": "认证服务暂时不可用，请稍后重试"}},
            )

        # 2. 解码 Refresh Token
        payload = decode_refresh_token(body.refresh_token)
        if payload is None:
            raise invalid_exception

        # 从 payload 获取用户ID
        user_id_str: Optional[str] = payload.get("sub")
        if user_id_str is None:
            raise invalid_exception

        try:
            user_id = int(user_id_str)
        except (ValueError, TypeError):
            raise invalid_exception

        # 3. 检查用户是否仍然存在且活跃
        # 作用：Refresh Token 有效不代表用户仍可用（可能已被禁用或删除）
        user = db.query(User).filter(User.id == user_id).first()
        if user is None or not user.is_active:
            raise invalid_exception

        # 4. 签发新的 Access Token + 新的 Refresh Token（Token 轮换）
        # 作用：每次刷新都生成新的 Refresh Token，旧的立即拉黑
        #       这样即使旧 Refresh Token 被窃取，也无法再次使用
        new_access_token = create_access_token(
            data={"sub": str(user.id), "username": user.username, **({"sid": payload["sid"]} if payload.get("sid") else {})}
        )
        new_refresh_token = create_refresh_token(
            data={"sub": str(user.id), "username": user.username, **({"sid": payload["sid"]} if payload.get("sid") else {})}
        )
        expires_in = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60

        # 5. 将旧的 Refresh Token 加入黑名单（一次性使用）
        # 作用：防止旧 Token 被重放，TTL 设为 Refresh Token 剩余有效期
        try:
            if not consume_refresh_token(body.refresh_token, payload):
                raise invalid_exception
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, detail={"error": {"code": "AUTH_SERVICE_UNAVAILABLE", "message": "认证服务暂时不可用，请稍后重试"}}) from None

        return {
            "access_token": new_access_token,
            "refresh_token": new_refresh_token,
            "token_type": "bearer",
            "expires_in": expires_in,
        }
    finally:
        # C-9: 释放刷新锁（无论成功或失败）
        # 作用：异常时释放锁允许用户重试；成功时旧 Token 已拉黑，
        #       后续相同 Token 的请求会在黑名单检查阶段被拒
        # H-2: 使用 release_lock 比对 token，防止误删他人锁
        if refresh_lock_token:
            RedisManager.release_lock(refresh_lock_key, refresh_lock_token)


# ============================================
# 登出接口
# ============================================

@router.post(
    "/logout",
    summary="用户登出",
    status_code=status.HTTP_200_OK,
)
async def logout(
    request: Request,
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """
    用户登出接口（生产版：双 Token 拉黑）

    作用：
        将当前 Access Token 加入黑名单，使其立即失效。
        如果请求体中包含 Refresh Token，也一并拉黑。
        后续这两个 Token 的请求都将被拒绝。

    实现方式：
        1. 从 Authorization Header 提取 Access Token
        2. 从请求体中提取 Refresh Token（可选）
        3. 将 Access Token 加入 Redis 黑名单
        4. 将 Refresh Token 加入 Redis 黑名单（TTL = Refresh Token 有效期）
        5. 黑名单 TTL 与 Token 剩余有效期一致，自动清理

    请求头：
        Authorization: Bearer <access_token>

    请求体（可选）：
        {
            "refresh_token": "eyJhbGci..."
        }

    响应（200）：
        {
            "message": "已成功登出"
        }

    错误：
        401: 未登录或 Token 无效
    """
    # 从 Authorization Header 提取 Access Token
    # 作用：拿到原始 Token 字符串用于拉黑
    auth_header = request.headers.get("Authorization", "")
    token = ""
    if auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "UNAUTHORIZED", "message": "未提供有效的认证凭证"}},
        )

    # L-9 replaced by A30: batch writes are idempotent; success requires acknowledgement.
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(401, detail="无效的认证凭证")
    refresh_payload = None
    refresh_tok = None
    if "application/json" in request.headers.get("content-type", ""):
        try:
            body = await request.json()
            refresh_tok = body.get("refresh_token") if isinstance(body, dict) else None
        except ValueError:
            raise HTTPException(400, detail="请求体不是有效 JSON") from None
        if refresh_tok is not None:
            if not isinstance(refresh_tok, str):
                raise HTTPException(400, detail="Refresh Token 格式无效")
            refresh_payload = decode_refresh_token(refresh_tok)
            if refresh_payload and (refresh_payload.get("sub") != str(current_user.id)
                    or (payload.get("sid") and refresh_payload.get("sid") != payload["sid"])):
                raise HTTPException(400, detail="Refresh Token 不属于当前会话")

    from app.core.redis import RedisKeys
    entries = [(RedisKeys.token_blacklist(token), "1", token_remaining_ttl(payload))]
    if refresh_payload:
        entries.append((RedisKeys.token_blacklist(refresh_tok), "1", token_remaining_ttl(refresh_payload)))
    if payload.get("sid"):
        # Covers credentials from a concurrent refresh of the same session.
        entries.append((f"auth:session:revoked:{payload['sid']}", "1",
                        settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 3600 + 60))
    try:
        if not RedisManager.set_many_strict(entries):
            raise RuntimeError("revocation not acknowledged")
    except Exception:
        raise HTTPException(503, detail={"error": {"code": "LOGOUT_NOT_CONFIRMED",
            "message": "服务器未确认会话注销，请稍后重试。"}}) from None

    return {"message": "已成功登出"}


# ============================================
# 获取当前用户信息
# ============================================

@router.get(
    "/me",
    response_model=UserResponse,
    summary="获取当前用户信息",
)
def get_current_user_info(
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """
    获取当前登录用户信息

    作用：
        返回当前登录用户的详细信息。
        需要在请求头中携带 Token。

    请求头：
        Authorization: Bearer <token>

    响应（200）：
        {
            "id": 1,
            "username": "zhangsan",
            "email": "zhangsan@example.com",
            "is_active": true,
            "created_at": "2026-07-05T10:00:00"
        }

    错误：
        401: 未登录或 Token 无效
    """
    return current_user


# ============================================
# 删除账号（GDPR/PIPL 合规）
# ============================================

@router.delete(
    "/account",
    summary="删除当前用户账号",
    status_code=status.HTTP_200_OK,
    # 限流：每小时最多 3 次删除尝试
    # 作用：防止接口被滥用或暴力尝试密码
    dependencies=[Depends(rate_limit("account_delete", per_hour=3))],
)
async def delete_account(
    request: Request,
    body: AccountDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """
    删除当前用户账号（生产版：GDPR/PIPL 合规）

    作用：
        永久删除当前用户账号及其所有个人数据，包括文档、对话、消息等。
        删除后 Token 立即失效，用户需重新注册。
        满足 GDPR"被遗忘权"和 PIPL 个人信息删除权要求。

    实现流程：
        1. 密码确认：验证当前密码，防止误操作和 CSRF 攻击
        2. 删除物理文件：遍历用户文档，删除服务器上存储的原始文件
        3. 删除数据库记录：db.delete(user) + commit，
           级联删除 documents/document_chunks/conversations/messages
           QAEvent.user_id 被 SET NULL（保留匿名化统计数据）
        4. 吊销 Token：将 Access Token 和 Refresh Token（如有）加入黑名单
        5. 返回删除成功消息

    请求体：
        {
            "password": "Secure123",
            "refresh_token": "eyJhbGci..."  // 可选
        }

    响应（200）：
        {
            "message": "账号已删除"
        }

    错误：
        401: 密码错误或未登录
        429: 操作过于频繁（限流）
        503: 认证服务暂时不可用（Redis 故障）
    """
    # 1. 密码确认（防误操作 + 防 CSRF）
    # 作用：即使 Token 被窃取，攻击者不知道密码也无法删除账号
    if not verify_password(body.password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "INVALID_PASSWORD", "message": "密码错误，无法删除账号"}},
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 2. 删除用户上传的物理文件
    # 作用：GDPR 要求彻底删除个人数据，文件系统中的文档文件也需删除
    # 容错：文件删除失败记日志但不阻塞 DB 删除（DB 记录删除优先，文件残留可由清理任务处理）
    user_documents = db.query(Document).filter(Document.user_id == current_user.id).all()
    for doc in user_documents:
        if doc.file_path:
            try:
                # file_path 是相对路径，与 UPLOAD_DIR 拼接为绝对路径
                file_abs_path = os.path.join(settings.UPLOAD_DIR, os.path.basename(doc.file_path))
                if os.path.exists(file_abs_path):
                    os.remove(file_abs_path)
            except OSError as e:
                # 文件删除失败记日志，不阻塞流程
                logger.warning(
                    f"删除用户文件失败（user_id={current_user.id}, "
                    f"doc_id={doc.id}, path={doc.file_path}）: {e}"
                )

    # 3. 删除数据库记录（级联删除关联数据）
    # 作用：User 模型配置了 cascade="all, delete-orphan"，
    #       db.delete(user) 会级联删除 documents/document_chunks/conversations/messages
    #       QAEvent.user_id 外键为 SET NULL，保留匿名化统计数据用于系统分析

    # D10-01 审计日志：在删除用户前记录审计（删除后 user_id 将被 SET NULL）
    # 作用：账号删除是敏感操作，需留痕便于合规审计
    audit_service.log(
        db=db,
        user_id=current_user.id,
        action="account.delete",
        resource_type="user",
        resource_id=current_user.id,
        detail={"username": current_user.username, "email": current_user.email},
        request=request,
    )

    try:
        db.delete(current_user)
        db.commit()
    except Exception as e:
        db.rollback()
        logger.exception(f"删除用户数据库记录失败（user_id={current_user.id}）: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": {"code": "DELETE_FAILED", "message": "账号删除失败，请稍后重试"}},
        )

    # 4. 吊销 Token（立即使其失效）
    # 作用：删除账号后即使 Token 未过期也不能再使用，防止会话残留
    # 从 Authorization Header 提取 Access Token
    auth_header = request.headers.get("Authorization", "")
    access_token = ""
    if auth_header.lower().startswith("bearer "):
        access_token = auth_header[7:].strip()

    if access_token:
        try:
            blacklist_token(access_token)
        except Exception as e:
            # Token 吊销失败记日志，不影响删除结果（用户已无法登录，Token 会自然过期）
            logger.warning(f"删除账号后吊销 Access Token 失败（user_id={current_user.id}）: {e}")

    # 吊销 Refresh Token（如提供）
    if body.refresh_token:
        try:
            blacklist_token(
                body.refresh_token,
                ttl=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 3600,
            )
        except Exception as e:
            logger.warning(f"删除账号后吊销 Refresh Token 失败: {e}")

    logger.info(f"用户账号已删除（user_id={current_user.id}, username={current_user.username}）")

    return {"message": "账号已删除"}


# ============================================
# 数据导出接口（GDPR 数据可携权）
# ============================================

@router.get(
    "/export-data",
    summary="导出当前用户个人数据",
    description="返回当前登录用户的所有个人数据（JSON 格式），包括账号信息、文档列表、对话历史。满足 GDPR 数据可携权要求。",
    status_code=status.HTTP_200_OK,
    # 限流：每小时最多 5 次导出
    # 作用：防止接口被滥用，数据导出是重查询操作
    dependencies=[Depends(rate_limit("export_data", per_hour=5))],
)
def export_user_data(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
) -> Any:
    """
    导出当前用户个人数据（GDPR 数据可携权）

    作用：
        返回用户的所有个人数据，以 JSON 格式组织，便于用户迁移或备份。
        满足 GDPR 第 20 条"数据可携权"和 PIPL 第 45 条个人信息转移权要求。

    导出内容：
        1. account: 账号信息（用户名、邮箱、注册时间等，不含密码）
        2. documents: 用户上传的文档列表（元数据，不含文件内容）
        3. conversations: 用户的所有对话和消息历史

    响应示例：
        {
            "account": {
                "id": 1,
                "username": "alice",
                "email": "alice@example.com",
                "is_active": true,
                "created_at": "2025-01-01T00:00:00"
            },
            "documents": [...],
            "conversations": [...]
        }

    错误：
        401: 未登录
        429: 操作过于频繁（限流）
    """
    # 1. 账号信息（排除敏感字段）
    # 作用：导出基本账号信息，不包含密码哈希等敏感数据
    user_data = {
        "id": current_user.id,
        "username": current_user.username,
        "email": current_user.email,
        "is_active": current_user.is_active,
        "created_at": current_user.created_at.isoformat() if current_user.created_at else None,
        "updated_at": current_user.updated_at.isoformat() if current_user.updated_at else None,
    }

    # 2. 文档列表（元数据，不含文件内容）
    # 作用：导出用户上传的所有文档元数据，不含文件全文（文件全文可通过单独接口获取）
    user_documents = db.query(Document).filter(
        Document.user_id == current_user.id,
        Document.is_deleted == False,  # noqa: E712 - SQLAlchemy 需要 == False
    ).all()

    documents_data = [
        {
            "id": doc.id,
            "title": doc.title,
            "file_name": doc.file_name,
            "file_type": doc.file_type,
            "file_size": doc.file_size,
            "status": doc.status,
            "visibility": doc.visibility,
            "quality_score": doc.quality_score,
            "chunk_count": doc.chunk_count,
            "total_tokens": doc.total_tokens,
            "created_at": doc.created_at.isoformat() if doc.created_at else None,
            "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
        }
        for doc in user_documents
    ]

    # 3. 对话历史（含消息）
    # 作用：导出用户的所有对话和消息，是用户数据的核心部分
    user_conversations = db.query(Conversation).filter(
        Conversation.user_id == current_user.id,
        Conversation.is_active == True,  # noqa: E712 - SQLAlchemy 需要 == True
    ).all()

    conversations_data = []
    for conv in user_conversations:
        # 查询对话下的所有消息
        messages = db.query(Message).filter(
            Message.conversation_id == conv.id
        ).order_by(Message.created_at).all()

        messages_data = [
            {
                "id": msg.id,
                "role": msg.role,
                "content": msg.content,
                "token_count": msg.token_count,
                "model_used": msg.model_used,
                "response_time_ms": msg.response_time_ms,
                "feedback": msg.feedback,
                "feedback_text": msg.feedback_text,
                "is_degraded": msg.is_degraded,
                "created_at": msg.created_at.isoformat() if msg.created_at else None,
            }
            for msg in messages
        ]

        conversations_data.append({
            "id": conv.id,
            "title": conv.title,
            "turn_count": conv.turn_count,
            "is_pinned": conv.is_pinned,
            "created_at": conv.created_at.isoformat() if conv.created_at else None,
            "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
            "messages": messages_data,
        })

    logger.info(f"用户数据已导出（user_id={current_user.id}, 文档数={len(documents_data)}, 对话数={len(conversations_data)}）")

    return {
        "account": user_data,
        "documents": documents_data,
        "conversations": conversations_data,
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }
