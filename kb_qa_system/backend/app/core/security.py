"""
安全模块（生产版）

作用：
    处理密码加密/验证、JWT Token（Access + Refresh）的生成/验证、
    Token 黑名单管理。
    这是认证授权的核心模块。

实现方式：
    1. 使用 passlib 进行密码加密（bcrypt 算法）
    2. 使用 python-jose 生成和验证 JWT Token
    3. Access Token 短期有效（15分钟），Refresh Token 长期有效（7天）
    4. Token 黑名单存储在 Redis，登出时主动失效
"""

from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any, Tuple
from jose import jwt, JWTError
from passlib.context import CryptContext
from uuid import uuid4
import math

from app.core.config import settings
from app.core.redis import RedisManager, RedisKeys


# ============================================
# 密码加密上下文
# ============================================

"""
作用：
    创建密码加密上下文，使用 bcrypt 算法加密密码。
    bcrypt 是目前最安全的密码哈希算法之一，自动加盐防彩虹表攻击。
"""
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ============================================
# 密码处理函数
# ============================================

def hash_password(password: str) -> str:
    """
    加密密码

    作用：
        将明文密码加密为哈希值，存储到数据库。
        即使数据库泄露，攻击者也无法还原出原始密码。

    参数：
        password: str - 明文密码

    返回：
        str - 加密后的密码哈希值
    """
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    验证密码

    作用：
        验证用户输入的明文密码是否与数据库中的哈希密码匹配。

    参数：
        plain_password: str - 用户输入的明文密码
        hashed_password: str - 数据库中存储的哈希密码

    返回：
        bool - 密码是否匹配
    """
    return pwd_context.verify(plain_password, hashed_password)


# ============================================
# Access Token 处理
# ============================================

def create_access_token(
    data: Dict[str, Any],
    expires_delta: Optional[timedelta] = None,
) -> str:
    """
    创建 Access Token（短期 Token）

    作用：
        将用户信息编码为 JWT，用于 API 请求认证。
        有效期短（默认 15 分钟），降低泄露风险。

    实现方式：
        1. 复制传入数据
        2. 添加 token_type=access 标识
        3. 计算过期时间并添加到 payload
        4. 签名生成 JWT

    参数：
        data: Dict[str, Any] - 要编码的数据
            示例：{"sub": "1", "username": "zhangsan"}
        expires_delta: Optional[timedelta] - 过期时间增量
            不传则使用默认 ACCESS_TOKEN_EXPIRE_MINUTES

    返回：
        str - JWT Token 字符串
    """
    to_encode = data.copy()
    # 添加 token 类型标识
    # 作用：防止 refresh token 被当作 access token 使用
    to_encode.update({"type": "access"})

    # 计算过期时间
    # M-17 修复：原 datetime.utcnow 在 Python 3.12+ 已弃用，改用 datetime.now(timezone.utc)
    #   作用：返回带时区的 aware datetime，避免 DeprecationWarning
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(
            minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES
        )

    to_encode.update({"exp": expire, "jti": uuid4().hex})

    encoded_jwt = jwt.encode(
        to_encode,
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )
    return encoded_jwt


def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    """
    解码 Access Token

    作用：
        验证并解码 Access Token，提取用户信息。
        会检查 token 类型是否为 access。

    参数：
        token: str - JWT Token 字符串

    返回：
        Optional[Dict[str, Any]] - 解码后的 payload
            成功返回：{"sub": "1", "username": "zhangsan", "exp": ..., "type": "access"}
            失败返回：None
    """
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
        # 验证 token 类型
        if payload.get("type") != "access":
            return None
        return payload
    except JWTError:
        return None


# ============================================
# Refresh Token 处理
# ============================================

def create_refresh_token(
    data: Dict[str, Any],
    expires_delta: Optional[timedelta] = None,
) -> str:
    """
    创建 Refresh Token（长期 Token）

    作用：
        用于刷新 Access Token，有效期长（默认 7 天）。
        不直接用于 API 认证，只在 /auth/refresh 接口使用。

    实现方式：
        1. 复制传入数据
        2. 添加 token_type=refresh 标识
        3. 计算过期时间（默认 7 天）
        4. 签名生成 JWT

    参数：
        data: Dict[str, Any] - 要编码的数据
        expires_delta: Optional[timedelta] - 过期时间增量

    返回：
        str - Refresh Token 字符串
    """
    to_encode = data.copy()
    to_encode.update({"type": "refresh"})

    if expires_delta:
        # M-17 修复：原 datetime.utcnow 已弃用，改用 datetime.now(timezone.utc)
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(
            days=settings.REFRESH_TOKEN_EXPIRE_DAYS
        )

    to_encode.update({"exp": expire, "jti": uuid4().hex})

    encoded_jwt = jwt.encode(
        to_encode,
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )
    return encoded_jwt


def decode_refresh_token(token: str) -> Optional[Dict[str, Any]]:
    """
    解码 Refresh Token

    作用：
        验证并解码 Refresh Token。
        会检查 token 类型是否为 refresh。

    参数：
        token: str - Refresh Token 字符串

    返回：
        Optional[Dict[str, Any]] - 解码后的 payload
            成功返回 payload，失败返回 None
    """
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
        # 验证 token 类型
        if payload.get("type") != "refresh":
            return None
        return payload
    except JWTError:
        return None


# ============================================
# Token 黑名单管理
# ============================================

def blacklist_token(token: str, ttl: Optional[int] = None) -> bool:
    """
    将 Token 加入黑名单

    作用：
        登出时调用，使 Token 主动失效。
        黑名单 TTL 应与 Token 剩余有效期一致，避免无限增长。

    实现方式：
        1. 计算 token 的 SHA256 哈希作为 key（避免 token 过长）
        2. 存入 Redis，值为 "1"
        3. TTL 默认为 Access Token 的过期时间

    参数：
        token: str - 要拉黑的 Token
        ttl: Optional[int] - 黑名单过期时间（秒）
            不传则使用 ACCESS_TOKEN_EXPIRE_MINUTES * 60

    返回：
        bool - 是否成功加入黑名单
    """
    if ttl is None:
        ttl = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60

    key = RedisKeys.token_blacklist(token)
    return RedisManager.set(key, "1", ttl=ttl)


def is_token_blacklisted(token: str) -> bool:
    """
    检查 Token 是否在黑名单中（fail-closed，用于安全场景）

    作用：
        认证时调用，已登出的 Token 即使未过期也视为无效。
        使用 exists_strict 实现 fail-closed：Redis 故障时抛出异常而非返回 False，
        防止 Redis 宕机时已登出的 Token 重新生效（安全漏洞）。

    实现方式：
        - 调用 RedisManager.exists_strict，Redis 异常时向上传播
        - 调用方应捕获 RedisError 并返回 503 Service Unavailable

    参数：
        token: str - 要检查的 Token

    返回：
        bool - 是否在黑名单中

    异常:
        redis.RedisError - Redis 连接或操作异常时抛出（fail-closed）

    安全说明:
        原 is_token_blacklisted 使用 exists（fail-open），Redis 故障时返回 False，
        导致已登出的 Token 在 Redis 宕机期间重新生效。
        修复：改用 exists_strict（fail-closed），Redis 故障时拒绝请求。
    """
    key = RedisKeys.token_blacklist(token)
    if RedisManager.exists_strict(key):
        return True
    payload = decode_access_token(token) or decode_refresh_token(token)
    sid = payload.get("sid") if payload else None
    return bool(sid and RedisManager.exists_strict(f"auth:session:revoked:{sid}"))


def token_remaining_ttl(payload: Dict[str, Any]) -> int:
    """Keep a tombstone through the token's actual expiry, including rounding."""
    return max(1, math.ceil(float(payload["exp"]) - datetime.now(timezone.utc).timestamp()))


def consume_refresh_token(token: str, payload: Dict[str, Any]) -> bool:
    """Atomic NX consumption remains exclusive even if the request lock expires."""
    return RedisManager.set_once_strict(
        RedisKeys.token_blacklist(token), "1", token_remaining_ttl(payload)
    )


# ============================================
# Token 对工具
# ============================================

def create_token_pair(
    user_id: int,
    username: str,
) -> Tuple[str, str, int]:
    """
    创建 Access + Refresh Token 对

    作用：
        登录成功后一次性生成 Access Token 和 Refresh Token。
        返回 (access_token, refresh_token, expires_in)。

    参数：
        user_id: int - 用户ID
        username: str - 用户名

    返回:
        Tuple[str, str, int] - (access_token, refresh_token, access_token有效期秒数)
    """
    token_data = {"sub": str(user_id), "username": username, "sid": uuid4().hex}

    access_token = create_access_token(token_data)
    refresh_token = create_refresh_token(token_data)
    expires_in = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60

    return access_token, refresh_token, expires_in
