"""
模型客户端抽象基类

作用：
    定义所有模型客户端的统一接口，实现业务逻辑与底层模型实现解耦。
    业务层通过此抽象与模型交互，无需关心是 OpenAI API、Ollama 还是本地 HuggingFace。

设计原则：
    - 客户端是无状态的（状态由 breaker 和 health 管理）
    - 客户端不关心降级策略（由 FailoverRouter 决定用哪个客户端）
    - 客户端只负责"一次调用"，重试由客户端内部统一处理
    - 每个客户端绑定独立熔断器（按 "{model_type}:{name}" 命名），主备独立熔断

类层级：
    BaseModelClient(ABC)                # 顶层抽象：健康检查、熔断器、资源管理
    ├── TextModelClient(ABC)            # 文本 LLM：invoke / astream
    ├── EmbeddingModelClient(ABC)       # 向量：embed_query
    └── VisionModelClient(ABC)          # 多模态：describe_image
"""

import logging
from abc import ABC, abstractmethod
from typing import AsyncGenerator, List, Optional

from langchain_core.messages import BaseMessage

from app.core.circuit_breaker import CircuitBreaker, get_circuit_breaker
from app.core.model_provider.diagnostics import safe_error_label
from app.core.model_provider.schemas import ProviderEndpointConfig

logger = logging.getLogger(__name__)


class BaseModelClient(ABC):
    """
    模型客户端抽象基类

    作用：
        定义所有模型客户端的统一接口。
        子类需实现具体的调用逻辑（invoke/embed_query/describe_image）和健康探测。

    核心属性：
        config: ProviderEndpointConfig - 端点配置
        name: str - 端点名称（如 "primary"）
        breaker: CircuitBreaker - 独立熔断器（按 "{model_type}:{name}" 隔离）
        is_enabled: bool - 是否启用
        is_healthy: bool - 是否健康（breaker 未 OPEN）

    使用方式：
        子类继承并实现抽象方法，由工厂创建实例，由路由器选择使用。
    """

    def __init__(self, config: ProviderEndpointConfig):
        """
        初始化模型客户端

        参数：
            config: ProviderEndpointConfig - 端点配置
        """
        self.config = config
        self.name = config.name
        # 每个客户端绑定独立熔断器，主备隔离
        # 作用：主模型熔断不影响降级模型的熔断状态，反之亦然
        self.breaker: CircuitBreaker = get_circuit_breaker(
            f"{self.model_type}:{self.name}"
        )

    @property
    @abstractmethod
    def model_type(self) -> str:
        """
        模型类型标识

        返回：
            str - "llm" | "embedding" | "vision"
        """

    @property
    def is_enabled(self) -> bool:
        """
        是否启用此端点

        作用：
            配置中 enabled=false 的端点不会被路由器选中。
        """
        return self.config.enabled

    @property
    def is_healthy(self) -> bool:
        """
        是否健康（熔断器未打开）

        作用：
            路由器据此判断是否可用。
            返回 True 表示 breaker CLOSED 或 HALF_OPEN（可放行探测请求）。
            返回 False 表示 breaker OPEN（应跳过，选下一个降级端点）。

        返回：
            bool - True 表示可用，False 表示熔断中
        """
        return not self.breaker.is_open()

    @abstractmethod
    async def health_probe(self) -> bool:
        """
        主动健康探测

        作用：
            用最小代价请求验证服务可用性。
            探测结果喂入熔断器（不直接参与路由决策）：
            - 成功 → breaker.record_success()（重置失败计数）
            - 失败 → breaker.record_failure()（累计失败，达阈值才 OPEN）

        返回：
            bool - 探测是否成功
        """

    @abstractmethod
    def close(self):
        """
        释放资源

        作用：
            关闭连接池、释放模型内存等。
            在应用关闭时由 manager 统一调用。
        """


class TextModelClient(BaseModelClient):
    """
    文本 LLM 客户端基类

    作用：
        定义文本模型的统一调用接口，支持非流式和流式两种模式。
        子类需实现具体的 invoke/astream 逻辑。

    使用方式：
        client = manager.get_text_client()  # 路由器选择健康的客户端
        answer = client.invoke(messages)     # 非流式
        async for chunk in client.astream(messages):  # 流式
            print(chunk)
    """

    @property
    def model_type(self) -> str:
        """模型类型标识：llm"""
        return "llm"

    @abstractmethod
    def invoke(self, messages: List[BaseMessage]) -> str:
        """
        非流式调用 LLM

        作用：
            调用 LLM 生成完整回答，内置重试+熔断+超时。
            由具体子类实现（如 OpenAITextClient）。

        参数：
            messages: List[BaseMessage] - LangChain 消息列表（system/history/human）

        返回：
            str - LLM 生成的完整文本

        异常：
            CircuitBreakerOpenError - 熔断器打开
            ModelInvocationError - 调用失败（重试耗尽）
        """

    @abstractmethod
    async def astream(self, messages: List[BaseMessage]) -> AsyncGenerator[str, None]:
        """
        流式调用 LLM

        作用：
            异步流式生成回答，逐块 yield 文本。
            内置首字超时重试+熔断。

        参数：
            messages: List[BaseMessage] - LangChain 消息列表

        返回：
            AsyncGenerator[str, None] - 文本块生成器

        异常：
            CircuitBreakerOpenError - 熔断器打开
            ModelInvocationError - 调用失败
        """

    async def health_probe(self) -> bool:
        """
        健康探测：发送 "ping" 单字消息

        作用：
            用最小代价请求验证 LLM 服务可用性。
            max_tokens=1 确保探测成本极低。

        返回：
            bool - 探测是否成功
        """
        try:
            import asyncio
            from langchain_core.messages import HumanMessage

            async def _probe():
                messages = [HumanMessage(content="ping")]
                # 用非流式调用探测，取首个 chunk 即可
                # 注意：这里不调用 invoke（可能触发重试），直接用底层 SDK 探测
                async for _ in self.astream(messages):
                    break  # 收到首字即认为健康

            await asyncio.wait_for(_probe(), timeout=self.config.health_check.timeout)
            self.breaker.record_success()
            return True
        except Exception as e:
            logger.debug(
                f"[{self.model_type}:{self.name}] 健康探测失败: {safe_error_label(e)}"
            )
            self.breaker.record_failure()
            return False


class EmbeddingModelClient(BaseModelClient):
    """
    Embedding 向量模型客户端基类

    作用：
        定义向量模型的统一调用接口。
        子类需实现 embed_query 和 dimension。

    使用方式：
        client = manager.get_embedding_client()
        vector = client.embed_query("文本内容")
    """

    @property
    def model_type(self) -> str:
        """模型类型标识：embedding"""
        return "embedding"

    @property
    @abstractmethod
    def dimension(self) -> int:
        """
        向量维度

        返回：
            int - 向量维度（如 1536 for ada-002, 512 for bge-small-zh）
        """

    @abstractmethod
    def embed_query(self, text: str) -> List[float]:
        """
        生成文本的向量表示

        作用：
            将文本转换为向量，用于向量化存储和相似度检索。
            内置熔断保护。

        参数：
            text: str - 待向量化的文本

        返回：
            List[float] - 向量

        异常：
            CircuitBreakerOpenError - 熔断器打开
            ModelInvocationError - 调用失败
        """

    async def health_probe(self) -> bool:
        """
        健康探测：向量化 "ping" 单字

        作用：
            用最短文本验证 Embedding 服务可用性。

        返回：
            bool - 探测是否成功
        """
        try:
            import asyncio

            await asyncio.wait_for(
                asyncio.to_thread(self.embed_query, "ping"),
                timeout=self.config.health_check.timeout,
            )
            self.breaker.record_success()
            return True
        except Exception as e:
            logger.debug(f"[{self.model_type}:{self.name}] 健康探测失败: {e}")
            self.breaker.record_failure()
            return False


class VisionModelClient(BaseModelClient):
    """
    多模态 Vision 客户端基类

    作用：
        定义图片描述的统一调用接口。
        子类需实现 describe_image。

    使用方式：
        client = manager.get_vision_client()
        description = client.describe_image("/path/to/image.png")
    """

    @property
    def model_type(self) -> str:
        """模型类型标识：vision"""
        return "vision"

    @abstractmethod
    def describe_image(self, image_path: str, prompt: Optional[str] = None) -> str:
        """
        描述图片内容

        作用：
            调用多模态模型生成图片描述。
            内置重试+熔断+超时。
            失败时返回空字符串（保持现有 ImageProcessor 行为兼容）。

        参数：
            image_path: str - 图片文件路径
            prompt: Optional[str] - 自定义提示词，None 用客户端默认

        返回：
            str - 图片描述（失败返回空字符串）
        """

    async def health_probe(self) -> bool:
        """
        健康探测：用 1x1 透明 PNG 探测

        作用：
            用最小图片验证 Vision 服务可用性。
            max_tokens=1 确保探测成本极低。

        返回：
            bool - 探测是否成功
        """
        try:
            import asyncio
            import base64
            import tempfile

            # 1x1 透明 PNG 的 base64
            # 作用：最小合法图片，减少探测成本
            tiny_png_b64 = (
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
                "nGNgYGBgAQAAJABSEA8i6wAAAABJRU5ErkJggg=="
            )

            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                f.write(base64.b64decode(tiny_png_b64))
                temp_path = f.name

            try:
                await asyncio.wait_for(
                    asyncio.to_thread(self.describe_image, temp_path),
                    timeout=self.config.health_check.timeout,
                )
                self.breaker.record_success()
                return True
            finally:
                import os
                os.unlink(temp_path)

        except Exception as e:
            logger.debug(f"[{self.model_type}:{self.name}] 健康探测失败: {e}")
            self.breaker.record_failure()
            return False
