"""
模型客户端公共重试工具

作用：
    从 llm_resilience.py 提取的可重试异常判定和 Token 提取逻辑，
    供所有 OpenAI 兼容客户端复用，确保行为一致。

提取原因：
    原先 _is_retryable 和 _extract_token_usage 硬编码在 llm_resilience.py 中，
    新的 OpenAITextClient / OpenAIEmbeddingClient / OpenAIVisionClient 都需要相同的逻辑。
    提取为公共函数避免代码重复和行为漂移。
"""

from typing import Any, Tuple
from app.core.model_provider.diagnostics import safe_error_label


def is_retryable(exc: BaseException) -> bool:
    """
    判断异常是否值得重试（瞬时错误）

    作用：
        tenacity 重试判定谓词。只有瞬时错误（网络抖动、超时、限流、服务端临时故障）
        才值得重试；客户端错误（4xx，如参数错误、鉴权失败）和熔断打开错误不重试。

    判定规则：
        - CircuitBreakerOpenError：不重试（主动熔断信号）
        - openai.APITimeoutError / APIConnectionError / RateLimitError / InternalServerError：重试
        - openai.APIStatusError 且 status_code >= 500：重试
        - 通用 TimeoutError / ConnectionError / OSError：重试
        - httpx.TimeoutException：重试
        - 其他：不重试

    参数：
        exc: BaseException - 捕获到的异常

    返回:
        bool - True 表示可重试，False 表示不可重试
    """
    # 延迟导入避免循环依赖
    from app.core.circuit_breaker import CircuitBreakerOpenError

    # 熔断器打开：不重试（这是主动快速失败信号）
    if isinstance(exc, CircuitBreakerOpenError):
        return False

    # openai SDK 异常
    try:
        import openai
        if isinstance(exc, (
            openai.APITimeoutError,
            openai.APIConnectionError,
            openai.RateLimitError,
            openai.InternalServerError,
        )):
            return True
        # 5xx 服务端错误：可重试
        if isinstance(exc, openai.APIStatusError) and getattr(exc, "status_code", 0) >= 500:
            return True
    except ImportError:
        pass

    # 通用网络/超时异常
    if isinstance(exc, (TimeoutError, ConnectionError, OSError)):
        return True

    # httpx 超时
    try:
        import httpx
        if isinstance(exc, httpx.TimeoutException):
            return True
    except ImportError:
        pass

    return False


def extract_token_usage(result: Any) -> Tuple[int, int]:
    """
    从 LLM 响应中提取 Token 用量

    作用：
        解析 LangChain AIMessage 中的 usage_metadata / response_metadata，
        提取输入/输出 Token 数，用于成本统计。

    实现方式：
        1. 优先读 usage_metadata（LangChain 0.3+ 标准）
        2. 回退到 response_metadata.token_usage（OpenAI 原始格式）
        3. 都没有则返回 (0, 0)

    参数：
        result: Any - LLM 返回的 AIMessage 对象

    返回:
        Tuple[int, int] - (input_tokens, output_tokens)
    """
    try:
        # LangChain 0.3+ 标准 usage_metadata
        usage = getattr(result, "usage_metadata", None)
        if usage:
            return (
                int(usage.get("input_tokens", 0)),
                int(usage.get("output_tokens", 0)),
            )
        # OpenAI 原始格式 response_metadata.token_usage
        resp_meta = getattr(result, "response_metadata", None)
        if resp_meta:
            token_usage = resp_meta.get("token_usage", {})
            return (
                int(token_usage.get("prompt_tokens", 0)),
                int(token_usage.get("completion_tokens", 0)),
            )
    except Exception:
        pass
    return 0, 0


class StreamTimeoutError(Exception):
    """
    流式首字超时异常

    作用：
        流式调用在 stream_first_token_timeout 内未收到任何 chunk 时抛出。
        可重试，重试耗尽后降级为非流式。
    """
