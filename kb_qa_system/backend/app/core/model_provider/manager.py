"""
模型提供者管理器（门面）

作用：
    整合 registry / router / health_checker / call_logger，
    对外提供统一入口。业务层通过此门面访问模型服务。

职责：
    1. 初始化：加载配置 → 创建客户端 → 注册到 registry
    2. 路由：通过 FailoverRouter 选择健康的客户端
    3. 健康检查：启动后台探测任务
    4. 生命周期：启动/关闭管理

使用方式：
    manager = get_model_manager()
    manager.initialize()  # 加载配置

    # 文本模型
    text_client = manager.get_text_client()
    answer = text_client.invoke(messages)

    # Embedding
    emb_client = manager.get_embedding_client()
    vec = emb_client.embed_query(text)

    # Vision
    vision_client = manager.get_vision_client()
    desc = vision_client.describe_image(path)

生命周期：
    - 首次调用 get_model_manager() 时创建实例（懒加载）
    - initialize() 加载配置并创建客户端
    - start_health_checks() 启动后台探测（在 lifespan 中调用）
    - shutdown() 清理资源（在 lifespan 关闭时调用）
"""

import logging
import threading
from typing import List, Optional, Tuple

from app.core.model_provider.base import (
    BaseModelClient,
    EmbeddingModelClient,
    TextModelClient,
    VisionModelClient,
)
from app.core.model_provider.call_logger import get_call_logger
from app.core.model_provider.config_loader import ConfigLoader
from app.core.model_provider.exceptions import ModelClientUnavailableError
from app.core.model_provider.failover_router import FailoverRouter
from app.core.model_provider.health_checker import HealthChecker
from app.core.model_provider.registry import ModelServiceRegistry
from app.core.model_provider.schemas import ModelProviderConfig

logger = logging.getLogger(__name__)


class ModelProviderManager:
    """
    模型提供者管理器（门面）

    作用：
        整合所有模型服务组件，对外提供统一 API。
        单例模式（通过 get_model_manager() 获取）。

    核心方法：
        - initialize(): 加载配置，创建并注册所有客户端
        - get_text_client(): 获取健康的文本客户端
        - get_embedding_client(): 获取健康的 Embedding 客户端
        - get_vision_client(): 获取健康的 Vision 客户端
        - get_text_client_with_fallback(): 获取文本客户端 + 降级列表
        - start_health_checks(): 启动后台健康检查
        - shutdown(): 关闭并清理资源
        - get_status(): 获取所有端点状态
    """

    def __init__(self):
        """
        初始化管理器

        作用：
            创建各组件实例，但未加载配置（需调用 initialize()）。
        """
        self._registry = ModelServiceRegistry()
        self._router = FailoverRouter(self._registry)
        self._health_checker = HealthChecker(self._registry)
        self._call_logger = get_call_logger()
        self._initialized = False
        self._lock = threading.Lock()

    def initialize(self, config: Optional[ModelProviderConfig] = None) -> None:
        """
        初始化：加载配置 → 创建客户端 → 注册

        作用：
            首次调用时从 providers.yaml 加载配置，创建所有客户端并注册。
            可重复调用（先清空再重新加载，支持热更新）。

        参数：
            config: Optional[ModelProviderConfig] - 外部传入的配置，
                    None 时从默认路径加载 providers.yaml
        """
        with self._lock:
            if self._initialized:
                logger.info("管理器已初始化，重新加载配置...")
                self._registry.clear()

            # 加载配置
            if config is None:
                config = ConfigLoader.load()

            # 注册所有端点
            for model_type, endpoints in config.providers.items():
                for endpoint_config in endpoints:
                    try:
                        self._registry.register(model_type, endpoint_config)
                    except Exception as e:
                        logger.error(
                            "注册端点失败 [%s:%s]: %s",
                            model_type,
                            endpoint_config.name,
                            type(e).__name__,
                        )

            self._initialized = True
            logger.info(
                f"模型提供者管理器初始化完成: "
                f"LLM {len(self._registry.get_clients('llm'))} 个端点, "
                f"Embedding {len(self._registry.get_clients('embedding'))} 个端点, "
                f"Vision {len(self._registry.get_clients('vision'))} 个端点"
            )

    def get_text_client(self) -> TextModelClient:
        """
        获取文本模型客户端（路由器选择健康的）

        作用：
            通过 FailoverRouter 选择当前健康的文本客户端。
            主模型健康时永远返回主模型。

        返回:
            TextModelClient - 文本客户端

        异常:
            ModelClientUnavailableError - 无可用客户端
        """
        self._ensure_initialized()
        client = self._router.select_client("llm")
        return client  # type: ignore

    def get_embedding_client(self) -> EmbeddingModelClient:
        """
        获取 Embedding 客户端（路由器选择健康的）

        返回:
            EmbeddingModelClient - Embedding 客户端

        异常:
            ModelClientUnavailableError - 无可用客户端
        """
        self._ensure_initialized()
        client = self._router.select_client("embedding")
        return client  # type: ignore

    def get_vision_client(self) -> VisionModelClient:
        """
        获取 Vision 客户端（路由器选择健康的）

        返回:
            VisionModelClient - Vision 客户端

        异常:
            ModelClientUnavailableError - 无可用客户端
        """
        self._ensure_initialized()
        client = self._router.select_client("vision")
        return client  # type: ignore

    def get_text_client_with_fallback(
        self,
    ) -> Tuple[TextModelClient, List[BaseModelClient]]:
        """
        获取文本客户端 + 降级列表

        作用：
            返回 (主客户端, 降级客户端列表)。
            调用方在主客户端失败后，可从降级列表选下一个尝试。

        返回:
            Tuple[TextModelClient, List[BaseModelClient]]
            - (primary_client, fallback_clients)
        """
        self._ensure_initialized()
        return self._router.select_with_fallback("llm")  # type: ignore

    def get_embedding_client_with_fallback(
        self,
    ) -> Tuple[EmbeddingModelClient, List[BaseModelClient]]:
        """
        获取 Embedding 客户端 + 降级列表

        返回:
            Tuple[EmbeddingModelClient, List[BaseModelClient]]
        """
        self._ensure_initialized()
        return self._router.select_with_fallback("embedding")  # type: ignore

    def get_vision_client_with_fallback(
        self,
    ) -> Tuple[VisionModelClient, List[BaseModelClient]]:
        """
        获取 Vision 客户端 + 降级列表

        返回:
            Tuple[VisionModelClient, List[BaseModelClient]]
        """
        self._ensure_initialized()
        return self._router.select_with_fallback("vision")  # type: ignore

    async def start_health_checks(self) -> None:
        """
        启动后台健康检查

        作用：
            在 FastAPI lifespan 启动时调用。
            启动后台 asyncio Task 定时探测各端点。
        """
        self._ensure_initialized()
        await self._health_checker.start()

    async def shutdown(self) -> None:
        """
        关闭：停止健康检查 + 释放所有客户端资源

        作用：
            在 FastAPI lifespan 关闭时调用。
        """
        try:
            await self._health_checker.stop()
        except Exception as e:
            logger.error(f"停止健康检查失败: {e}")

        try:
            self._registry.clear()
        except Exception as e:
            logger.error(f"清理注册表失败: {e}")

        self._initialized = False
        logger.info("模型提供者管理器已关闭")

    def get_status(self) -> dict:
        """
        获取所有模型服务状态

        作用：
            返回所有端点的状态信息，供管理 API / 监控使用。

        返回:
            dict - 按 model_type 分组的状态列表
        """
        return self._registry.list_all()

    def get_available_count(self, model_type: str) -> int:
        """
        获取某类型的可用端点数

        参数：
            model_type: str - 模型类型

        返回:
            int - 可用端点数（breaker 未 OPEN）
        """
        return self._router.get_available_count(model_type)

    def _ensure_initialized(self) -> None:
        """
        确保管理器已初始化

        作用：
            如果未初始化，自动调用 initialize()。
            避免调用方忘记初始化导致错误。
        """
        if not self._initialized:
            self.initialize()


# ============================================
# 全局单例（懒加载，线程安全）
# ============================================

_manager_instance: Optional[ModelProviderManager] = None
_manager_lock = threading.Lock()


def get_model_manager() -> ModelProviderManager:
    """
    获取模型提供者管理器单例（线程安全）

    作用：
        首次调用时创建实例，后续复用。
        使用双重检查锁定模式避免性能损耗。

    返回:
        ModelProviderManager - 管理器实例
    """
    global _manager_instance
    if _manager_instance is None:
        with _manager_lock:
            if _manager_instance is None:
                _manager_instance = ModelProviderManager()
    return _manager_instance
