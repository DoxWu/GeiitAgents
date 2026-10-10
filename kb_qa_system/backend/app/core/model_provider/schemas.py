"""
模型提供者配置数据模型

作用：
    使用 Pydantic 定义 YAML 配置文件的结构化数据模型。
    提供类型校验和默认值，确保配置加载后的数据完整性。

配置层级：
    ModelProviderConfig              # 完整配置
    ├── defaults: dict               # 全局默认参数
    └── providers: dict[str, list[ProviderEndpointConfig]]
        ├── "llm": [primary, fallback, local_fallback]
        ├── "embedding": [primary, local_fallback]
        └── "vision": [primary, fallback]
"""

from typing import Any, Optional

from pydantic import BaseModel, Field


class HealthCheckConfig(BaseModel):
    """
    单个 provider 的健康检查配置

    作用：
        控制主动健康探测行为。主动探测结果喂入熔断器，
        不直接参与路由决策（避免误报导致误切降级）。

    字段：
        enabled: bool - 是否启用主动探测（本地模型通常关闭）
        interval: int - 探测间隔（秒），默认 60
        timeout: int - 探测超时（秒），默认 10
    """

    enabled: bool = True
    interval: int = 60
    timeout: int = 10


class ProviderEndpointConfig(BaseModel):
    """
    单个模型端点配置

    作用：
        描述一个模型服务端点的完整配置，包括连接信息、认证、性能参数。
        每个 model_type 下可有多个端点，按列表顺序确定优先级（[0] 为主模型）。

    字段说明：
        name: 端点名称（primary/fallback/local_fallback），用于熔断器隔离和日志标识
        type: 端点类型（openai | local_ollama | local_hf）
        model: 模型名称（如 gpt-3.5-turbo、text-embedding-ada-002）
        api_key: API Key（OpenAI 兼容服务商用，本地模型可留空或填占位符）
        api_base: API Base URL
        dimension: Embedding 向量维度（仅 embedding 类型需要）
        temperature: 采样温度（LLM/Vision 用）
        timeout: 调用超时（秒）
        max_retries: 最大重试次数
        retry_base_delay: 重试基础间隔（秒），指数退避
        stream_first_token_timeout: 流式首字超时（秒，仅 LLM 用）
        max_tokens: 最大输出 token 数（仅 Vision 用）
        enabled: 是否启用此端点
        health_check: 健康检查配置
        tags: 标签列表（用于分类和筛选）
    """

    name: str
    type: str = "openai"
    model: str = ""
    api_key: str = ""
    api_base: str = ""
    dimension: Optional[int] = None
    supports_dimensions: bool = False
    temperature: float = 0.1
    timeout: int = 30
    max_retries: int = 3
    retry_base_delay: float = 1.0
    stream_first_token_timeout: int = 5
    max_tokens: Optional[int] = None
    enabled: bool = True
    health_check: HealthCheckConfig = Field(default_factory=HealthCheckConfig)
    tags: list[str] = Field(default_factory=list)


class ModelProviderConfig(BaseModel):
    """
    完整模型提供者配置

    作用：
    从 providers.yaml 加载后的结构化配置对象。
    包含全局默认参数和三组模型类型的端点列表。

    字段：
        defaults: dict - 全局默认参数（可被各端点覆盖）
        providers: dict[str, list[ProviderEndpointConfig]] - 模型端点配置
            键为 model_type（"llm"/"embedding"/"vision"）
            值为按优先级排序的端点列表
    """

    defaults: dict[str, Any] = Field(default_factory=dict)
    providers: dict[str, list[ProviderEndpointConfig]] = Field(default_factory=dict)
