"""
模型提供者配置加载器

作用：
    从 providers.yaml 加载配置，解析 ${VAR} / ${VAR:default} 占位符为环境变量值。
    支持嵌套引用（${VAR:${OTHER}}），Railway 注入的环境变量优先于 YAML 默认值。

加载流程：
    1. 读取 providers.yaml 文件内容
    2. 用正则匹配 ${VAR} / ${VAR:default} 占位符并替换为环境变量值
    3. 用 PyYAML 解析为字典
    4. 用 Pydantic 校验为 ModelProviderConfig 对象

容错策略：
    - 配置文件不存在或解析失败时，回退到纯环境变量模式（保证不破坏现有部署）
    - 占位符引用的环境变量不存在时：${VAR} 替换为空串，${VAR:default} 替换为 default
"""

import logging
import os
import re
from collections.abc import Mapping
from pathlib import Path

from app.core.model_provider.schemas import (
    HealthCheckConfig,
    ModelProviderConfig,
    ProviderEndpointConfig,
)

logger = logging.getLogger(__name__)

# 默认配置文件路径（相对于本文件）
# 作用：providers.yaml 与本模块同目录，便于打包和部署
_DEFAULT_CONFIG_PATH = Path(__file__).parent / "providers.yaml"

# 占位符正则（匹配最内层 ${...}，不包含嵌套的 ${...}）
# 作用：通过排除 $ 和 { 字符，确保每次只匹配最内层占位符
#   - ${VAR}：变量不存在时替换为空串
#   - ${VAR:default}：变量不存在时替换为 default
#   - ${VAR:${OTHER}}：先匹配内层 ${OTHER}，解析后再匹配外层 ${VAR:...}
#   - 使用循环替换实现嵌套，而非递归（避免正则截断嵌套默认值）
_PLACEHOLDER_PATTERN = re.compile(r"\$\{([^${}:]+)(?::([^${}]*))?\}")


def _resolve_env_placeholders(
    text: str, _depth: int = 0, *, environment: Mapping[str, str] | None = None
) -> str:
    """
    解析 ${VAR} 和 ${VAR:default} 占位符为环境变量值

    作用：
        将 YAML 文本中的环境变量占位符替换为实际值。
        支持嵌套引用（${VAR:${OTHER}}），通过循环替换最内层占位符实现。

    参数：
        text: str - 含占位符的 YAML 文本
        _depth: int - 递归深度（防无限循环，内部参数，当前实现使用循环而非递归）

    返回：
        str - 占位符已替换的文本

    解析规则：
        - ${VAR} → os.environ.get("VAR", "")
        - ${VAR:default} → os.environ.get("VAR", default)
        - ${VAR:${OTHER}} → 先解析内层 ${OTHER} 得到值，再解析外层 ${VAR:值}
        - 环境变量优先于 YAML 默认值（Railway 注入的 env 覆盖 .env 和 YAML）

    嵌套处理方式：
        使用"最内层优先"策略 + 循环替换：
        1. 正则排除了 $ 和 { 字符，只匹配不含嵌套 ${...} 的最内层占位符
        2. 每次循环替换所有最内层占位符
        3. 重复直到文本中不再有占位符
        这样 ${OUTER:${INNER}} 会先解析 ${INNER}，再解析 ${OUTER:...}
    """
    # 防止无限循环（限制最大迭代次数）
    max_iterations = 10
    if _depth >= max_iterations:
        return text

    def _replace_match(match: re.Match) -> str:
        var_name = match.group(1)
        default_value = match.group(2)  # 可能为 None

        # 优先取环境变量
        env_value = (os.environ if environment is None else environment).get(var_name)
        if env_value is not None and env_value.strip():
            return env_value

        # 环境变量不存在，用默认值
        if default_value is not None:
            # 默认值已经是简单字符串（最内层正则排除了 ${} ）
            # 外层占位符会在下一次循环中处理
            return default_value

        # 既无环境变量也无默认值，替换为空串
        return ""

    # 循环替换：每次替换最内层的占位符，直到没有占位符或达到深度限制
    previous = None
    iteration = 0
    while previous != text and iteration < max_iterations:
        previous = text
        text = _PLACEHOLDER_PATTERN.sub(_replace_match, text)
        iteration += 1

    return text


def _convert_env_strings(config: ModelProviderConfig) -> ModelProviderConfig:
    """
    将配置中字符串形式的数字/布尔值转为正确类型

    作用：
        YAML 经 env 占位符替换后，所有值都是字符串。
        Pydantic 会自动转换大部分字段，但部分字段（如 enabled 的 "true"/"false"）
        需要确保正确解析。此函数对 Pydantic 已正确处理的字段不做额外操作，
        仅作为兼容层确保字符串值被正确转换。

    参数：
        config: ModelProviderConfig - 原始配置对象

    返回：
        ModelProviderConfig - 类型修正后的配置对象
    """
    # Pydantic 的 str → bool 转换规则：仅 "true"/"1"/"yes"/"on"（不区分大小写）为 True
    # env 占位符替换后 enabled 字段可能是 "true"/"false" 字符串，Pydantic 会正确处理
    # 此函数保留为扩展点，当前无需额外处理
    return config


class ConfigLoader:
    """
    配置加载器

    作用：
        从 YAML 文件加载模型提供者配置，解析环境变量占位符。
        提供单例访问（get_instance / load）。

    使用方式：
        config = ConfigLoader.load()
        llm_providers = config.providers.get("llm", [])
    """

    @staticmethod
    def load(config_path: str | None = None) -> ModelProviderConfig:
        """
        加载配置文件

        作用：
            读取 YAML → 解析 env 占位符 → Pydantic 校验 → 返回配置对象。
            加载失败时回退到纯环境变量模式（从 settings 构建默认配置）。

        参数：
            config_path: Optional[str] - YAML 文件路径，None 时用默认路径

        返回：
            ModelProviderConfig - 解析后的配置对象
        """
        path = Path(config_path) if config_path else _DEFAULT_CONFIG_PATH

        try:
            raw_text = path.read_text(encoding="utf-8")
            # Match Settings' .env location and precedence without mutating process env.
            from dotenv import dotenv_values

            environment = {
                key: value for key, value in dotenv_values(".env").items() if value is not None
            }
            environment.update(os.environ)
            resolved_text = _resolve_env_placeholders(raw_text, environment=environment)

            # 延迟导入 PyYAML，避免未安装时影响整个模块加载
            import yaml

            raw_dict = yaml.safe_load(resolved_text) or {}

            config = ModelProviderConfig(**raw_dict)
            config = _convert_env_strings(config)
            _ensure_primary_embedding_space_id(config)
            _disable_incompatible_embedding_fallbacks(config)

            logger.info(
                f"模型提供者配置已加载: "
                f"LLM {len(config.providers.get('llm', []))} 个端点, "
                f"Embedding {len(config.providers.get('embedding', []))} 个端点, "
                f"Vision {len(config.providers.get('vision', []))} 个端点"
            )
            return config

        except FileNotFoundError:
            logger.warning(f"配置文件不存在: {path}，回退到纯环境变量模式")
            return ConfigLoader._fallback_from_env()
        except Exception as e:
            logger.error(
                "加载模型服务配置失败（%s），回退到纯环境变量模式",
                type(e).__name__,
            )
            return ConfigLoader._fallback_from_env()

    @staticmethod
    def _fallback_from_env() -> ModelProviderConfig:
        """
        纯环境变量回退模式

        作用：
            当 YAML 配置文件不可用时，从现有 settings 环境变量构建最小配置。
            确保系统在配置文件缺失时仍能工作（向后兼容）。

        返回：
            ModelProviderConfig - 从环境变量构建的配置对象
        """
        from app.core.config import settings
        from dotenv import dotenv_values

        environment = {key: value for key, value in dotenv_values(".env").items() if value is not None}
        environment.update(os.environ)

        def env_value(name: str, *fallbacks: str, default: str = "") -> str:
            for value in (environment.get(name), *fallbacks):
                if value is not None and str(value).strip():
                    return str(value).strip()
            return default

        def env_bool(name: str, default: bool) -> bool:
            value = environment.get(name)
            if value is None or not str(value).strip():
                return default
            normalized = str(value).strip().lower()
            if normalized in {"1", "true", "yes", "on"}:
                return True
            if normalized in {"0", "false", "no", "off"}:
                return False
            return default

        def env_int(name: str, default: int) -> int:
            try:
                value = int(environment.get(name, default))
                return value if value > 0 else default
            except (TypeError, ValueError):
                return default

        aliyun_api_key = settings.ALIYUN_API_KEY or settings.OPENAI_API_KEY
        aliyun_api_base = settings.ALIYUN_API_BASE or settings.OPENAI_API_BASE
        aliyun_llm_model = settings.ALIYUN_LLM_MODEL or settings.LLM_MODEL_NAME
        aliyun_embedding_model = settings.ALIYUN_EMBEDDING_MODEL or settings.EMBEDDING_MODEL_NAME
        deepseek_enabled = settings.DEEPSEEK_LLM_ENABLED or settings.LLM_FALLBACK_ENABLED

        language_primary_key = env_value("MODEL_LANGUAGE_PRIMARY_API_KEY", aliyun_api_key)
        language_primary_base = env_value("MODEL_LANGUAGE_PRIMARY_API_URL", aliyun_api_base)
        language_primary_model = env_value("MODEL_LANGUAGE_PRIMARY_MODEL", aliyun_llm_model)
        llm_providers = [
            ProviderEndpointConfig(
                name="primary",
                type="openai",
                model=language_primary_model,
                api_key=language_primary_key,
                api_base=language_primary_base,
                temperature=0.1,
                timeout=settings.LLM_TIMEOUT,
                max_retries=settings.LLM_MAX_RETRIES,
                retry_base_delay=settings.LLM_RETRY_BASE_DELAY,
                stream_first_token_timeout=settings.LLM_STREAM_FIRST_TOKEN_TIMEOUT,
                enabled=True,
            ),
            ProviderEndpointConfig(
                name="fallback",
                type="openai",
                model=env_value("MODEL_LANGUAGE_FALLBACK_MODEL", settings.DEEPSEEK_LLM_MODEL or settings.LLM_FALLBACK_MODEL_NAME),
                api_key=env_value("MODEL_LANGUAGE_FALLBACK_API_KEY", settings.DEEPSEEK_API_KEY or settings.LLM_FALLBACK_API_KEY or settings.OPENAI_API_KEY),
                api_base=env_value("MODEL_LANGUAGE_FALLBACK_API_URL", settings.DEEPSEEK_API_BASE or settings.LLM_FALLBACK_API_BASE or settings.OPENAI_API_BASE),
                temperature=0.1,
                timeout=settings.LLM_TIMEOUT,
                max_retries=1,
                enabled=env_bool("MODEL_LANGUAGE_FALLBACK_ENABLED", deepseek_enabled),
            ),
        ]

        embedding_providers = [
            ProviderEndpointConfig(
                name="primary",
                type="openai",
                model=env_value("MODEL_EMBEDDING_PRIMARY_MODEL", aliyun_embedding_model),
                api_key=env_value("MODEL_EMBEDDING_PRIMARY_API_KEY", aliyun_api_key),
                api_base=env_value("MODEL_EMBEDDING_PRIMARY_API_URL", aliyun_api_base),
                dimension=env_int("MODEL_EMBEDDING_PRIMARY_DIMENSION", settings.EMBEDDING_DIMENSION),
                vector_space_id=env_value("MODEL_EMBEDDING_PRIMARY_VECTOR_SPACE") or None,
                supports_dimensions=env_bool("MODEL_EMBEDDING_PRIMARY_SUPPORTS_DIMENSIONS", False),
                timeout=settings.EMBEDDING_TIMEOUT,
                max_retries=2,
                enabled=True,
            ),
            ProviderEndpointConfig(
                name="cloud_fallback",
                type="openai",
                model=env_value("MODEL_EMBEDDING_FALLBACK_MODEL"),
                api_key=env_value("MODEL_EMBEDDING_FALLBACK_API_KEY"),
                api_base=env_value("MODEL_EMBEDDING_FALLBACK_API_URL"),
                dimension=env_int("MODEL_EMBEDDING_FALLBACK_DIMENSION", env_int("MODEL_EMBEDDING_PRIMARY_DIMENSION", settings.EMBEDDING_DIMENSION)),
                vector_space_id=env_value("MODEL_EMBEDDING_FALLBACK_VECTOR_SPACE") or None,
                supports_dimensions=env_bool("MODEL_EMBEDDING_FALLBACK_SUPPORTS_DIMENSIONS", False),
                timeout=settings.EMBEDDING_TIMEOUT,
                max_retries=2,
                enabled=env_bool("MODEL_EMBEDDING_FALLBACK_ENABLED", False),
            ),
            ProviderEndpointConfig(
                name="local_fallback",
                type="local_hf",
                model=settings.LOCAL_EMBEDDING_MODEL,
                dimension=512,
                timeout=30,
                max_retries=1,
                enabled=False,
                vector_space_id=None,
                health_check=HealthCheckConfig(enabled=False),
            ),
        ]

        vision_providers = [
            ProviderEndpointConfig(
                name="primary",
                type="openai",
                model=env_value("MODEL_VISION_PRIMARY_MODEL", settings.VISION_MODEL_NAME),
                api_key=env_value("MODEL_VISION_PRIMARY_API_KEY", aliyun_api_key),
                api_base=env_value("MODEL_VISION_PRIMARY_API_URL", aliyun_api_base),
                timeout=30,
                max_retries=2,
                max_tokens=500,
                temperature=0.3,
                enabled=env_bool("MODEL_VISION_PRIMARY_ENABLED", settings.ENABLE_VISION),
            ),
            ProviderEndpointConfig(
                name="fallback",
                type="openai",
                model=env_value("MODEL_VISION_FALLBACK_MODEL"),
                api_key=env_value("MODEL_VISION_FALLBACK_API_KEY"),
                api_base=env_value("MODEL_VISION_FALLBACK_API_URL"),
                timeout=30,
                max_retries=1,
                max_tokens=500,
                temperature=0.3,
                enabled=env_bool("MODEL_VISION_FALLBACK_ENABLED", False),
            ),
        ]

        reranker_providers = [
            ProviderEndpointConfig(
                name="primary", type="dashscope_rerank",
                model=env_value("MODEL_RERANK_PRIMARY_MODEL", default="qwen3.7-text-rerank"),
                api_key=env_value("MODEL_RERANK_PRIMARY_API_KEY", aliyun_api_key),
                api_base=env_value("MODEL_RERANK_PRIMARY_API_URL", aliyun_api_base),
                enabled=env_bool("MODEL_RERANK_PRIMARY_ENABLED", True),
                timeout=8, max_retries=0, health_check=HealthCheckConfig(enabled=False),
            ),
            ProviderEndpointConfig(
                name="fallback", type="dashscope_rerank",
                model=env_value("MODEL_RERANK_FALLBACK_MODEL"),
                api_key=env_value("MODEL_RERANK_FALLBACK_API_KEY"),
                api_base=env_value("MODEL_RERANK_FALLBACK_API_URL"),
                enabled=env_bool("MODEL_RERANK_FALLBACK_ENABLED", False),
                timeout=8, max_retries=0, health_check=HealthCheckConfig(enabled=False),
            ),
        ]
        image_generation_providers = [
            ProviderEndpointConfig(
                name="primary", type="openai_images",
                model=env_value("MODEL_IMAGE_GENERATION_PRIMARY_MODEL"),
                api_key=env_value("MODEL_IMAGE_GENERATION_PRIMARY_API_KEY"),
                api_base=env_value("MODEL_IMAGE_GENERATION_PRIMARY_API_URL"),
                enabled=env_bool("MODEL_IMAGE_GENERATION_PRIMARY_ENABLED", False),
                timeout=60, max_retries=0, health_check=HealthCheckConfig(enabled=False),
            ),
            ProviderEndpointConfig(
                name="fallback", type="openai_images",
                model=env_value("MODEL_IMAGE_GENERATION_FALLBACK_MODEL"),
                api_key=env_value("MODEL_IMAGE_GENERATION_FALLBACK_API_KEY"),
                api_base=env_value("MODEL_IMAGE_GENERATION_FALLBACK_API_URL"),
                enabled=env_bool("MODEL_IMAGE_GENERATION_FALLBACK_ENABLED", False),
                timeout=60, max_retries=0, health_check=HealthCheckConfig(enabled=False),
            ),
        ]

        config = ModelProviderConfig(
            providers={
                "llm": llm_providers,
                "embedding": embedding_providers,
                "vision": vision_providers,
                "reranker": reranker_providers,
                "image_generation": image_generation_providers,
            }
        )
        _ensure_primary_embedding_space_id(config)
        _disable_incompatible_embedding_fallbacks(config)
        return config


def _ensure_primary_embedding_space_id(config: ModelProviderConfig) -> None:
    endpoints = config.providers.get("embedding", [])
    if endpoints and not (endpoints[0].vector_space_id or "").strip():
        primary = endpoints[0]
        primary.vector_space_id = f"model:{primary.model}:{primary.dimension or ''}"


def _disable_incompatible_embedding_fallbacks(config: ModelProviderConfig) -> None:
    """Never fail over into a different vector space or dimension."""
    endpoints = config.providers.get("embedding", [])
    if not endpoints:
        return
    primary = endpoints[0]
    for endpoint in endpoints[1:]:
        if not endpoint.enabled:
            continue
        compatible = (
            endpoint.dimension == primary.dimension
            and bool(primary.vector_space_id)
            and bool(endpoint.vector_space_id)
            and endpoint.vector_space_id == primary.vector_space_id
        )
        if not compatible:
            endpoint.enabled = False
            logger.error(
                "Embedding fallback disabled: incompatible vector space or dimension (%s)",
                endpoint.name,
            )
