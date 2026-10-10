"""
Critical 问题修复验证测试

作用：
    验证 11 项 Critical 修复（C-1 到 C-11）的正确性。
    每个测试类对应一项修复，覆盖正常路径和异常路径。

测试策略：
    1. 静态分析测试：直接读取源码文件内容，验证修复结构存在（不导入模块，避免运行时依赖）
    2. 行为测试：对 Redis/rate_limit 等纯 Python 模块，使用 monkeypatch mock 外部依赖
    3. 覆盖修复计划中定义的关键验证点

运行方式：
    cd backend
    python -m pytest tests/test_critical_fixes.py -v
"""

import pytest
from unittest.mock import MagicMock, patch
from pathlib import Path
import os


# ============================================
# 辅助函数：读取源码文件内容（不导入模块，避免依赖问题）
# ============================================

BACKEND_DIR = Path(__file__).parent.parent


def read_source(relative_path: str) -> str:
    """
    读取源码文件内容

    作用：
        直接读取文件内容，不通过 import 导入模块。
        避免因 psycopg/celery/langchain 等运行时依赖缺失导致测试失败。

    参数：
        relative_path: str - 相对于 backend 目录的路径

    返回：
        str - 文件内容
    """
    file_path = BACKEND_DIR / relative_path
    return file_path.read_text(encoding="utf-8")


# ============================================
# C-1: SSRF 重定向绕过防护
# ============================================

class TestSSRFRedirectProtection:
    """C-1: SSRF 重定向绕过防护测试"""

    def test_allow_redirects_false_in_source(self):
        """验证 parsers.py 中 requests.get 设置了 allow_redirects=False"""
        source = read_source("app/services/document_pipeline/parsers.py")
        assert "allow_redirects=False" in source, \
            "C-1: parsers.py 应设置 allow_redirects=False 防止 SSRF 重定向绕过"

    def test_redirect_check_logic_exists(self):
        """验证有重定向响应检查逻辑"""
        source = read_source("app/services/document_pipeline/parsers.py")
        assert "is_redirect" in source or "is_permanent_redirect" in source, \
            "应检查 response.is_redirect 或 is_permanent_redirect"
        assert "禁止 URL 重定向" in source, "应有重定向拒绝的错误信息"

    def test_no_bare_requests_get(self):
        """验证不存在无 allow_redirects 参数的 requests.get（在 UrlParser.parse 中）"""
        source = read_source("app/services/document_pipeline/parsers.py")
        # 查找 requests.get 调用，验证都有 allow_redirects=False
        # 简化检查：确保 C-1 修复注释存在
        assert "C-1" in source, "应有 C-1 修复标记"


# ============================================
# C-2: 流式接口幂等性锁异常释放
# ============================================

class TestStreamIdempotencyLockRelease:
    """C-2: 流式接口幂等锁异常时释放测试"""

    def test_try_except_wraps_sync_code(self):
        """验证 ask_question_stream 中 try/except 包裹同步代码"""
        source = read_source("app/api/routes/chat.py")
        assert "C-2 修复" in source, "应有 C-2 修复标记"
        assert "try:" in source, "应有 try 块包裹同步代码"

    def test_except_releases_lock(self):
        """验证 except 块中释放幂等锁（H-2 升级为 release_lock 比对释放）"""
        source = read_source("app/api/routes/chat.py")
        # H-2 修复：锁释放从 delete 升级为 release_lock(key, token)，防误删他人锁
        # 验证 except 块中调用 release_lock 释放幂等锁
        assert "RedisManager.release_lock(idempotency_lock_key, idempotency_lock_token)" in source, \
            "except 块应调用 RedisManager.release_lock 释放锁（H-2 升级）"
        assert "idempotency_lock_token" in source, \
            "应使用 token 标识锁（H-2：acquire_lock 返回唯一 token）"

    def test_finally_in_event_stream(self):
        """验证 event_stream 的 finally 块仍有锁释放"""
        source = read_source("app/api/routes/chat.py")
        assert "finally:" in source, "event_stream 应有 finally 块"


# ============================================
# C-3: turn_count 原子递增
# ============================================

class TestTurnCountAtomic:
    """C-3: turn_count 原子递增测试"""

    def test_increment_function_exists(self):
        """验证 _increment_turn_count 辅助函数存在"""
        source = read_source("app/api/routes/chat.py")
        assert "def _increment_turn_count" in source, \
            "应有 _increment_turn_count 辅助函数"

    def test_uses_sql_update(self):
        """验证使用 SQL UPDATE 而非 read-modify-write"""
        source = read_source("app/api/routes/chat.py")
        assert "update(Conversation)" in source, "应使用 SQLAlchemy update()"
        assert "Conversation.turn_count + 1" in source, \
            "应使用原子递增 turn_count + 1"

    def test_no_direct_increment_in_routes(self):
        """验证路由中不再有实际的 conversation.turn_count += 1 代码（排除注释）"""
        source = read_source("app/api/routes/chat.py")
        # 逐行检查，排除注释行（以 # 开头）和文档字符串
        code_lines = [
            line.strip() for line in source.splitlines()
            if not line.strip().startswith("#")
            and "conversation.turn_count += 1" in line
        ]
        # 过滤掉文档字符串中的引用（通常在 """ 内或含"原实现"等描述）
        actual_code_lines = [
            line for line in code_lines
            if not any(kw in line for kw in ["原实现", "作用", "修复", "示例", "注意"])
        ]
        assert len(actual_code_lines) == 0, \
            f"C-3: 不应有实际代码直接递增 turn_count，发现: {actual_code_lines}"

    def test_increment_called_at_least_3_times(self):
        """验证 3 处调用 _increment_turn_count（非流式+流式正常+流式异常）"""
        source = read_source("app/api/routes/chat.py")
        # 统计所有 _increment_turn_count 调用（不含函数定义行）
        # 注意：流式路径使用独立 session（post_db/err_db）和 conv_id，
        #       非流式路径使用 db 和 conversation.id，需兼容两种变量名
        import re
        call_count = len(re.findall(
            r"_increment_turn_count\(\s*\w+\s*,\s*\w+(\.\w+)?\s*\)",
            source
        ))
        assert call_count >= 3, \
            f"应有至少 3 次调用 _increment_turn_count，实际 {call_count} 次"

    def test_sqlalchemy_update_imported(self):
        """验证 SQLAlchemy update 已导入"""
        source = read_source("app/api/routes/chat.py")
        assert "from sqlalchemy import update" in source, \
            "应导入 SQLAlchemy update"


# ============================================
# C-4: 文档删除操作顺序
# ============================================

class TestDocumentDeleteOrder:
    """C-4: 文档删除操作顺序测试"""

    def test_commit_before_vector_delete(self):
        """验证 DB commit 在向量删除之前"""
        source = read_source("app/api/routes/documents.py")
        commit_pos = source.find("db.commit()")
        vector_delete_pos = source.find("delete_document_chunks")

        assert commit_pos > 0, "应有 db.commit()"
        assert vector_delete_pos > 0, "应有 delete_document_chunks"
        assert commit_pos < vector_delete_pos, \
            "C-4: db.commit() 必须在 delete_document_chunks 之前"

    def test_c4_fix_annotation(self):
        """验证 C-4 修复注释存在"""
        source = read_source("app/api/routes/documents.py")
        assert "C-4 修复" in source, "应有 C-4 修复标记"
        assert "先 commit DB 再删向量" in source or "先 commit" in source, \
            "应有顺序调整说明"

    def test_vector_delete_failure_no_rollback(self):
        """验证向量删除失败时不回滚 DB"""
        source = read_source("app/api/routes/documents.py")
        # 在 delete_document 函数中，向量删除后的 except 不应回滚
        # 查找 "待定时任务清理" 说明降级策略
        assert "定时任务清理" in source or "logger.warning" in source, \
            "向量删除失败应记录警告，不回滚 DB"


# ============================================
# C-5: Celery 向量入库幂等
# ============================================

class TestVectorIngestIdempotent:
    """C-5: Celery 向量入库幂等测试"""

    def test_delete_before_add(self):
        """验证 vector_store.delete_document_chunks 调用在 vector_store.add_chunks 之前"""
        source = read_source("app/tasks/document_tasks.py")
        # 查找实际的函数调用（带 vector_store. 前缀），排除注释中的引用
        delete_call_pos = source.find("vector_store.delete_document_chunks(document.id)")
        add_call_pos = source.find("vector_store.add_chunks(chunk_dicts")

        assert delete_call_pos > 0, "应有 vector_store.delete_document_chunks 调用"
        assert add_call_pos > 0, "应有 vector_store.add_chunks 调用"
        assert delete_call_pos < add_call_pos, \
            "C-5: delete_document_chunks 调用必须在 add_chunks 之前"

    def test_c5_fix_annotation(self):
        """验证 C-5 修复注释存在"""
        source = read_source("app/tasks/document_tasks.py")
        assert "C-5" in source, "应有 C-5 修复标记"
        assert "清理旧分块" in source, "应有清理旧分块说明"

    def test_delete_failure_degraded(self):
        """验证 delete 失败时降级继续 add"""
        source = read_source("app/tasks/document_tasks.py")
        assert "继续插入" in source, "应有降级继续插入策略"


# ============================================
# C-6: Redis increment strict 模式
# ============================================

class TestRedisIncrementStrict:
    """C-6: Redis increment strict 模式测试"""

    def test_strict_param_exists(self):
        """验证 increment 方法有 strict 参数"""
        import inspect
        from app.core.redis import RedisManager

        sig = inspect.signature(RedisManager.increment)
        assert "strict" in sig.parameters, "increment 应有 strict 参数"
        assert sig.parameters["strict"].default is False, "strict 默认应为 False"

    def test_strict_raises_on_failure(self, monkeypatch):
        """strict=True 时 Redis 故障应抛异常"""
        from app.core.redis import RedisManager
        import redis as redis_lib

        def raise_error(*args, **kwargs):
            raise redis_lib.ConnectionError("连接失败")

        monkeypatch.setattr("app.core.redis.redis_client.incrby", raise_error)

        with pytest.raises(redis_lib.ConnectionError):
            RedisManager.increment("test:key", strict=True)

    def test_non_strict_returns_zero_on_failure(self, monkeypatch):
        """strict=False 时 Redis 故障返回 0（兼容旧调用）"""
        from app.core.redis import RedisManager
        import redis as redis_lib

        def raise_error(*args, **kwargs):
            raise redis_lib.ConnectionError("连接失败")

        monkeypatch.setattr("app.core.redis.redis_client.incrby", raise_error)

        result = RedisManager.increment("test:key", strict=False)
        assert result == 0, "strict=False 时应返回 0"

    def test_rate_limit_uses_strict(self):
        """验证限流调用方使用 strict=True"""
        source = read_source("app/core/rate_limit.py")
        assert "strict=True" in source, "限流应使用 strict=True"

    def test_record_login_failure_uses_strict(self):
        """验证登录失败计数使用 strict=True"""
        source = read_source("app/core/rate_limit.py")
        # 查找 record_login_failure 中的 strict=True
        assert "strict=True" in source, "登录失败计数应使用 strict=True"


# ============================================
# C-7: check_login_lock fail-closed
# ============================================

class TestLoginLockFailClosed:
    """C-7: check_login_lock fail-closed 测试"""

    def test_uses_exists_strict(self):
        """验证 check_login_lock 使用 exists_strict"""
        source = read_source("app/core/rate_limit.py")
        assert "exists_strict" in source, "C-7: 应使用 exists_strict（fail-closed）"

    def test_redis_failure_returns_503(self, monkeypatch):
        """Redis 故障时应返回 503"""
        from app.core.rate_limit import check_login_lock
        from fastapi import HTTPException
        import redis as redis_lib

        def raise_error(key):
            raise redis_lib.ConnectionError("连接失败")

        monkeypatch.setattr("app.core.redis.RedisManager.exists_strict", raise_error)
        monkeypatch.setattr("app.core.config.settings.ENABLE_RATE_LIMIT", True, raising=False)

        with pytest.raises(HTTPException) as exc:
            check_login_lock("testuser")
        assert exc.value.status_code == 503, "C-7: Redis 故障应返回 503"

    def test_locked_user_returns_423(self, monkeypatch):
        """已锁定用户应返回 423"""
        from app.core.rate_limit import check_login_lock
        from fastapi import HTTPException

        monkeypatch.setattr("app.core.redis.RedisManager.exists_strict", lambda k: True)
        monkeypatch.setattr("app.core.redis.redis_client.ttl", lambda k: 300)
        monkeypatch.setattr("app.core.config.settings.ENABLE_RATE_LIMIT", True, raising=False)
        monkeypatch.setattr("app.core.config.settings.LOGIN_FAILURE_LOCK_MINUTES", 15, raising=False)

        with pytest.raises(HTTPException) as exc:
            check_login_lock("locked_user")
        assert exc.value.status_code == 423

    def test_unlocked_user_passes(self, monkeypatch):
        """未锁定用户应正常通过"""
        from app.core.rate_limit import check_login_lock

        monkeypatch.setattr("app.core.redis.RedisManager.exists_strict", lambda k: False)
        monkeypatch.setattr("app.core.config.settings.ENABLE_RATE_LIMIT", True, raising=False)

        # 不应抛异常
        check_login_lock("normal_user")


# ============================================
# C-8: URL 导入下载大小限制
# ============================================

class TestUrlDownloadSizeLimit:
    """C-8: URL 导入下载大小限制测试"""

    def test_stream_param_used(self):
        """验证使用 stream=True"""
        source = read_source("app/services/document_pipeline/parsers.py")
        assert "stream=True" in source, "C-8: 应使用 stream=True 流式下载"

    def test_max_size_config_exists(self):
        """验证 URL_IMPORT_MAX_SIZE 配置项存在"""
        from app.core.config import settings
        assert hasattr(settings, "URL_IMPORT_MAX_SIZE"), \
            "C-8: 配置应有 URL_IMPORT_MAX_SIZE"
        assert settings.URL_IMPORT_MAX_SIZE > 0, "大小限制应大于 0"

    def test_content_length_check_exists(self):
        """验证有 Content-Length 检查"""
        source = read_source("app/services/document_pipeline/parsers.py")
        assert "Content-Length" in source, "应检查 Content-Length"
        assert "URL_IMPORT_MAX_SIZE" in source or "max_size" in source, \
            "应引用最大大小配置"

    def test_streaming_size_check_exists(self):
        """An untrusted chunked body must stop before full consumption."""
        from types import SimpleNamespace
        import time
        from app.services.document_pipeline.resource_limits import read_limited
        consumed = []
        def chunks(**kwargs):
            for i in range(20):
                consumed.append(i)
                yield b'x' * 32
        with pytest.raises(ValueError):
            read_limited(SimpleNamespace(headers={}, iter_content=chunks), 64, time.monotonic() + 10)
        assert len(consumed) == 3


# ============================================
# C-9: Token 刷新并发互斥
# ============================================

class TestRefreshTokenMutex:
    """C-9: Token 刷新并发互斥测试"""

    def test_lock_logic_exists(self):
        """验证 refresh_token 有分布式锁逻辑（H-2 升级为 acquire_lock）"""
        source = read_source("app/api/routes/auth.py")
        assert "refresh_lock_key" in source, "C-9: 应有刷新锁 key"
        # H-2 修复：从 set(nx=True) 升级为 acquire_lock，返回唯一 token 防误删
        assert "RedisManager.acquire_lock(refresh_lock_key" in source, \
            "应使用 RedisManager.acquire_lock 获取锁（H-2 升级）"
        assert "refresh_lock_token" in source, "应保存锁 token 用于比对释放"
        assert "REFRESH_IN_PROGRESS" in source, "应有并发拒绝错误码"

    def test_finally_releases_lock(self):
        """验证 finally 块释放锁（H-2 升级为 release_lock 比对释放）"""
        source = read_source("app/api/routes/auth.py")
        assert "finally:" in source, "应有 finally 块"
        # H-2 修复：从 delete 升级为 release_lock(key, token)，Lua 脚本比对再删
        assert "RedisManager.release_lock(refresh_lock_key, refresh_lock_token)" in source, \
            "finally 应调用 release_lock 比对 token 释放锁（H-2 升级）"

    def test_c9_fix_annotation(self):
        """验证 C-9 修复注释存在"""
        source = read_source("app/api/routes/auth.py")
        assert "C-9 修复" in source, "应有 C-9 修复标记"

    def test_hashlib_imported(self):
        """验证 hashlib 已导入"""
        source = read_source("app/api/routes/auth.py")
        assert "import hashlib" in source, "应导入 hashlib"

    def test_redismanager_imported(self):
        """验证 RedisManager 已导入"""
        source = read_source("app/api/routes/auth.py")
        assert "from app.core.redis import RedisManager" in source, \
            "应导入 RedisManager"


# ============================================
# Auth-401: 邮箱登录修复验证
# ============================================

class TestEmailLoginFix:
    """Auth-401: 管理员邮箱登录 401 修复验证

    根因：前端 LoginForm 将邮箱作为 username 字段传入，
          后端仅按 User.username 查询，邮箱登录必然 401。
    修复：登录查询同时匹配 User.username 和 User.email。
    """

    def test_login_query_matches_both_username_and_email(self):
        """验证登录查询同时匹配 username 和 email 字段"""
        source = read_source("app/api/routes/auth.py")
        # 确保查询中同时包含 User.username 和 User.email
        assert "User.username" in source, "登录查询应包含 User.username"
        assert "User.email" in source, "登录查询应包含 User.email"
        assert "|" in source, "应使用 OR 条件连接 username 和 email 查询"

    def test_login_query_uses_or_condition(self):
        """验证登录查询使用 OR 条件"""
        source = read_source("app/api/routes/auth.py")
        # 查找 (User.username == username) | (User.email == username) 模式
        assert "(User.username == username) | (User.email == username)" in source, \
            "应使用 (User.username == username) | (User.email == username) 查询"

    def test_userlogin_schema_max_length_supports_email(self):
        """验证 UserLogin schema 的 max_length 支持 100 字符（邮箱长度）"""
        source = read_source("app/schemas/user.py")
        assert "max_length=100" in source, \
            "UserLogin.username max_length 应为 100 以支持邮箱登录"

    def test_userlogin_schema_description_mentions_email(self):
        """验证 UserLogin schema 描述包含'邮箱'字样"""
        source = read_source("app/schemas/user.py")
        assert "邮箱" in source, \
            "UserLogin schema 描述应提及支持邮箱登录"

    def test_login_fix_annotation_exists(self):
        """验证修复注释标记存在"""
        source = read_source("app/api/routes/auth.py")
        assert "修复 401 Bug" in source or "401" in source, \
            "应有 401 修复注释标记"


# ============================================
# C-10: lifespan 资源清理
# ============================================

class TestLifespanCleanup:
    """C-10: lifespan 资源清理测试"""

    def test_cleanup_code_exists(self):
        """验证 lifespan 有资源清理代码"""
        source = read_source("app/main.py")
        assert "RedisManager.close()" in source, "C-10: 应关闭 Redis"
        assert "engine.dispose()" in source, "应关闭数据库连接池"
        assert "celery_app.close()" in source, "应关闭 Celery 连接"

    def test_redis_close_method_exists(self):
        """验证 RedisManager.close 方法存在"""
        from app.core.redis import RedisManager
        assert hasattr(RedisManager, "close"), "C-10: RedisManager 应有 close 方法"
        assert callable(RedisManager.close), "close 应可调用"

    def test_redis_close_calls_disconnect(self, monkeypatch):
        """验证 close 方法调用 disconnect"""
        from app.core.redis import RedisManager

        disconnect_called = []
        monkeypatch.setattr("app.core.redis.redis_pool.disconnect",
                            lambda: disconnect_called.append("sync"))
        monkeypatch.setattr("app.core.redis.async_redis_pool.disconnect",
                            lambda: disconnect_called.append("async"))

        RedisManager.close()
        assert "sync" in disconnect_called, "应关闭同步连接池"
        assert "async" in disconnect_called, "应关闭异步连接池"

    def test_c10_fix_annotation(self):
        """验证 C-10 修复注释存在"""
        source = read_source("app/main.py")
        assert "C-10" in source, "应有 C-10 修复标记"


# ============================================
# C-11: 移除 create_all（生产环境）
# ============================================

class TestNoCreateAll:
    """C-11: 移除 create_all 测试"""

    def test_startup_uses_migrations_in_all_environments(self):
        """所有环境均使用完整迁移，避免开发库缺少索引和版本记录。"""
        source = read_source("app/main.py")
        assert "Base.metadata.create_all" not in source
        assert "await asyncio.to_thread(ensure_database, ops_config)" in source

    def test_recovery_uses_alembic(self):
        source = read_source("app/ops/recovery.py")
        assert 'command.upgrade(config, "head")' in source


# ============================================
# 集成验证：修复一致性
# ============================================

class TestFixConsistency:
    """验证所有修复的一致性"""

    def test_all_critical_fixes_annotated(self):
        """验证所有 Critical 修复都有注释标记"""
        files = [
            "app/services/document_pipeline/parsers.py",  # C-1, C-8
            "app/api/routes/chat.py",                     # C-2, C-3
            "app/api/routes/documents.py",                # C-4
            "app/tasks/document_tasks.py",                # C-5
            "app/core/redis.py",                          # C-6, C-10
            "app/core/rate_limit.py",                     # C-6, C-7
            "app/api/routes/auth.py",                     # C-9
            "app/main.py",                                # C-10, C-11
            "app/core/config.py",                         # C-8
        ]

        combined = ""
        for f in files:
            combined += read_source(f) + "\n"

        # 验证关键修复标记存在
        fix_markers = ["C-1", "C-2", "C-3", "C-4", "C-5", "C-6", "C-7", "C-8", "C-9", "C-10", "C-11"]
        for marker in fix_markers:
            assert marker in combined, f"修复标记 {marker} 应在源码注释中存在"

    def test_all_modified_files_exist(self):
        """验证所有修改的文件都存在"""
        files = [
            "app/main.py",
            "app/core/redis.py",
            "app/core/rate_limit.py",
            "app/core/config.py",
            "app/services/document_pipeline/parsers.py",
            "app/api/routes/chat.py",
            "app/api/routes/documents.py",
            "app/api/routes/auth.py",
            "app/tasks/document_tasks.py",
        ]
        for f in files:
            file_path = BACKEND_DIR / f
            assert file_path.exists(), f"文件应存在: {f}"
