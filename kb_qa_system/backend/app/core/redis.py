"""
Redis 连接模块

作用：
    管理 Redis 连接，提供缓存、限流、Token 黑名单、任务队列等功能。
    Redis 是生产环境的核心基础设施。

实现方式：
    1. 使用 redis-py 库连接 Redis
    2. 使用连接池管理连接
    3. 提供同步和异步两种客户端
    4. 统一的 key 前缀管理，避免不同环境 key 冲突
"""

import redis
import redis.asyncio as aioredis
from typing import Optional, Any, Union
import json
import logging
import uuid

from app.core.config import settings

logger = logging.getLogger(__name__)


# ============================================
# 同步 Redis 客户端
# ============================================

"""
作用：
    创建同步 Redis 客户端，用于不需要异步的场景（如 Celery 任务）。

实现方式：
    - ConnectionPool: 连接池管理连接
    - decode_responses: 自动解码为字符串
    - health_check_interval: 定期健康检查
"""
redis_pool = redis.ConnectionPool.from_url(
    settings.REDIS_URL,
    decode_responses=True,  # 自动将字节解码为字符串
    max_connections=50,     # 最大连接数
    health_check_interval=30,  # 每30秒健康检查
)

# 同步 Redis 客户端实例
redis_client = redis.Redis(connection_pool=redis_pool)


# ============================================
# 异步 Redis 客户端
# ============================================

"""
作用：
    创建异步 Redis 客户端，用于 FastAPI 异步路由。
    异步客户端不会阻塞事件循环，性能更好。
"""
async_redis_pool = aioredis.ConnectionPool.from_url(
    settings.REDIS_URL,
    decode_responses=True,
    max_connections=50,
    health_check_interval=30,
)

# 异步 Redis 客户端实例
async_redis_client = aioredis.Redis(connection_pool=async_redis_pool)


# ============================================
# Redis 工具类
# ============================================

class RedisManager:
    """
    Redis 管理器

    作用：
        提供 Redis 操作的统一接口，包含 key 前缀管理、序列化等功能。

    使用方式：
        # 同步
        RedisManager.set("user:1", {"name": "张三"})
        data = RedisManager.get("user:1")

        # 异步
        await RedisManager.async_set("user:1", {"name": "张三"})
        data = await RedisManager.async_get("user:1")
    """

    # ============================================
    # Key 管理
    # ============================================

    @staticmethod
    def make_key(key: str) -> str:
        """
        构建带前缀的 Redis key

        作用：
            所有 key 统一加前缀，避免不同环境（开发/生产）key 冲突。
            前缀格式：kb_qa:{environment}:{key}

        参数：
            key: str - 原始 key

        返回：
            str - 带前缀的 key

        示例：
            RedisManager.make_key("user:1")
            # 返回 "kb_qa:development:user:1"
        """
        return f"{settings.redis_key_prefix}{key}"

    # ============================================
    # 同步操作
    # ============================================

    @staticmethod
    def set(
        key: str,
        value: Any,
        ttl: Optional[int] = None,
        nx: bool = False,
    ) -> bool:
        """
        设置缓存（同步）

        作用：
            将数据存入 Redis，支持设置过期时间和 NX（仅当 key 不存在时设置）。

        实现方式：
            - 复杂对象自动 JSON 序列化
            - 字符串直接存储
            - 可选设置 TTL（过期时间）
            - nx=True 时使用 SET NX（分布式锁场景）

        参数：
            key: str - 缓存 key（不含前缀）
            value: Any - 缓存值（字符串/数字/字典/列表等）
            ttl: Optional[int] - 过期时间（秒），None 表示永不过期
            nx: bool - 是否仅当 key 不存在时设置（用于分布式锁），默认 False

        返回：
            bool - 是否设置成功（nx=True 时，key 已存在返回 False）

        示例：
            RedisManager.set("user:1", {"name": "张三"}, ttl=3600)
            RedisManager.set("lock:doc:1", "1", ttl=600, nx=True)  # 分布式锁
        """
        try:
            full_key = RedisManager.make_key(key)

            # 序列化
            if isinstance(value, (dict, list, tuple)):
                value = json.dumps(value, ensure_ascii=False)
            elif not isinstance(value, (str, int, float, bytes)):
                value = json.dumps(value, ensure_ascii=False, default=str)

            if nx:
                # SET NX：仅当 key 不存在时设置（用于分布式锁）
                # 作用：原子性地获取锁，避免竞态条件
                if ttl:
                    result = redis_client.set(full_key, value, nx=True, ex=ttl)
                else:
                    result = redis_client.set(full_key, value, nx=True)
                return bool(result)
            elif ttl:
                redis_client.setex(full_key, ttl, value)
                return True
            else:
                redis_client.set(full_key, value)
                return True
        except Exception as e:
            logger.error(f"Redis set 失败: {key}, 错误: {e}")
            return False

    @staticmethod
    def get(key: str, default: Any = None) -> Any:
        """
        获取缓存（同步）

        作用：
            从 Redis 读取数据，自动尝试 JSON 反序列化。
            同时记录缓存命中/未命中指标（E2-03）。

        参数：
            key: str - 缓存 key（不含前缀）
            default: Any - key 不存在时返回的默认值

        返回：
            Any - 缓存值，不存在则返回 default

        示例：
            data = RedisManager.get("user:1")
        """
        try:
            full_key = RedisManager.make_key(key)
            value = redis_client.get(full_key)

            if value is None:
                # E2-03: 记录缓存未命中
                try:
                    from app.core.prometheus_metrics import record_cache_miss
                    record_cache_miss()
                except Exception:
                    pass
                return default

            # E2-03: 记录缓存命中
            try:
                from app.core.prometheus_metrics import record_cache_hit
                record_cache_hit()
            except Exception:
                pass

            # 尝试 JSON 反序列化
            try:
                return json.loads(value)
            except (json.JSONDecodeError, TypeError):
                return value
        except Exception as e:
            logger.error(f"Redis get 失败: {key}, 错误: {e}")
            return default

    @staticmethod
    def delete(key: str) -> bool:
        """
        删除缓存（同步）

        参数：
            key: str - 缓存 key（不含前缀）

        返回：
            bool - 是否删除成功
        """
        try:
            full_key = RedisManager.make_key(key)
            redis_client.delete(full_key)
            return True
        except Exception as e:
            logger.error(f"Redis delete 失败: {key}, 错误: {e}")
            return False

    @staticmethod
    def exists(key: str) -> bool:
        """
        检查 key 是否存在（同步，fail-open）

        作用：
            检查 key 是否存在。Redis 异常时返回 False（fail-open）。
            适用于非安全场景（如缓存检查），异常时回退到正常流程。

        参数：
            key: str - 缓存 key（不含前缀）

        返回：
            bool - 是否存在
        """
        try:
            full_key = RedisManager.make_key(key)
            return bool(redis_client.exists(full_key))
        except Exception as e:
            logger.error(f"Redis exists 失败: {key}, 错误: {e}")
            return False

    @staticmethod
    def exists_strict(key: str) -> bool:
        """
        检查 key 是否存在（同步，fail-closed，用于安全场景）

        作用：
            检查 key 是否存在。Redis 异常时抛出异常（fail-closed）。
            适用于安全场景（如 Token 黑名单检查），Redis 故障时必须拒绝请求，
            而不是放行（fail-open 会导致已登出的 Token 仍然有效）。

        实现方式：
            - 与 exists 不同，异常不吞掉，直接抛出
            - 调用方应捕获 RedisError 并返回 503 Service Unavailable

        参数：
            key: str - 缓存 key（不含前缀）

        返回：
            bool - 是否存在

        异常:
            redis.RedisError - Redis 连接或操作异常时抛出

        使用示例:
            try:
                if RedisManager.exists_strict(blacklist_key):
                    # Token 已被拉黑
                    ...
            except redis.RedisError:
                # Redis 故障，安全场景应拒绝请求
                raise HTTPException(503, "认证服务暂时不可用")
        """
        full_key = RedisManager.make_key(key)
        result = redis_client.exists(full_key)
        return bool(result)

    @staticmethod
    def increment(
        key: str,
        amount: int = 1,
        ttl: Optional[int] = None,
        strict: bool = False,
    ) -> int:
        """
        自增（同步）

        作用：
            常用于计数器（如登录失败次数、限流计数）。

        参数：
            key: str - 缓存 key
            amount: int - 自增量，默认 1
            ttl: Optional[int] - 首次设置时的过期时间（秒）
            strict: bool - 是否 fail-closed（默认 False）
                False：Redis 异常时返回 0（fail-open，兼容旧调用方，用于非安全场景）
                True：Redis 异常时抛出异常（fail-closed，用于安全场景）
                C-6 修复：限流和登录失败计数必须使用 strict=True，
                          防止 Redis 故障时限流绕过和暴力破解防护失效
                          （原实现异常返回 0，调用方判断 count > limit，
                           0 永远不大于任何值，限流完全失效）

        返回：
            int - 自增后的值

        异常:
            Exception - strict=True 且 Redis 异常时抛出，调用方应捕获并返回 503

        示例：
            # 登录失败计数（安全场景，fail-closed）
            count = RedisManager.increment("login_fail:user:1", ttl=900, strict=True)

            # 普通计数（非安全场景，fail-open）
            count = RedisManager.increment("stats:visits")
        """
        try:
            full_key = RedisManager.make_key(key)
            new_value = redis_client.incrby(full_key, amount)

            # 首次创建时设置过期时间
            if new_value == amount and ttl:
                redis_client.expire(full_key, ttl)

            return new_value
        except Exception as e:
            logger.error(f"Redis increment 失败: {key}, 错误: {e}")
            if strict:
                # C-6: 安全场景 fail-closed，异常向上传播
                # 调用方应捕获并返回 503，拒绝请求而非放行
                raise
            return 0

    @staticmethod
    def expire(key: str, ttl: int) -> bool:
        """
        设置过期时间（同步）

        参数：
            key: str - 缓存 key
            ttl: int - 过期时间（秒）

        返回：
            bool - 是否设置成功
        """
        try:
            full_key = RedisManager.make_key(key)
            return bool(redis_client.expire(full_key, ttl))
        except Exception as e:
            logger.error(f"Redis expire 失败: {key}, 错误: {e}")
            return False

    # ============================================
    # 分布式锁（H-2 修复：UUID 锁值 + Lua 原子释放，防误删）
    # ============================================

    # Lua 脚本：仅当 key 的 value 与传入 token 匹配时才删除（CAS 语义）
    # 作用：防止 A 的锁过期后 B 获取锁，A 的 finally 误删 B 的锁
    _RELEASE_LOCK_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""

    @staticmethod
    def set_once_strict(key: str, value: str, ttl: int) -> bool:
        """Security writes: NX rejects replay; connection failures must propagate."""
        return bool(redis_client.set(RedisManager.make_key(key), value, nx=True, ex=ttl))

    @staticmethod
    def set_many_strict(entries: list[tuple[str, str, int]]) -> bool:
        """Confirm all revocation tombstones in one Redis transaction."""
        with redis_client.pipeline(transaction=True) as pipeline:
            for key, value, ttl in entries:
                pipeline.set(RedisManager.make_key(key), value, ex=ttl)
            return all(pipeline.execute())

    @staticmethod
    def acquire_lock(key: str, ttl: int) -> Optional[str]:
        """
        获取分布式锁（H-2 修复）

        作用：
            原子获取分布式锁，返回唯一锁标识（token）。
            替代 set(nx=True) + 固定值 "1" 的旧模式，避免锁值不唯一导致的误删风险。

        实现方式：
            - 生成随机 UUID 作为锁值（token）
            - SET key token NX EX ttl 原子获取
            - 返回 token（调用方需保存，释放时传入 release_lock）

        参数：
            key: str - 锁 key（不含前缀）
            ttl: int - 锁过期时间（秒），防死锁

        返回：
            Optional[str] - 获取成功返回 token，失败（锁已被占用）返回 None

        使用示例:
            token = RedisManager.acquire_lock("lock:doc:1", ttl=600)
            if token is None:
                raise HTTPException(409, "操作进行中")
            try:
                # 业务逻辑
            finally:
                RedisManager.release_lock("lock:doc:1", token)
        """
        try:
            full_key = RedisManager.make_key(key)
            token = uuid.uuid4().hex
            result = redis_client.set(full_key, token, nx=True, ex=ttl)
            if result:
                return token
            return None
        except Exception as e:
            logger.error(f"Redis acquire_lock 失败: {key}, 错误: {e}")
            return None

    @staticmethod
    def release_lock(key: str, token: str) -> bool:
        """
        释放分布式锁（H-2 修复：Lua 脚本比对值再删）

        作用：
            仅当锁的 value 与 token 匹配时才删除，防止误删他人锁。
            原实现 delete 无条件删除，A 锁过期后 B 获取锁，A 的 finally 会误删 B 的锁。

        实现方式：
            - Lua 脚本原子执行 GET+比对+DEL（避免 TOCTOU）
            - 不匹配返回 False（锁已被他人获取或已过期）

        参数：
            key: str - 锁 key（不含前缀）
            token: str - acquire_lock 返回的锁标识

        返回：
            bool - 是否成功释放（True=自己持有并删除，False=锁已不属于自己）
        """
        try:
            full_key = RedisManager.make_key(key)
            result = redis_client.eval(
                RedisManager._RELEASE_LOCK_SCRIPT, 1, full_key, token
            )
            return bool(result)
        except Exception as e:
            logger.error(f"Redis release_lock 失败: {key}, 错误: {e}")
            return False

    # ============================================
    # 异步操作
    # ============================================

    @staticmethod
    async def async_set(key: str, value: Any, ttl: Optional[int] = None) -> bool:
        """
        设置缓存（异步）

        作用：
            异步版本的 set，用于 FastAPI 异步路由，不阻塞事件循环。

        参数和返回值同同步版本 set。
        """
        try:
            full_key = RedisManager.make_key(key)

            if isinstance(value, (dict, list, tuple)):
                value = json.dumps(value, ensure_ascii=False)
            elif not isinstance(value, (str, int, float, bytes)):
                value = json.dumps(value, ensure_ascii=False, default=str)

            if ttl:
                await async_redis_client.setex(full_key, ttl, value)
            else:
                await async_redis_client.set(full_key, value)

            return True
        except Exception as e:
            logger.error(f"Redis async_set 失败: {key}, 错误: {e}")
            return False

    @staticmethod
    async def async_get(key: str, default: Any = None) -> Any:
        """
        获取缓存（异步）

        作用：
            异步版本的 get，用于 FastAPI 异步路由。
        """
        try:
            full_key = RedisManager.make_key(key)
            value = await async_redis_client.get(full_key)

            if value is None:
                return default

            try:
                return json.loads(value)
            except (json.JSONDecodeError, TypeError):
                return value
        except Exception as e:
            logger.error(f"Redis async_get 失败: {key}, 错误: {e}")
            return default

    @staticmethod
    async def async_delete(key: str) -> bool:
        """
        删除缓存（异步）
        """
        try:
            full_key = RedisManager.make_key(key)
            await async_redis_client.delete(full_key)
            return True
        except Exception as e:
            logger.error(f"Redis async_delete 失败: {key}, 错误: {e}")
            return False

    @staticmethod
    async def async_exists(key: str) -> bool:
        """
        检查 key 是否存在（异步）
        """
        try:
            full_key = RedisManager.make_key(key)
            return bool(await async_redis_client.exists(full_key))
        except Exception as e:
            logger.error(f"Redis async_exists 失败: {key}, 错误: {e}")
            return False

    # ============================================
    # 健康检查
    # ============================================

    @staticmethod
    def ping() -> bool:
        """
        Redis 健康检查

        作用：
            检查 Redis 连接是否正常，用于健康检查接口。

        返回：
            bool - Redis 是否可用
        """
        try:
            return redis_client.ping()
        except Exception:
            return False

    @staticmethod
    def close() -> None:
        """
        关闭 Redis 连接池（C-10 修复）

        作用：
            应用关闭时释放 Redis 连接，避免连接泄漏。
            滚动部署时若不关闭，旧实例的连接会残留，耗尽 Redis 最大连接数，
            导致新实例无法获取连接而启动失败。

        实现方式：
            - 同步连接池 disconnect：关闭所有同步客户端连接
            - 异步连接池 disconnect：关闭所有异步客户端连接
            - 异常隔离：清理失败不影响应用关闭流程

        使用场景：
            在 FastAPI lifespan 的 yield 之后调用，确保应用关闭时释放资源。

        示例：
            # main.py lifespan
            yield
            RedisManager.close()  # 释放 Redis 连接
        """
        try:
            redis_pool.disconnect()
            logger.info("Redis 同步连接池已关闭")
        except Exception as e:
            logger.error(f"关闭 Redis 同步连接池失败: {e}")
        try:
            async_redis_pool.disconnect()
            logger.info("Redis 异步连接池已关闭")
        except Exception as e:
            logger.error(f"关闭 Redis 异步连接池失败: {e}")


# ============================================
# 便捷的 key 命名空间
# ============================================

class RedisKeys:
    """
    Redis Key 命名空间管理

    作用：
        统一管理各类 Redis key，避免散落在各处的硬编码字符串。
        便于维护和查找。

    使用方式：
        key = RedisKeys.token_blacklist("eyJhbGci...")
        RedisManager.set(key, "1", ttl=900)
    """

    @staticmethod
    def token_blacklist(token: str) -> str:
        """
        Token 黑名单 key

        作用：
            存储已登出的 Token，实现主动失效。
        """
        # 使用 token 的哈希值作为 key，避免 token 过长
        import hashlib
        token_hash = hashlib.sha256(token.encode()).hexdigest()[:32]
        return f"auth:blacklist:{token_hash}"

    @staticmethod
    def login_failure(username: str) -> str:
        """
        登录失败计数 key

        作用：
            记录用户登录失败次数，达到阈值后锁定。
        """
        return f"auth:login_fail:{username}"

    @staticmethod
    def user_lock(username: str) -> str:
        """
        用户锁定 key

        作用：
            登录失败次数过多时，锁定用户一段时间。
        """
        return f"auth:lock:{username}"

    @staticmethod
    def rate_limit(identifier: str, window: str) -> str:
        """
        限流计数 key

        作用：
            记录某个标识符（IP/用户ID）在时间窗口内的请求次数。

        参数：
            identifier: str - 标识符（IP 或用户ID）
            window: str - 时间窗口标识（如 "1min", "1hour"）

        返回：
            str - 限流 key
        """
        return f"rate_limit:{window}:{identifier}"

    @staticmethod
    def distributed_lock(resource: str) -> str:
        """
        分布式锁 key

        作用：
            用于分布式互斥锁，防止并发操作同一资源。
            典型场景：文档重新处理、幂等性控制。

        实现方式：
            配合 RedisManager.set(key, "1", ttl=600, nx=True) 使用。
            nx=True 保证原子性获取锁，ttl 防止死锁。

        参数：
            resource: str - 资源标识（如 "doc:123", "user:456"）

        返回：
            str - 分布式锁 key

        使用示例:
            lock_key = RedisKeys.distributed_lock("doc:123")
            if RedisManager.set(lock_key, "1", ttl=600, nx=True):
                # 获取锁成功
                try:
                    ...  # 执行业务逻辑
                finally:
                    RedisManager.delete(lock_key)  # 释放锁
            else:
                # 获取锁失败（已有其他请求在处理）
                raise HTTPException(409, "资源正在被处理")
        """
        return f"lock:{resource}"

    @staticmethod
    def faq_cache(question_hash: str) -> str:
        """
        FAQ 缓存 key

        作用：
            缓存已回答过的问题，相同问题不重复调用 LLM。
        """
        return f"faq:{question_hash}"

    @staticmethod
    def idempotency_lock(user_id: int, key: str) -> str:
        """
        幂等性处理锁 key

        作用：
            防止相同 idempotency_key 的请求并发执行。
            首次请求获取锁后处理，重复请求检测到锁存在则拒绝或返回缓存。

        实现方式：
            配合 RedisManager.set(key, "1", ttl=300, nx=True) 使用。
            nx=True 保证原子性获取锁，ttl 防止处理异常导致死锁。

        参数：
            user_id: int - 用户ID（隔离不同用户的幂等性 key）
            key: str - 幂等性键（由客户端提供）

        返回：
            str - 幂等性锁 key

        使用示例:
            lock_key = RedisKeys.idempotency_lock(user_id, "req-abc-123")
            if RedisManager.set(lock_key, "1", ttl=300, nx=True):
                # 首次请求，正常处理
                ...
            else:
                # 重复请求，返回缓存或 409
                ...
        """
        import hashlib
        key_hash = hashlib.sha256(key.encode()).hexdigest()[:16]
        return f"idempotency:lock:{user_id}:{key_hash}"

    @staticmethod
    def idempotency_result(user_id: int, key: str) -> str:
        """
        幂等性结果缓存 key

        作用：
            存储已完成的幂等性请求结果，重复请求直接返回缓存。
            仅适用于非流式接口（流式接口无法缓存完整响应）。

        参数：
            user_id: int - 用户ID
            key: str - 幂等性键

        返回：
            str - 幂等性结果 key
        """
        import hashlib
        key_hash = hashlib.sha256(key.encode()).hexdigest()[:16]
        return f"idempotency:result:{user_id}:{key_hash}"

    @staticmethod
    def document_progress(document_id: int) -> str:
        """
        文档处理进度 key

        作用：
            存储文档处理进度，供前端轮询查询。
        """
        return f"document:progress:{document_id}"

    @staticmethod
    def conversation_summary(conversation_id: int) -> str:
        """
        对话摘要 key

        作用：
            缓存对话历史摘要，用于记忆衰退机制。
        """
        return f"conversation:summary:{conversation_id}"

    @staticmethod
    def llm_cache(query_hash: str) -> str:
        """
        LLM 响应缓存 key

        作用：
            缓存 LLM 响应，避免重复调用。
        """
        return f"llm:cache:{query_hash}"

    @staticmethod
    def circuit_breaker(service: str) -> str:
        """
        熔断器状态 key

        作用：
            记录服务熔断状态（开/关/半开）。

        参数：
            service: str - 服务名称（如 "llm", "embedding"）
        """
        return f"circuit_breaker:{service}"
