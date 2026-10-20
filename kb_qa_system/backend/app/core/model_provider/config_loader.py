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
        if env_value is not None:
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

        aliyun_api_key = settings.ALIYUN_API_KEY or settings.OPENAI_API_KEY
        aliyun_api_base = settings.ALIYUN_API_BASE or settings.OPENAI_API_BASE
        aliyun_llm_model = settings.ALIYUN_LLM_MODEL or settings.LLM_MODEL_NAME
        aliyun_embedding_model = settings.ALIYUN_EMBEDDING_MODEL or settings.EMBEDDING_MODEL_NAME
        deepseek_enabled = settings.DEEPSEEK_LLM_ENABLED or settings.LLM_FALLBACK_ENABLED

        llm_providers = [
            ProviderEndpointConfig(
                name="primary",
                type="openai",
                model=aliyun_llm_model,
                api_key=aliyun_api_key,
                api_base=aliyun_api_base,
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
                model=settings.DEEPSEEK_LLM_MODEL or settings.LLM_FALLBACK_MODEL_NAME,
                api_key=settings.DEEPSEEK_API_KEY or settings.LLM_FALLBACK_API_KEY or settings.OPENAI_API_KEY,
                api_base=settings.DEEPSEEK_API_BASE or settings.LLM_FALLBACK_API_BASE or settings.OPENAI_API_BASE,
                temperature=0.1,
                timeout=settings.LLM_TIMEOUT,
                max_retries=1,
                enabled=deepseek_enabled,
            ),
        ]

        embedding_providers = [
            ProviderEndpointConfig(
                name="primary",
                type="openai",
                model=aliyun_embedding_model,
                api_key=aliyun_api_key,
                api_base=aliyun_api_base,
                dimension=settings.EMBEDDING_DIMENSION,
                timeout=settings.EMBEDDING_TIMEOUT,
                max_retries=2,
                enabled=True,
            ),
            ProviderEndpointConfig(
                name="local_fallback",
                type="local_hf",
                model=settings.LOCAL_EMBEDDING_MODEL,
                dimension=512,
                timeout=30,
                max_retries=1,
                enabled=False,
                health_check=HealthCheckConfig(enabled=False),
            ),
        ]

        vision_providers = [
            ProviderEndpointConfig(
                name="primary",
                type="openai",
                model=settings.VISION_MODEL_NAME,
                api_key=aliyun_api_key,
                api_base=aliyun_api_base,
                timeout=30,
                max_retries=2,
                max_tokens=500,
                temperature=0.3,
                enabled=settings.ENABLE_VISION,
            ),
        ]

        return ModelProviderConfig(
            providers={
                "llm": llm_providers,
                "embedding": embedding_providers,
                "vision": vision_providers,
            }
        )
