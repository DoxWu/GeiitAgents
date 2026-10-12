"""
本地 HuggingFace Embedding 客户端

作用：
    在线 Embedding API 不可用时的本地兜底。
    复用 LangChain HuggingFaceEmbeddings，支持 sentence-transformers 模型。

使用方式：
    client = LocalHuggingFaceEmbeddingClient(config)
    vector = client.embed_query("文本内容")
"""

import logging
from typing import List

from app.core.model_provider.base import EmbeddingModelClient
from app.core.model_provider.exceptions import ModelInvocationError
from app.core.model_provider.schemas import ProviderEndpointConfig

logger = logging.getLogger(__name__)


class LocalHuggingFaceEmbeddingClient(EmbeddingModelClient):
    """
    本地 HuggingFace Embedding 客户端

    作用：
        在线 Embedding 不可用时的本地兜底。
        使用 sentence-transformers 模型在本地 CPU/GPU 上运行。

    特点：
        - 懒加载模型（避免启动时加载大模型）
        - 无熔断器保护（本地模型不涉及网络故障）
        - 无超时（本地计算无超时概念）
        - 失败抛 ModelInvocationError（由路由器处理）

    使用方式：
        client = LocalHuggingFaceEmbeddingClient(config)
        vector = client.embed_query("文本内容")
    """

    def __init__(self, config: ProviderEndpointConfig):
        """
        初始化本地 Embedding 客户端

        参数：
            config: ProviderEndpointConfig - 端点配置（model 为 HuggingFace 模型名）
        """
        super().__init__(config)
        self._embeddings = None  # 懒加载

    @property
    def embeddings(self):
        """
        获取 HuggingFaceEmbeddings 实例（懒加载）

        作用：
            首次访问时加载模型。模型加载较慢（需下载权重），
            懒加载避免应用启动时就加载大模型。

        异常处理：
            加载失败时记录错误但不抛出（返回 None），
            调用 embed_query 时才抛 ModelInvocationError。
        """
        if self._embeddings is None:
            try:
                from langchain_huggingface import HuggingFaceEmbeddings
                self._embeddings = HuggingFaceEmbeddings(
                    model_name=self.config.model,
                )
                logger.info(
                    f"[{self.model_type}:{self.name}] 本地 Embedding 模型已加载: "
                    f"{self.config.model}"
                )
            except Exception as e:
                logger.error(
                    f"[{self.model_type}:{self.name}] 加载本地 Embedding 模型失败: {e}"
                )
                self._embeddings = None
        return self._embeddings

    @property
    def dimension(self) -> int:
        """
        向量维度

        返回：
            int - 配置的向量维度，默认 512（bge-small-zh-v1.1）
        """
        return self.config.dimension or 512

    def embed_query(self, text: str) -> List[float]:
        """
        生成文本的向量表示（本地模型）

        作用：
            使用本地 sentence-transformers 模型生成向量。

        参数：
            text: str - 待向量化的文本

        返回:
            List[float] - 向量

        异常:
            ModelInvocationError - 模型未加载或调用失败
        """
        emb = self.embeddings
        if emb is None:
            raise ModelInvocationError(
                f"[{self.name}] 本地 Embedding 模型未加载: {self.config.model}",
                provider_name=self.name,
                original_exc=RuntimeError("模型未加载"),
            )

        try:
            # 本地模型无需熔断器（无网络故障）
            vector = emb.embed_query(text)
            return vector
        except Exception as e:
            logger.error(f"[{self.model_type}:{self.name}] 本地 Embedding 调用失败: {e}")
            raise ModelInvocationError(
                f"[{self.name}] 本地 Embedding 调用失败: {type(e).__name__}: {e}",
                provider_name=self.name,
                original_exc=e,
            ) from e

    async def health_probe(self) -> bool:
        """
        健康探测：检查模型是否已加载

        作用：
            本地模型不做主动网络探测，仅检查模型是否可用。
            如果模型已加载，视为健康。

        返回：
            bool - 模型是否可用
        """
        emb = self.embeddings
        if emb is not None:
            self.breaker.record_success()
            return True
        else:
            self.breaker.record_failure()
            return False

    def close(self):
        """
        释放资源

        作用：
            释放模型内存。
        """
        self._embeddings = None
