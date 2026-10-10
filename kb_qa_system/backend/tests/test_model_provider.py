"""
模型提供者模块测试

作用：
    验证多API部署方案架构优化的正确性，覆盖 8 个关键维度：
    1. 配置加载（YAML 解析、环境变量占位符、回退模式）
    2. 降级路由正确性（主模型健康时不用降级模型——核心保障）
    3. 熔断器隔离（主备独立熔断）
    4. LLMResilienceService 向后兼容
    5. VectorStoreService 向后兼容
    6. ImageProcessor 向后兼容
    7. main.py 生命周期集成
    8. manager 生命周期

测试策略：
    1. 静态分析测试：读取源码文件内容，验证接口和结构存在（避免运行时依赖）
    2. 行为测试：对纯 Python 模块（config_loader、failover_router），使用 mock 对象测试路由逻辑
    3. 不需要真实 API Key / Redis / DB

运行方式：
    cd backend
    python -m pytest tests/test_model_provider.py -v
"""

import os
import sys
import pytest
from unittest.mock import MagicMock, patch
from pathlib import Path

# ============================================
# Mock 重依赖（langchain_core / langchain_openai）
# ============================================
# 作用：测试环境未安装 langchain 系列包，但 model_provider 包的 __init__.py
# 导入链会触发 base.py → langchain_core.messages.BaseMessage 和
# openai_text.py → langchain_openai.ChatOpenAI 的导入。
# 此处预先注入 MagicMock 到 sys.modules，使导入链成功。
# 实际行为测试（TestConfigLoader/TestFailoverRouter）不依赖这些类的真实实现。
_langchain_core_mock = MagicMock()
sys.modules.setdefault("langchain_core", _langchain_core_mock)
sys.modules.setdefault("langchain_core.messages", _langchain_core_mock.messages)
sys.modules.setdefault("langchain_openai", MagicMock())


# ============================================
# 辅助函数
# ============================================

BACKEND_DIR = Path(__file__).parent.parent


def read_source(relative_path: str) -> str:
    """
    读取源码文件内容（不导入模块，避免依赖问题）

    参数：
        relative_path: str - 相对于 backend 目录的路径

    返回：
        str - 文件内容
    """
    file_path = BACKEND_DIR / relative_path
    return file_path.read_text(encoding="utf-8")


# ============================================
# 1. 配置加载测试
# ============================================

class TestConfigLoader:
    """配置加载器测试"""

    def test_providers_yaml_exists(self):
        """验证 providers.yaml 配置文件存在"""
        yaml_path = BACKEND_DIR / "app" / "core" / "model_provider" / "providers.yaml"
        assert yaml_path.exists(), "providers.yaml 配置文件应存在"

    def test_providers_yaml_has_three_model_types(self):
        """验证 providers.yaml 包含 llm/embedding/vision 三种模型类型"""
        source = read_source("app/core/model_provider/providers.yaml")
        assert "llm:" in source, "应包含 llm 模型类型"
        assert "embedding:" in source, "应包含 embedding 模型类型"
        assert "vision:" in source, "应包含 vision 模型类型"

    def test_providers_yaml_has_primary_and_fallback(self):
        """验证每种模型类型都有 primary 和 fallback 端点"""
        source = read_source("app/core/model_provider/providers.yaml")
        # LLM
        assert 'name: "primary"' in source, "应有 primary 端点"
        assert 'name: "fallback"' in source, "应有 fallback 端点"
        assert 'name: "local_fallback"' in source, "应有 local_fallback 端点"

    def test_providers_yaml_uses_env_placeholders(self):
        """验证配置文件使用环境变量占位符 ${VAR:default}"""
        source = read_source("app/core/model_provider/providers.yaml")
        assert "${" in source, "应使用环境变量占位符"
        assert "${OPENAI_API_KEY}" in source, "应引用 OPENAI_API_KEY"
        assert "${LLM_MODEL_NAME:" in source, "LLM 模型名应有默认值"

    def test_env_placeholder_resolution_simple(self):
        """测试 ${VAR:default} 占位符解析（简单场景）"""
        from app.core.model_provider.config_loader import _resolve_env_placeholders

        # 设置测试环境变量
        os.environ["TEST_MODEL_VAR"] = "gpt-4"
        try:
            result = _resolve_env_placeholders("${TEST_MODEL_VAR:fallback}")
            assert result == "gpt-4", "环境变量存在时应取环境变量值"
        finally:
            del os.environ["TEST_MODEL_VAR"]

    def test_env_placeholder_resolution_default(self):
        """测试 ${VAR:default} 占位符解析（环境变量不存在时用默认值）"""
        from app.core.model_provider.config_loader import _resolve_env_placeholders

        # 确保环境变量不存在
        os.environ.pop("TEST_NONEXISTENT_VAR", None)
        result = _resolve_env_placeholders("${TEST_NONEXISTENT_VAR:default_model}")
        assert result == "default_model", "环境变量不存在时应取默认值"

    def test_env_placeholder_resolution_no_default(self):
        """测试 ${VAR} 占位符解析（无默认值时替换为空串）"""
        from app.core.model_provider.config_loader import _resolve_env_placeholders

        os.environ.pop("TEST_NO_DEFAULT_VAR", None)
        result = _resolve_env_placeholders("${TEST_NO_DEFAULT_VAR}")
        assert result == "", "无默认值且环境变量不存在时应替换为空串"

    def test_env_placeholder_resolution_nested(self):
        """测试 ${VAR:${OTHER}} 嵌套引用"""
        from app.core.model_provider.config_loader import _resolve_env_placeholders

        os.environ.pop("TEST_OUTER", None)
        os.environ["TEST_INNER"] = "inner_value"
        try:
            result = _resolve_env_placeholders("${TEST_OUTER:${TEST_INNER}}")
            assert result == "inner_value", "嵌套引用：外层不存在时应取内层值"
        finally:
            del os.environ["TEST_INNER"]

    def test_config_loader_fallback_from_env(self):
        """测试 YAML 不可用时回退到纯环境变量模式"""
        from app.core.model_provider.config_loader import ConfigLoader

        # 传入不存在的路径，触发回退
        config = ConfigLoader.load(config_path="/nonexistent/path/providers.yaml")
        # 回退模式应仍能构建配置
        assert "llm" in config.providers, "回退模式应有 llm 配置"
        assert "embedding" in config.providers, "回退模式应有 embedding 配置"
        assert "vision" in config.providers, "回退模式应有 vision 配置"
        # 至少有一个 primary 端点
        assert len(config.providers["llm"]) >= 1, "回退模式 llm 至少有 primary"
        assert config.providers["llm"][0].name == "primary"


# ============================================
# 2. 降级路由正确性测试（核心！）
# ============================================

class TestFailoverRouter:
    """
    降级路由器测试

    核心验证点：主模型健康时绝不使用降级模型
    """

    def _make_mock_client(self, name: str, is_open: bool = False):
        """
        创建模拟客户端

        参数：
            name: str - 端点名称
            is_open: bool - 熔断器是否打开

        返回：
            MagicMock - 模拟的客户端对象
        """
        client = MagicMock()
        client.name = name
        client.breaker = MagicMock()
        client.breaker.is_open.return_value = is_open
        client.config = MagicMock()
        client.config.model = f"model_{name}"
        return client

    def _make_router(self, clients):
        """
        创建路由器（使用模拟注册表）

        参数：
            clients: list - 模拟客户端列表

        返回：
            FailoverRouter - 路由器实例
        """
        from app.core.model_provider.failover_router import FailoverRouter

        registry = MagicMock()
        registry.get_clients.return_value = clients
        return FailoverRouter(registry)

    def test_router_returns_primary_when_healthy(self):
        """主模型 breaker CLOSED → 返回 primary（核心保障）"""
        primary = self._make_mock_client("primary", is_open=False)
        fallback = self._make_mock_client("fallback", is_open=False)
        router = self._make_router([primary, fallback])

        selected = router.select_client("llm")
        assert selected is primary, "主模型健康时必须返回 primary"

    def test_router_returns_fallback_when_primary_open(self):
        """主模型 breaker OPEN → 返回 fallback"""
        primary = self._make_mock_client("primary", is_open=True)
        fallback = self._make_mock_client("fallback", is_open=False)
        router = self._make_router([primary, fallback])

        selected = router.select_client("llm")
        assert selected is fallback, "主模型熔断时应返回 fallback"

    def test_router_returns_primary_when_all_open(self):
        """全部 OPEN → 返回 primary（让上层走兜底，不静默用降级）"""
        primary = self._make_mock_client("primary", is_open=True)
        fallback = self._make_mock_client("fallback", is_open=True)
        router = self._make_router([primary, fallback])

        selected = router.select_client("llm")
        assert selected is primary, "全部熔断时应返回 primary 让上层处理"

    def test_router_auto_switch_back(self):
        """主模型恢复 → 下次调用自动切回 primary"""
        primary = self._make_mock_client("primary", is_open=True)
        fallback = self._make_mock_client("fallback", is_open=False)
        router = self._make_router([primary, fallback])

        # 第一次：primary 熔断，用 fallback
        selected1 = router.select_client("llm")
        assert selected1 is fallback

        # primary 恢复
        primary.breaker.is_open.return_value = False

        # 第二次：primary 恢复，应切回 primary
        selected2 = router.select_client("llm")
        assert selected2 is primary, "主模型恢复后应自动切回"

    def test_router_select_with_fallback_healthy(self):
        """select_with_fallback：主模型健康时返回 (primary, [fallback])"""
        primary = self._make_mock_client("primary", is_open=False)
        fallback = self._make_mock_client("fallback", is_open=False)
        router = self._make_router([primary, fallback])

        selected, fallbacks = router.select_with_fallback("llm")
        assert selected is primary
        assert fallback in fallbacks, "健康的 fallback 应在降级列表中"

    def test_router_select_with_fallback_all_open(self):
        """select_with_fallback：全部 OPEN 时返回 (primary, [])"""
        primary = self._make_mock_client("primary", is_open=True)
        fallback = self._make_mock_client("fallback", is_open=True)
        router = self._make_router([primary, fallback])

        selected, fallbacks = router.select_with_fallback("llm")
        assert selected is primary
        assert len(fallbacks) == 0, "全部熔断时降级列表应为空"

    def test_router_raises_when_no_clients(self):
        """无注册客户端时抛 ModelClientUnavailableError"""
        from app.core.model_provider.failover_router import FailoverRouter
        from app.core.model_provider.exceptions import ModelClientUnavailableError

        registry = MagicMock()
        registry.get_clients.return_value = []
        router = FailoverRouter(registry)

        with pytest.raises(ModelClientUnavailableError):
            router.select_client("llm")

    def test_router_no_false_failover(self):
        """
        核心测试：不会在主模型健康时误用降级模型

        场景：主模型 CLOSED，fallback 也 CLOSED
        期望：100 次路由都返回 primary（不随机、不轮询）
        """
        primary = self._make_mock_client("primary", is_open=False)
        fallback = self._make_mock_client("fallback", is_open=False)
        router = self._make_router([primary, fallback])

        for _ in range(100):
            selected = router.select_client("llm")
            assert selected is primary, "主模型健康时绝不能返回降级模型"


# ============================================
# 3. 熔断器隔离测试
# ============================================

class TestBreakerIsolation:
    """熔断器隔离测试：主备客户端熔断器独立"""

    def test_breaker_name_includes_client_name(self):
        """验证熔断器名称包含 model_type 和 client name（隔离保证）"""
        source = read_source("app/core/model_provider/base.py")
        assert 'f"{self.model_type}:{self.name}"' in source, \
            "熔断器名称应包含 model_type:name 确保主备隔离"

    def test_breaker_isolation_in_source(self):
        """验证源码中每个客户端创建独立熔断器"""
        source = read_source("app/core/model_provider/base.py")
        assert "get_circuit_breaker" in source, "应使用 get_circuit_breaker 创建熔断器"
        assert "self.breaker" in source, "客户端应有 breaker 属性"


# ============================================
# 4. LLMResilienceService 向后兼容测试
# ============================================

class TestLLMResilienceBackwardCompat:
    """LLMResilienceService 向后兼容测试"""

    def test_get_llm_service_exists(self):
        """验证 get_llm_service 函数存在"""
        source = read_source("app/services/llm_resilience.py")
        assert "def get_llm_service" in source, "get_llm_service 函数应存在"

    def test_llm_service_error_exists(self):
        """验证 LLMServiceError 异常类存在"""
        source = read_source("app/services/llm_resilience.py")
        assert "class LLMServiceError" in source, "LLMServiceError 应存在"

    def test_llm_stream_timeout_error_exists(self):
        """验证 LLMStreamTimeoutError 异常类存在（向后兼容保留）"""
        source = read_source("app/services/llm_resilience.py")
        assert "class LLMStreamTimeoutError" in source, "LLMStreamTimeoutError 应存在"

    def test_invoke_method_exists(self):
        """验证 invoke 方法存在且签名正确"""
        source = read_source("app/services/llm_resilience.py")
        assert "def invoke(self, messages" in source, "invoke 方法应存在"

    def test_astream_method_exists(self):
        """验证 astream 方法存在且签名正确"""
        source = read_source("app/services/llm_resilience.py")
        assert "async def astream(self, messages" in source, "astream 方法应存在"

    def test_last_metrics_property_exists(self):
        """验证 last_metrics 属性存在"""
        source = read_source("app/services/llm_resilience.py")
        assert "def last_metrics" in source, "last_metrics 属性应存在"

    def test_uses_model_provider_manager(self):
        """验证使用 model_provider manager（适配层模式）"""
        source = read_source("app/services/llm_resilience.py")
        assert "get_model_manager" in source, "应使用 get_model_manager"
        assert "get_text_client_with_fallback" in source, "应通过 manager 获取客户端列表"

    def test_no_direct_chatopenai_creation(self):
        """验证不再直接创建 ChatOpenAI 实例"""
        source = read_source("app/services/llm_resilience.py")
        assert "ChatOpenAI(" not in source, "不应直接创建 ChatOpenAI 实例"
        assert "from langchain_openai import ChatOpenAI" not in source, \
            "不应导入 ChatOpenAI"

    def test_uses_call_metrics(self):
        """验证使用 CallMetrics 进行指标追踪"""
        source = read_source("app/services/llm_resilience.py")
        assert "CallMetrics" in source, "应使用 CallMetrics 追踪指标"

    def test_singleton_pattern_preserved(self):
        """验证单例模式保留（线程安全双重检查锁定）"""
        source = read_source("app/services/llm_resilience.py")
        assert "_llm_service_instance" in source, "应有全局实例变量"
        assert "_llm_service_lock" in source, "应有线程锁"
        assert "threading.Lock" in source, "应使用 threading.Lock"

    def test_failover_logic_in_invoke(self):
        """验证 invoke 中有降级遍历逻辑"""
        source = read_source("app/services/llm_resilience.py")
        assert "all_clients" in source, "应有 all_clients 列表"
        assert "failover_count" in source, "应追踪 failover_count"
        assert "LLMServiceError" in source, "全部失败时应抛 LLMServiceError"


# ============================================
# 5. VectorStoreService 向后兼容测试
# ============================================

class TestVectorStoreBackwardCompat:
    """VectorStoreService 向后兼容测试"""

    def test_get_vector_store_exists(self):
        """验证 get_vector_store 函数存在"""
        source = read_source("app/services/vector_store.py")
        assert "def get_vector_store" in source

    def test_generate_embedding_signature(self):
        """验证 generate_embedding 返回 tuple[Optional[List[float]], str]"""
        source = read_source("app/services/vector_store.py")
        assert "def generate_embedding(self, text" in source
        assert "tuple[Optional[List[float]], str]" in source

    def test_uses_model_provider_manager(self):
        """验证使用 model_provider manager"""
        source = read_source("app/services/vector_store.py")
        assert "get_model_manager" in source, "应使用 get_model_manager"
        assert "get_embedding_client_with_fallback" in source, \
            "应通过 manager 获取 embedding 客户端"

    def test_no_direct_openai_embeddings(self):
        """验证不再直接创建 OpenAIEmbeddings"""
        source = read_source("app/services/vector_store.py")
        # 不应有 online_embeddings property 创建 OpenAIEmbeddings
        assert "OpenAIEmbeddings(" not in source, \
            "不应直接创建 OpenAIEmbeddings 实例"

    def test_redis_cache_preserved(self):
        """验证 Redis 缓存逻辑保留"""
        source = read_source("app/services/vector_store.py")
        assert "RedisManager" in source, "Redis 缓存应保留"
        assert "cache_key" in source, "缓存 key 生成应保留"
        assert "7 * 24 * 3600" in source, "缓存 TTL 7天应保留"

    def test_fallback_iteration_in_generate_embedding(self):
        """验证 generate_embedding 中有降级遍历逻辑"""
        source = read_source("app/services/vector_store.py")
        assert "all_clients" in source, "应有 all_clients 列表遍历"
        assert "CircuitBreakerOpenError" in source, "应处理熔断器打开"
        assert "ModelInvocationError" in source, "应处理调用失败"


# ============================================
# 6. ImageProcessor 向后兼容测试
# ============================================

class TestImageProcessorBackwardCompat:
    """ImageProcessor 向后兼容测试"""

    def test_describe_image_returns_str(self):
        """验证 _describe_image 返回 str（失败返回空字符串）"""
        source = read_source("app/services/document_pipeline/image_processor.py")
        assert "def _describe_image(self, image_path" in source
        assert 'return ""' in source, "失败时应返回空字符串"

    def test_uses_model_provider_manager(self):
        """验证使用 model_provider manager"""
        source = read_source("app/services/document_pipeline/image_processor.py")
        assert "get_model_manager" in source, "应使用 get_model_manager"
        assert "get_vision_client" in source, "应通过 manager 获取 vision 客户端"

    def test_no_direct_openai_client(self):
        """验证不再直接创建 openai.OpenAI 客户端"""
        source = read_source("app/services/document_pipeline/image_processor.py")
        assert "from openai import OpenAI" not in source, \
            "不应直接导入 openai.OpenAI"
        assert "openai.OpenAI(" not in source, "不应直接创建 openai.OpenAI 实例"

    def test_delegates_to_vision_client(self):
        """验证委托给 VisionModelClient.describe_image()"""
        source = read_source("app/services/document_pipeline/image_processor.py")
        assert "client.describe_image(" in source, \
            "应委托给 VisionModelClient.describe_image()"
        assert "self._VISION_PROMPT" in source, "应传递 Vision Prompt"


# ============================================
# 7. main.py 生命周期集成测试
# ============================================

class TestMainLifespanIntegration:
    """main.py 生命周期集成测试"""

    def test_manager_initialize_in_lifespan(self):
        """验证 lifespan 中有 manager.initialize()"""
        source = read_source("app/main.py")
        assert "manager.initialize()" in source or "_model_manager.initialize()" in source, \
            "lifespan 启动时应调用 manager.initialize()"

    def test_start_health_checks_in_lifespan(self):
        """验证 lifespan 中有 start_health_checks()"""
        source = read_source("app/main.py")
        assert "start_health_checks" in source, \
            "lifespan 启动时应调用 start_health_checks()"

    def test_manager_shutdown_in_lifespan(self):
        """验证 lifespan 关闭时有 manager.shutdown()"""
        source = read_source("app/main.py")
        assert "shutdown()" in source, \
            "lifespan 关闭时应调用 manager.shutdown()"

    def test_shutdown_before_redis_cleanup(self):
        """验证 manager.shutdown() 在 Redis 清理之前执行"""
        source = read_source("app/main.py")
        manager_pos = source.find("shutdown()")
        redis_pos = source.find("RedisManager.close()")
        assert manager_pos > 0 and redis_pos > 0, \
            "应同时存在 shutdown 和 RedisManager.close()"
        assert manager_pos < redis_pos, \
            "manager.shutdown() 应在 RedisManager.close() 之前执行"


# ============================================
# 8. Manager 生命周期测试
# ============================================

class TestManagerLifecycle:
    """ModelProviderManager 生命周期测试"""

    def test_manager_has_initialize(self):
        """验证 manager 有 initialize 方法"""
        source = read_source("app/core/model_provider/manager.py")
        assert "def initialize" in source

    def test_manager_has_get_text_client(self):
        """验证 manager 有 get_text_client 方法"""
        source = read_source("app/core/model_provider/manager.py")
        assert "def get_text_client" in source

    def test_manager_has_get_embedding_client(self):
        """验证 manager 有 get_embedding_client 方法"""
        source = read_source("app/core/model_provider/manager.py")
        assert "def get_embedding_client" in source

    def test_manager_has_get_vision_client(self):
        """验证 manager 有 get_vision_client 方法"""
        source = read_source("app/core/model_provider/manager.py")
        assert "def get_vision_client" in source

    def test_manager_has_start_health_checks(self):
        """验证 manager 有 start_health_checks 方法"""
        source = read_source("app/core/model_provider/manager.py")
        assert "async def start_health_checks" in source

    def test_manager_has_shutdown(self):
        """验证 manager 有 shutdown 方法"""
        source = read_source("app/core/model_provider/manager.py")
        assert "async def shutdown" in source

    def test_manager_singleton_pattern(self):
        """验证 manager 使用单例模式（双重检查锁定）"""
        source = read_source("app/core/model_provider/manager.py")
        assert "_manager_instance" in source
        assert "_manager_lock" in source
        assert "def get_model_manager" in source

    def test_manager_ensure_initialized(self):
        """验证 manager 有 _ensure_initialized 懒加载兜底"""
        source = read_source("app/core/model_provider/manager.py")
        assert "_ensure_initialized" in source, \
            "应有 _ensure_initialized 方法确保自动初始化"


# ============================================
# 9. OpenAITextClient retry_count 暴露测试
# ============================================

class TestOpenAITextClientRetryCount:
    """OpenAITextClient retry_count 暴露测试"""

    def test_last_retry_count_property_exists(self):
        """验证 last_retry_count 属性存在"""
        source = read_source("app/core/model_provider/clients/openai_text.py")
        assert "last_retry_count" in source, "应暴露 last_retry_count 属性"
        assert "self._last_retry_count" in source, "应有 _last_retry_count 实例属性"

    def test_retry_count_updated_in_invoke(self):
        """验证 invoke() 中更新 _last_retry_count"""
        source = read_source("app/core/model_provider/clients/openai_text.py")
        assert "self._last_retry_count = retry_counter" in source, \
            "invoke() 的 finally 块应更新 _last_retry_count"

    def test_retry_count_updated_in_astream(self):
        """验证 _astream_first_with_retry() 中更新 _last_retry_count"""
        source = read_source("app/core/model_provider/clients/openai_text.py")
        assert "self._last_retry_count = retry_count" in source, \
            "流式调用应更新 _last_retry_count"


# ============================================
# 10. 健康检查机制测试
# ============================================

class TestHealthChecker:
    """健康检查机制测试"""

    def test_health_checker_exists(self):
        """验证 HealthChecker 模块存在"""
        source = read_source("app/core/model_provider/health_checker.py")
        assert "class HealthChecker" in source

    def test_health_checker_feeds_breaker(self):
        """验证健康检查结果喂入熔断器（不直接参与路由）"""
        source = read_source("app/core/model_provider/health_checker.py")
        assert "record_success" in source or "record_failure" in source, \
            "健康检查应调用 breaker.record_success/failure"

    def test_health_probe_does_not_route_directly(self):
        """验证健康探测结果不直接参与路由决策（单一事实来源）"""
        router_source = read_source("app/core/model_provider/failover_router.py")
        # 路由器应仅基于 breaker.is_open() 决策，不查询健康检查结果
        assert "is_open()" in router_source, "路由器应基于 breaker.is_open() 决策"
        assert "health_check" not in router_source.lower() or \
               "health_check" not in router_source, \
            "路由器不应直接查询 health_check 结果"


# ============================================
# 11. 配置文件完整性测试
# ============================================

class TestProvidersYamlIntegrity:
    """providers.yaml 配置文件完整性测试"""

    def test_llm_has_local_fallback_disabled_by_default(self):
        """验证本地 LLM 兜底默认关闭"""
        source = read_source("app/core/model_provider/providers.yaml")
        assert 'LOCAL_LLM_ENABLED:false' in source, \
            "本地 LLM 兜底应默认关闭"

    def test_embedding_has_local_fallback_disabled_by_default(self):
        """服务端本地 Embedding 必须显式启用，避免模型自动下载和混用。"""
        source = read_source("app/core/model_provider/providers.yaml")
        assert 'LOCAL_EMBEDDING_ENABLED:false' in source, \
            "本地 Embedding 兜底应默认关闭"

    def test_vision_fallback_disabled_by_default(self):
        """验证 Vision 降级默认关闭"""
        source = read_source("app/core/model_provider/providers.yaml")
        assert 'VISION_FALLBACK_ENABLED:false' in source, \
            "Vision 降级应默认关闭"

    def test_llm_fallback_uses_independent_api_key(self):
        """验证 LLM 降级模型支持独立 API Key（嵌套引用）"""
        source = read_source("app/core/model_provider/providers.yaml")
        assert "${LLM_FALLBACK_API_KEY:${OPENAI_API_KEY}}" in source, \
            "LLM 降级应支持独立 API Key，不设置时复用主 API"

    def test_health_check_config_present(self):
        """验证端点配置包含健康检查参数"""
        source = read_source("app/core/model_provider/providers.yaml")
        assert "health_check:" in source
        assert "interval:" in source
        assert "timeout:" in source

    def test_defaults_section_present(self):
        """验证有全局默认参数区块"""
        source = read_source("app/core/model_provider/providers.yaml")
        assert "defaults:" in source
        assert "timeout:" in source
        assert "max_retries:" in source
        assert "circuit_breaker_threshold:" in source
