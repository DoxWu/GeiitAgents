"""
OpenAI 兼容 Embedding 客户端

作用：
    封装 openai SDK 直接调用，提供带熔断保护的向量化调用。
    兼容 OpenAI / 阿里云 / 智谱 / Ollama(OpenAI模式) 等。

技术决策：
    使用 openai.OpenAI 直接调用而非 langchain_openai.OpenAIEmbeddings，
    以支持 dimensions 参数（阿里云 text-embedding-v4 等模型需显式指定输出维度，
    确保向量维度与 DB pgvector 列一致）。

容错机制：
    1. 熔断器（Redis）：在线 API 持续失败时快速失败
    2. 超时控制：timeout 限制单次调用

使用方式：
    client = OpenAIEmbeddingClient(config)
    vector = client.embed_query("文本内容")
"""

import logging
from typing import List

from app.core.circuit_breaker import CircuitBreakerOpenError
from app.core.model_provider.base import EmbeddingModelClient
from app.core.model_provider.clients._retry_utils import is_retryable
from app.core.model_provider.exceptions import ModelInvocationError
from app.core.model_provider.schemas import ProviderEndpointConfig

logger = logging.getLogger(__name__)


class OpenAIEmbeddingClient(EmbeddingModelClient):
    """
    OpenAI 兼容 Embedding 客户端

    作用：
        封装 openai.OpenAI SDK，提供 embed_query 接口。
        内置熔断器保护，失败时由路由器切换到降级端点。
        支持 dimensions 参数，确保向量维度与 DB pgvector 列一致。

    容错流程：
        1. 熔断器检查 → 打开则快速失败
        2. 调用 openai.OpenAI.embeddings.create（含 dimensions 参数）
        3. 成功 → record_success
        4. 可重试错误 → record_failure + 抛异常（由路由器选下一个端点）
    """

    def __init__(self, config: ProviderEndpointConfig):
        """
        初始化 OpenAI Embedding 客户端

        参数：
            config: ProviderEndpointConfig - 端点配置
        """
        super().__init__(config)
        self._client = None  # 懒加载

    @property
    def client(self):
        """
        获取 OpenAI 客户端实例（懒加载）

        作用：
            首次访问时创建 openai.OpenAI 客户端实例。
            直接使用 openai SDK 而非 langchain_openai.OpenAIEmbeddings，
            以支持 dimensions 参数（阿里云 text-embedding-v4 等模型需显式指定输出维度）。
            懒加载避免应用启动时就创建连接（需要 API Key）。
        """
        if self._client is None:
            from openai import OpenAI
            self._client = OpenAI(
                api_key=self.config.api_key,
                base_url=self.config.api_base,
                timeout=self.config.timeout,
            )
        return self._client

    @property
    def dimension(self) -> int:
        """
        向量维度

        返回：
            int - 配置的向量维度，默认 1536（text-embedding-ada-002）
        """
        return self.config.dimension or 1536

    def embed_query(self, text: str) -> List[float]:
        """
        生成文本的向量表示（带熔断保护）

        作用：
            将文本转换为向量，用于向量化存储和相似度检索。

        容错流程：
            1. 熔断器检查 → 打开则快速失败（路由器会选降级端点）
            2. 调用 OpenAIEmbeddings.embed_query
            3. 成功 → record_success + 返回向量
            4. 失败 → record_failure（仅可重试错误）+ 抛异常

        参数：
            text: str - 待向量化的文本

        返回:
            List[float] - 向量

        异常:
            CircuitBreakerOpenError - 熔断器打开
            ModelInvocationError - 调用失败
        """
        if self.breaker.is_open():
            raise CircuitBreakerOpenError(
                self.breaker.service, self.breaker.get_retry_after()
            )

        try:
            # 构建 API 调用参数
            # Only opt in when this endpoint/model explicitly supports dimensions.
            # dimension also describes fixed-size models; ada-002 rejects the parameter.
            kwargs = {
                "model": self.config.model,
                "input": text,
            }
            if self.config.dimension and self.config.supports_dimensions:
                kwargs["dimensions"] = self.config.dimension

            response = self.client.embeddings.create(**kwargs)
            vector = response.data[0].embedding
            self.breaker.record_success()
            return vector
        except Exception as e:
            if is_retryable(e):
                self.breaker.record_failure()
            logger.warning(
                f"[{self.model_type}:{self.name}] Embedding 调用失败: "
                f"{type(e).__name__}: {e}"
            )
            raise ModelInvocationError(
                f"[{self.name}] Embedding 调用失败: {type(e).__name__}: {e}",
                provider_name=self.name,
                original_exc=e,
            ) from e

    def close(self):
        """
        释放资源

        作用：
            释放 openai.OpenAI 客户端引用，允许 GC 回收连接池。
        """
        self._client = None
