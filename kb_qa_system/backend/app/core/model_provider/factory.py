"""
模型客户端工厂

作用：
    根据 ProviderEndpointConfig.type 创建对应的客户端实例。
    业务层不关心具体实现类，只通过工厂获取客户端。

工厂模式优势：
    - 解耦：业务层不依赖具体客户端类，只依赖抽象基类
    - 可扩展：新增模型类型只需在工厂注册，不影响业务代码
    - 集中管理：所有客户端创建逻辑在一处

使用方式：
    client = ModelClientFactory.create_text_client(config)
    answer = client.invoke(messages)
"""

import logging

from app.core.model_provider.base import (
    EmbeddingModelClient,
    TextModelClient,
    VisionModelClient,
)
from app.core.model_provider.clients import (
    LocalHuggingFaceEmbeddingClient,
    OllamaTextClient,
    OpenAIEmbeddingClient,
    OpenAITextClient,
    OpenAIVisionClient,
)
from app.core.model_provider.exceptions import ModelClientUnavailableError
from app.core.model_provider.schemas import ProviderEndpointConfig

logger = logging.getLogger(__name__)


class ModelClientFactory:
    """
    模型客户端工厂

    作用：
        根据 config.type 创建对应的客户端实例。
        支持的 type：
        - 文本：openai, local_ollama
        - 向量：openai, local_hf
        - 多模态：openai

    使用方式：
        client = ModelClientFactory.create_text_client(config)
    """

    @staticmethod
    def create_text_client(config: ProviderEndpointConfig) -> TextModelClient:
        """
        创建文本模型客户端

        作用：
            根据 config.type 创建对应的文本客户端。

        参数：
            config: ProviderEndpointConfig - 端点配置

        返回:
            TextModelClient - 文本客户端实例

        异常:
            ModelClientUnavailableError - 未知 type 或创建失败
        """
        try:
            if config.type == "openai":
                return OpenAITextClient(config)
            elif config.type == "local_ollama":
                return OllamaTextClient(config)
            else:
                raise ModelClientUnavailableError(
                    f"未知文本客户端类型: {config.type}（支持: openai, local_ollama）"
                )
        except ModelClientUnavailableError:
            raise
        except Exception as e:
            raise ModelClientUnavailableError(
                f"创建文本客户端失败 [{config.name}/{config.type}]: {type(e).__name__}"
            ) from None

    @staticmethod
    def create_embedding_client(config: ProviderEndpointConfig) -> EmbeddingModelClient:
        """
        创建 Embedding 客户端

        作用：
            根据 config.type 创建对应的 Embedding 客户端。

        参数：
            config: ProviderEndpointConfig - 端点配置

        返回:
            EmbeddingModelClient - Embedding 客户端实例

        异常:
            ModelClientUnavailableError - 未知 type 或创建失败
        """
        try:
            if config.type == "openai":
                return OpenAIEmbeddingClient(config)
            elif config.type == "local_hf":
                return LocalHuggingFaceEmbeddingClient(config)
            else:
                raise ModelClientUnavailableError(
                    f"未知 Embedding 客户端类型: {config.type}（支持: openai, local_hf）"
                )
        except ModelClientUnavailableError:
            raise
        except Exception as e:
            raise ModelClientUnavailableError(
                f"创建 Embedding 客户端失败 [{config.name}/{config.type}]: {type(e).__name__}"
            ) from None

    @staticmethod
    def create_vision_client(config: ProviderEndpointConfig) -> VisionModelClient:
        """
        创建 Vision 客户端

        作用：
            根据 config.type 创建对应的多模态客户端。

        参数：
            config: ProviderEndpointConfig - 端点配置

        返回:
            VisionModelClient - Vision 客户端实例

        异常:
            ModelClientUnavailableError - 未知 type 或创建失败
        """
        try:
            if config.type == "openai":
                return OpenAIVisionClient(config)
            else:
                raise ModelClientUnavailableError(
                    f"未知 Vision 客户端类型: {config.type}（支持: openai）"
                )
        except ModelClientUnavailableError:
            raise
        except Exception as e:
            raise ModelClientUnavailableError(
                f"创建 Vision 客户端失败 [{config.name}/{config.type}]: {type(e).__name__}"
            ) from None

    @staticmethod
    def create_client(config: ProviderEndpointConfig, model_type: str):
        """
        通用创建方法（按 model_type 分发）

        作用：
            根据 model_type 调用对应的工厂方法。

        参数：
            config: ProviderEndpointConfig - 端点配置
            model_type: str - 模型类型（llm/embedding/vision）

        返回:
            BaseModelClient - 对应类型的客户端实例

        异常:
            ModelClientUnavailableError - 未知 model_type
        """
        if model_type == "llm":
            return ModelClientFactory.create_text_client(config)
        elif model_type == "embedding":
            return ModelClientFactory.create_embedding_client(config)
        elif model_type == "vision":
            return ModelClientFactory.create_vision_client(config)
        else:
            raise ModelClientUnavailableError(
                f"未知模型类型: {model_type}（支持: llm, embedding, vision）"
            )
