"""
Phase C 系统性修复 - 单元测试

作用：
    验证 Phase C 修复的关键逻辑正确性，覆盖以下修复项：
    - P0-7: QuestionRequest 的 idempotency_key 校验 + question 去空白
    - P1-13: 密码复杂度校验（需 user schema）
    - 幂等性 key 生成逻辑
    - fail-closed 安全逻辑

实现方式：
    使用 unittest + mock，不依赖外部服务（Redis/DB/LLM）
    通过 mock 隔离外部依赖，聚焦验证修复逻辑本身
"""

import sys
import os
import unittest
from unittest.mock import patch, MagicMock

# 添加项目根目录到 sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ============================================
# 测试 1: QuestionRequest 校验（P0-7 + P1-13）
# ============================================

class TestQuestionRequestValidation(unittest.TestCase):
    """
    测试 QuestionRequest Schema 的校验逻辑

    覆盖修复：
        - P0-7: idempotency_key 字段格式校验
        - P1-13: question 去空白校验
    """

    def test_valid_question(self):
        """测试合法的问题请求"""
        from app.schemas.chat import QuestionRequest
        req = QuestionRequest(question="如何使用异步编程？")
        self.assertEqual(req.question, "如何使用异步编程？")
        self.assertIsNone(req.idempotency_key)
        self.assertFalse(req.stream)

    def test_question_strips_whitespace(self):
        """测试 question 自动去除首尾空白（P1-13）"""
        from app.schemas.chat import QuestionRequest
        req = QuestionRequest(question="  如何使用异步编程？  ")
        self.assertEqual(req.question, "如何使用异步编程？")

    def test_question_blank_rejected(self):
        """测试纯空白问题被拒绝（P1-13）"""
        from app.schemas.chat import QuestionRequest
        from pydantic import ValidationError
        with self.assertRaises(ValidationError) as ctx:
            QuestionRequest(question="   ")
        self.assertIn("不能为空白", str(ctx.exception))

    def test_question_empty_rejected(self):
        """测试空字符串问题被拒绝"""
        from app.schemas.chat import QuestionRequest
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            QuestionRequest(question="")

    def test_idempotency_key_valid(self):
        """测试合法的 idempotency_key（P0-7）"""
        from app.schemas.chat import QuestionRequest
        req = QuestionRequest(question="测试问题", idempotency_key="req-abc-123")
        self.assertEqual(req.idempotency_key, "req-abc-123")

    def test_idempotency_key_underscore_hyphen(self):
        """测试 idempotency_key 允许下划线和连字符"""
        from app.schemas.chat import QuestionRequest
        req = QuestionRequest(question="测试", idempotency_key="req_abc-123_XYZ")
        self.assertEqual(req.idempotency_key, "req_abc-123_XYZ")

    def test_idempotency_key_rejects_special_chars(self):
        """测试 idempotency_key 拒绝特殊字符（防注入）"""
        from app.schemas.chat import QuestionRequest
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            QuestionRequest(question="测试", idempotency_key="req;rm -rf")

    def test_idempotency_key_rejects_spaces(self):
        """测试 idempotency_key 拒绝空格"""
        from app.schemas.chat import QuestionRequest
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            QuestionRequest(question="测试", idempotency_key="req abc")

    def test_idempotency_key_rejects_too_long(self):
        """测试 idempotency_key 长度限制"""
        from app.schemas.chat import QuestionRequest
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            QuestionRequest(question="测试", idempotency_key="a" * 101)

    def test_question_max_length(self):
        """测试 question 超长被拒绝"""
        from app.schemas.chat import QuestionRequest
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            QuestionRequest(question="x" * 2001)


# ============================================
# 测试 2: RedisKeys 幂等性 key 生成（P0-7）
# ============================================

class TestRedisKeysIdempotency(unittest.TestCase):
    """
    测试 RedisKeys 的幂等性 key 生成

    覆盖修复：
        - P0-7: idempotency_lock 和 idempotency_result key 生成
    """

    def test_idempotency_lock_key_format(self):
        """测试幂等性锁 key 格式正确"""
        from app.core.redis import RedisKeys
        key = RedisKeys.idempotency_lock(1, "req-abc-123")
        self.assertTrue(key.startswith("idempotency:lock:1:"))
        # key 中包含 hash（16 字符 hex）
        parts = key.split(":")
        self.assertEqual(len(parts), 4)
        self.assertEqual(len(parts[3]), 16)

    def test_idempotency_result_key_format(self):
        """测试幂等性结果 key 格式正确"""
        from app.core.redis import RedisKeys
        key = RedisKeys.idempotency_result(42, "req-xyz")
        self.assertTrue(key.startswith("idempotency:result:42:"))

    def test_idempotency_key_user_isolation(self):
        """测试不同用户的相同 key 生成不同的 Redis key"""
        from app.core.redis import RedisKeys
        key_user1 = RedisKeys.idempotency_lock(1, "req-abc")
        key_user2 = RedisKeys.idempotency_lock(2, "req-abc")
        self.assertNotEqual(key_user1, key_user2)

    def test_idempotency_key_deterministic(self):
        """测试相同输入生成相同 key（幂等性基础）"""
        from app.core.redis import RedisKeys
        key1 = RedisKeys.idempotency_lock(1, "req-abc-123")
        key2 = RedisKeys.idempotency_lock(1, "req-abc-123")
        self.assertEqual(key1, key2)

    def test_idempotency_lock_and_result_different(self):
        """测试锁 key 和结果 key 不同"""
        from app.core.redis import RedisKeys
        lock_key = RedisKeys.idempotency_lock(1, "req-abc")
        result_key = RedisKeys.idempotency_result(1, "req-abc")
        self.assertNotEqual(lock_key, result_key)

    def test_distributed_lock_key(self):
        """测试分布式锁 key 格式"""
        from app.core.redis import RedisKeys
        key = RedisKeys.distributed_lock("doc:123")
        self.assertEqual(key, "lock:doc:123")


# ============================================
# 测试 3: security.py fail-closed 逻辑（P1-15）
# ============================================

class TestSecurityFailClosed(unittest.TestCase):
    """
    测试 is_token_blacklisted 的 fail-closed 行为

    覆盖修复：
        - P1-15: is_token_blacklisted 改用 exists_strict，Redis 故障时抛出异常
    """

    @patch('app.core.redis.RedisManager.exists_strict')
    def test_blacklisted_token_returns_true(self, mock_exists):
        """测试已拉黑的 Token 返回 True"""
        from app.core.security import is_token_blacklisted
        mock_exists.return_value = True
        result = is_token_blacklisted("some-token")
        self.assertTrue(result)

    @patch('app.core.redis.RedisManager.exists_strict')
    def test_non_blacklisted_token_returns_false(self, mock_exists):
        """测试未拉黑的 Token 返回 False"""
        from app.core.security import is_token_blacklisted
        mock_exists.return_value = False
        result = is_token_blacklisted("some-token")
        self.assertFalse(result)

    @patch('app.core.redis.RedisManager.exists_strict')
    def test_redis_failure_raises_exception(self, mock_exists):
        """测试 Redis 故障时抛出异常（fail-closed，P1-15 核心修复）"""
        from app.core.security import is_token_blacklisted
        import redis as redis_lib
        mock_exists.side_effect = redis_lib.RedisError("Connection refused")
        with self.assertRaises(redis_lib.RedisError):
            is_token_blacklisted("some-token")

    @patch('app.core.redis.RedisManager.exists_strict')
    def test_redis_generic_failure_raises_exception(self, mock_exists):
        """测试 Redis 通用异常也抛出（fail-closed）"""
        from app.core.security import is_token_blacklisted
        mock_exists.side_effect = ConnectionError("Network error")
        with self.assertRaises(ConnectionError):
            is_token_blacklisted("some-token")


# ============================================
# 测试 4: rate_limit.py _get_identifier（P0-6）
# ============================================

class TestRateLimitIdentifier(unittest.TestCase):
    """
    测试 _get_identifier 从 Authorization header 解析 Token

    覆盖修复：
        - P0-6: rate_limit 在 get_current_user 之前执行时，
                从 Authorization header 解析 Token 获取用户ID
    """

    def _make_mock_request(self, headers=None, state_attrs=None, client_host=None):
        """创建模拟 Request 对象"""
        mock_req = MagicMock()
        mock_req.headers = headers or {}
        # 使用 SpecMock 避免 MagicMock 属性自动创建为 truthy 对象
        # 作用：getattr(request.state, "user_id", None) 在真实 Request 上
        #       未设置时返回 None，但 MagicMock 会返回 truthy 子 mock
        #       修复：显式设置 user_id 默认为 None
        mock_req.state = MagicMock()
        mock_req.state.user_id = None  # 默认未设置
        for k, v in (state_attrs or {}).items():
            setattr(mock_req.state, k, v)
        if client_host:
            mock_req.client = MagicMock()
            mock_req.client.host = client_host
        else:
            mock_req.client = None
        return mock_req

    def test_identifier_from_state_user_id(self):
        """测试优先从 state.user_id 获取标识符"""
        from app.core.rate_limit import _get_identifier
        req = self._make_mock_request(
            state_attrs={"user_id": 42},
            client_host="10.0.0.1"
        )
        result = _get_identifier(req)
        self.assertEqual(result, "user:42")

    def test_identifier_from_bearer_token(self):
        """测试从 Authorization header 解析 Token 获取用户ID"""
        from app.core.rate_limit import _get_identifier
        from app.core.security import create_access_token
        token = create_access_token(data={"sub": "99", "username": "testuser"})
        req = self._make_mock_request(
            headers={"Authorization": f"Bearer {token}"},
            client_host="10.0.0.1"
        )
        result = _get_identifier(req)
        self.assertEqual(result, "user:99")

    def test_identifier_fallback_to_ip(self):
        """测试无 Token 时回退到 IP"""
        from app.core.rate_limit import _get_identifier
        req = self._make_mock_request(
            headers={},
            client_host="192.168.1.100"
        )
        result = _get_identifier(req)
        self.assertEqual(result, "ip:192.168.1.100")

    def test_identifier_invalid_token_fallback_to_ip(self):
        """测试无效 Token 回退到 IP"""
        from app.core.rate_limit import _get_identifier
        req = self._make_mock_request(
            headers={"Authorization": "Bearer invalid-token-string"},
            client_host="10.0.0.5"
        )
        result = _get_identifier(req)
        self.assertEqual(result, "ip:10.0.0.5")

    def test_identifier_no_auth_header_no_client(self):
        """测试无 Authorization header 且无 client 时返回 unknown"""
        from app.core.rate_limit import _get_identifier
        req = self._make_mock_request(headers={}, client_host=None)
        result = _get_identifier(req)
        self.assertEqual(result, "unknown")

    def test_identifier_x_forwarded_for(self):
        """测试 X-Forwarded-For 回退（H-11：仅可信代理场景下使用）"""
        from app.core.rate_limit import _get_identifier
        from app.core.config import settings
        # H-11 修复：X-Forwarded-For 仅在直连 IP 属于可信代理时才使用
        # 作用：防止客户端伪造 X-Forwarded-For 绕过限流
        # 场景：直连 IP 127.0.0.1 是可信代理，X-Forwarded-For 含真实客户端 IP
        with patch.object(settings, 'TRUSTED_PROXIES', '127.0.0.1,10.0.0.0/8'):
            req = self._make_mock_request(
                headers={"X-Forwarded-For": "203.0.113.50, 10.0.0.1"},
                client_host="127.0.0.1"
            )
            result = _get_identifier(req)
            self.assertEqual(result, "ip:203.0.113.50")

    def test_identifier_x_forwarded_for_ignored_without_trusted_proxy(self):
        """测试非可信代理时忽略 X-Forwarded-For（H-11 安全增强）"""
        from app.core.rate_limit import _get_identifier
        from app.core.config import settings
        # 直连 IP 不在可信代理列表，X-Forwarded-For 应被忽略，使用直连 IP
        with patch.object(settings, 'TRUSTED_PROXIES', '127.0.0.1,10.0.0.0/8'):
            req = self._make_mock_request(
                headers={"X-Forwarded-For": "203.0.113.50"},
                client_host="198.51.100.20"
            )
            result = _get_identifier(req)
            self.assertEqual(result, "ip:198.51.100.20")


# ============================================
# 测试 5: RedisManager.exists_strict fail-closed（P1-15）
# ============================================

class TestRedisExistsStrict(unittest.TestCase):
    """
    测试 RedisManager.exists_strict 的 fail-closed 行为

    覆盖修复：
        - P1-15: exists_strict 在 Redis 异常时抛出而非返回 False
    """

    @patch('app.core.redis.redis_client')
    def test_exists_strict_returns_true(self, mock_client):
        """测试 key 存在时返回 True"""
        from app.core.redis import RedisManager
        mock_client.exists.return_value = 1
        result = RedisManager.exists_strict("some:key")
        self.assertTrue(result)

    @patch('app.core.redis.redis_client')
    def test_exists_strict_returns_false(self, mock_client):
        """测试 key 不存在时返回 False"""
        from app.core.redis import RedisManager
        mock_client.exists.return_value = 0
        result = RedisManager.exists_strict("some:key")
        self.assertFalse(result)

    @patch('app.core.redis.redis_client')
    def test_exists_strict_raises_on_redis_error(self, mock_client):
        """测试 Redis 异常时抛出（fail-closed 核心）"""
        from app.core.redis import RedisManager
        import redis as redis_lib
        mock_client.exists.side_effect = redis_lib.RedisError("Connection lost")
        with self.assertRaises(redis_lib.RedisError):
            RedisManager.exists_strict("some:key")

    @patch('app.core.redis.redis_client')
    def test_exists_strict_raises_on_connection_error(self, mock_client):
        """测试连接异常时抛出"""
        from app.core.redis import RedisManager
        mock_client.exists.side_effect = ConnectionError("Network unreachable")
        with self.assertRaises(ConnectionError):
            RedisManager.exists_strict("some:key")

    @patch('app.core.redis.redis_client')
    def test_exists_fail_open_returns_false_on_error(self, mock_client):
        """对比测试：exists（fail-open）在异常时返回 False"""
        from app.core.redis import RedisManager
        import redis as redis_lib
        mock_client.exists.side_effect = redis_lib.RedisError("Connection lost")
        result = RedisManager.exists("some:key")
        self.assertFalse(result)  # fail-open 返回 False


# ============================================
# 测试 6: config.py SECRET_KEY 校验（P0-1 回归）
# ============================================

class TestConfigSecretKeyValidation(unittest.TestCase):
    """
    回归测试：SECRET_KEY 校验（P0-1）

    覆盖修复：
        - P0-1: 生产环境拒绝空/短 SECRET_KEY，开发环境自动生成
    """

    def test_weak_secret_key_rejected(self):
        """测试弱密钥被拒绝"""
        from app.core.config import Settings
        from pydantic import ValidationError
        with self.assertRaises(ValidationError) as ctx:
            Settings(ENVIRONMENT="development", SECRET_KEY="secret")
        self.assertIn("弱默认值", str(ctx.exception))

    def test_production_requires_secret_key(self):
        """测试生产环境必须设置 SECRET_KEY"""
        from app.core.config import Settings
        from pydantic import ValidationError
        with self.assertRaises(ValidationError) as ctx:
            Settings(ENVIRONMENT="production", SECRET_KEY="")
        self.assertIn("生产环境", str(ctx.exception))

    def test_production_short_key_rejected(self):
        """测试生产环境短密钥被拒绝"""
        from app.core.config import Settings
        from pydantic import ValidationError
        with self.assertRaises(ValidationError) as ctx:
            Settings(ENVIRONMENT="production", SECRET_KEY="a" * 31)
        self.assertIn("32", str(ctx.exception))

    def test_production_valid_key_accepted(self):
        """测试生产环境合法密钥通过"""
        from app.core.config import Settings
        s = Settings(ENVIRONMENT="production", SECRET_KEY="a" * 32, OPENAI_API_KEY="sk-test")
        self.assertEqual(s.SECRET_KEY, "a" * 32)

    def test_development_auto_generates_key(self):
        """测试开发环境自动生成密钥"""
        from app.core.config import Settings
        import warnings
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            s = Settings(ENVIRONMENT="development", SECRET_KEY="")
            self.assertGreater(len(s.SECRET_KEY), 32)
            self.assertTrue(any("临时密钥" in str(x.message) for x in w))

    def test_production_debug_forced_off(self):
        """测试生产环境 DEBUG 自动关闭（P1-9 回归）"""
        from app.core.config import Settings
        import warnings
        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            s = Settings(ENVIRONMENT="production", SECRET_KEY="a" * 32, DEBUG=True)
            self.assertFalse(s.DEBUG)


# ============================================
# 测试 7: url_validator.py（P0-2 + P0-3 回归）
# ============================================

class TestUrlValidator(unittest.TestCase):
    """
    回归测试：URL 校验和文件名清洗

    覆盖修复：
        - P0-2: sanitize_filename 路径遍历防护
        - P0-3: validate_url SSRF 防护
    """

    def test_sanitize_filename_strips_path(self):
        """测试文件名去除路径前缀"""
        from app.core.url_validator import sanitize_filename
        result = sanitize_filename("../../../etc/passwd")
        self.assertNotIn("..", result)
        self.assertNotIn("/", result)

    def test_sanitize_filename_removes_null_bytes(self):
        """测试文件名去除空字节"""
        from app.core.url_validator import sanitize_filename
        result = sanitize_filename("file\x00.txt")
        self.assertNotIn("\x00", result)

    def test_sanitize_filename_windows_reserved(self):
        """测试 Windows 保留名处理"""
        from app.core.url_validator import sanitize_filename
        result = sanitize_filename("CON.txt")
        # CON 是 Windows 保留名，应被处理
        self.assertNotEqual(result, "CON.txt")

    def test_validate_url_rejects_ftp(self):
        """测试 FTP 协议被拒绝"""
        from app.core.url_validator import validate_url, URLValidationError
        with self.assertRaises(URLValidationError):
            validate_url("ftp://example.com/file.txt")

    def test_validate_url_rejects_file(self):
        """测试 file:// 协议被拒绝"""
        from app.core.url_validator import validate_url, URLValidationError
        with self.assertRaises(URLValidationError):
            validate_url("file:///etc/passwd")

    def test_validate_url_rejects_empty(self):
        """测试空 URL 被拒绝"""
        from app.core.url_validator import validate_url, URLValidationError
        with self.assertRaises(URLValidationError):
            validate_url("")

    def test_validate_url_rejects_blocked_hostname(self):
        """测试 localhost 被拒绝"""
        from app.core.url_validator import validate_url, URLValidationError
        with self.assertRaises(URLValidationError):
            validate_url("http://localhost/admin")

    def test_validate_url_rejects_metadata_service(self):
        """测试云元数据服务被拒绝"""
        from app.core.url_validator import validate_url, URLValidationError
        with self.assertRaises(URLValidationError):
            validate_url("http://169.254.169.254/latest/meta-data/")


# ============================================
# 主入口
# ============================================

if __name__ == "__main__":
    unittest.main(verbosity=2)
