"""
OpenAI 兼容文本客户端

作用：
    封装 LangChain ChatOpenAI，提供带重试+熔断+超时+首字超时的文本模型调用。
    兼容 OpenAI / 智谱 / 通义千问 / Ollama(OpenAI模式) / vLLM 等 OpenAI 兼容 API。

容错机制：
    1. 重试（tenacity 指数退避）：仅对瞬时错误重试
    2. 熔断器（Redis）：服务级保护，连续失败达阈值后快速失败
    3. 超时控制：非流式总超时 + 流式首字超时
    4. Token 提取：从响应中提取输入/输出 Token 用量

使用方式：
    client = OpenAITextClient(config)
    answer = client.invoke(messages)
    async for chunk in client.astream(messages):
        print(chunk)
"""

import asyncio
import logging
from typing import AsyncGenerator, List, Optional

from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI
import httpx
from app.core.model_text_stream import read_text_response
from tenacity import (
    Retrying,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception,
)

from app.core.circuit_breaker import CircuitBreakerOpenError
from app.core.model_provider.base import TextModelClient
from app.core.model_provider.clients._retry_utils import (
    StreamTimeoutError,
    extract_token_usage,
    is_retryable,
)
from app.core.model_provider.exceptions import ModelInvocationError
from app.core.model_provider.schemas import ProviderEndpointConfig

logger = logging.getLogger(__name__)


class OpenAITextClient(TextModelClient):
    """
    OpenAI 兼容文本客户端

    作用：
        封装 ChatOpenAI，提供 invoke/astream 接口。
        内置 tenacity 重试 + 熔断器 + 超时控制。

    容错链路（非流式）：
        1. 检查熔断器 → 打开则快速失败
        2. 带重试地调用主模型（指数退避，最多 max_retries 次）
        3. 重试耗尽 → 抛 ModelInvocationError（由上层决定是否降级）

    容错链路（流式）：
        1. 检查熔断器
        2. 带重试地建立流并获取首字（首字超时）
        3. 首字成功后不再重试，直接消费剩余流
    """

    def __init__(self, config: ProviderEndpointConfig):
        """
        初始化 OpenAI 文本客户端

        作用：
            创建非流式和流式两个 ChatOpenAI 实例（LangChain 通过 streaming 参数控制）。

        参数：
            config: ProviderEndpointConfig - 端点配置
        """
        super().__init__(config)

        common_kwargs = dict(
            openai_api_key=config.api_key,
            openai_api_base=config.api_base,
            temperature=config.temperature,
        )

        # 非流式实例（设总超时）
        self._invoke_llm = ChatOpenAI(
            model=config.model,
            streaming=False,
            request_timeout=config.timeout,
            **common_kwargs,
        )
        # 流式实例（不设总超时，用首字超时控制）
        self._stream_llm = ChatOpenAI(
            model=config.model,
            streaming=True,
            **common_kwargs,
        )
        # Tool tasks have their own round budget; SDK retries must not silently
        # repeat a planning request or alter the ordinary knowledge model.
        self._tools_llm = ChatOpenAI(
            model=config.model, streaming=False, request_timeout=config.timeout,
            max_retries=0, **common_kwargs,
        )

        # Token 用量追踪（最近一次调用）
        # 作用：供上层读取，统计成本
        self._last_token_input = 0
        self._last_token_output = 0
        # 重试次数追踪（最近一次调用）
        # 作用：供 LLMResilienceService 适配层读取，更新 last_metrics
        self._last_retry_count = 0

    @property
    def last_token_input(self) -> int:
        """最近一次调用的输入 Token 数"""
        return self._last_token_input

    async def acomplete_tools(self, messages: list[dict], tools: list[dict]):
        """Request-scoped binding; no mutation of the shared knowledge model."""
        if self.breaker.is_open():
            raise CircuitBreakerOpenError(self.breaker.service, self.breaker.get_retry_after())
        try:
            result = await self._tools_llm.bind_tools(tools, tool_choice="auto").ainvoke(messages)
            self.breaker.record_success()
            return result
        except Exception as error:
            if is_retryable(error):
                self.breaker.record_failure()
            raise

    async def astream_workbench(self, messages: list[dict], completion: dict):
        """Strict text transport, retaining terminal proof lost by SDK text chunks.

        Uses this selected provider's model/key/temperature without mutating KB
        clients or silently retrying a partially consumed answer.
        """
        if self.breaker.is_open():
            raise CircuitBreakerOpenError(self.breaker.service, self.breaker.get_retry_after())
        try:
            async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=httpx.Timeout(90, connect=10)) as client:
                async with client.stream("POST", self.config.api_base.rstrip("/") + "/chat/completions",
                                         headers={"Authorization": "Bearer " + self.config.api_key},
                                         json={"model": self.config.model, "messages": messages, "stream": True,
                                               "temperature": self.config.temperature}) as response:
                    response.raise_for_status()
                    async for text in read_text_response(response, completion):
                        yield text
            self.breaker.record_success()
        except Exception:
            self.breaker.record_failure()
            # No raw provider errors or headers enter logging/monitoring.
            raise ValueError("Workbench model stream failed") from None

    @property
    def last_token_output(self) -> int:
        """最近一次调用的输出 Token 数"""
        return self._last_token_output

    @property
    def last_retry_count(self) -> int:
        """最近一次调用的重试次数（不含首次尝试）"""
        return self._last_retry_count

    def close(self):
        """
        释放资源

        作用：
            ChatOpenAI 无显式资源需释放，保留接口以满足基类契约。
        """
        pass

    # ============================================
    # 非流式调用
    # ============================================

    def invoke(self, messages: List[BaseMessage]) -> str:
        """
        非流式调用 LLM（带重试+熔断）

        作用：
            同步调用 LLM 生成完整回答，内置容错链路。

        容错流程：
            1. 熔断器检查 → 打开则抛 CircuitBreakerOpenError
            2. 主模型重试（指数退避，最多 max_retries 次）
            3. 重试耗尽 → 抛 ModelInvocationError

        参数：
            messages: List[BaseMessage] - LangChain 消息列表

        返回:
            str - LLM 生成的完整文本

        异常:
            CircuitBreakerOpenError - 熔断器打开
            ModelInvocationError - 调用失败（重试耗尽）
        """
        self._last_token_input = 0
        self._last_token_output = 0
        self._last_retry_count = 0

        # 1. 熔断器检查
        if self.breaker.is_open():
            raise CircuitBreakerOpenError(
                self.breaker.service, self.breaker.get_retry_after()
            )

        # 2. 带重试地调用
        retry_counter = {"count": 0}

        def _count_retry(retry_state):
            retry_counter["count"] += 1

        retryer = Retrying(
            stop=stop_after_attempt(self.config.max_retries + 1),
            wait=wait_exponential(
                multiplier=self.config.retry_base_delay,
                min=self.config.retry_base_delay,
                max=60,
            ),
            retry=retry_if_exception(is_retryable),
            before_sleep=_count_retry,
            reraise=True,
        )

        try:
            result = retryer(self._invoke_once, messages)
            return result
        except CircuitBreakerOpenError:
            raise
        except Exception as e:
            if not is_retryable(e):
                # 不可重试错误（如 4xx），不额外记录熔断（_invoke_once 已处理）
                raise ModelInvocationError(
                    f"[{self.name}] LLM 调用失败（不可重试）: {type(e).__name__}: {e}",
                    provider_name=self.name,
                    original_exc=e,
                ) from e
            # 可重试错误重试耗尽
            logger.warning(
                f"[{self.name}] LLM 调用重试 {retry_counter['count']} 次后仍失败: "
                f"{type(e).__name__}: {e}"
            )
            raise ModelInvocationError(
                f"[{self.name}] LLM 调用失败（重试 {retry_counter['count']} 次后耗尽）: "
                f"{type(e).__name__}: {e}",
                provider_name=self.name,
                original_exc=e,
            ) from e
        finally:
            # 无论成功失败，都记录本次重试次数
            # 作用：供 LLMResilienceService 适配层读取，更新 last_metrics
            self._last_retry_count = retry_counter["count"]

    def _invoke_once(self, messages: List[BaseMessage]) -> str:
        """
        单次 LLM 调用（带熔断器集成+Token 提取）

        作用：
            执行一次 LLM 调用，前后更新熔断器状态，成功时提取 Token 用量。

        参数：
            messages: List[BaseMessage] - 消息列表

        返回:
            str - LLM 生成的文本
        """
        # 重试期间熔断器可能被其他请求打开，再次检查
        if self.breaker.is_open():
            raise CircuitBreakerOpenError(
                self.breaker.service, self.breaker.get_retry_after()
            )

        try:
            result = self._invoke_llm.invoke(messages)
            self.breaker.record_success()
            # 提取 Token 用量
            in_tok, out_tok = extract_token_usage(result)
            self._last_token_input += in_tok
            self._last_token_output += out_tok
            return result.content if hasattr(result, "content") else str(result)
        except Exception as e:
            if is_retryable(e):
                self.breaker.record_failure()
            raise

    # ============================================
    # 流式调用
    # ============================================

    async def astream(self, messages: List[BaseMessage]) -> AsyncGenerator[str, None]:
        """
        流式调用 LLM（带重试+熔断+首字超时）

        作用：
            异步流式生成回答，逐块 yield 文本。
            重试只发生在"建立连接+首字"阶段；一旦开始流式输出，即使中途出错也不重试。

        容错流程：
            1. 熔断器检查
            2. 带重试地建立流并获取首字（首字超时）
            3. 首字成功后直接消费剩余流

        参数：
            messages: List[BaseMessage] - 消息列表

        返回:
            AsyncGenerator[str, None] - 文本块生成器

        异常:
            CircuitBreakerOpenError - 熔断器打开
            ModelInvocationError - 调用失败
        """
        self._last_token_input = 0
        self._last_token_output = 0
        self._last_retry_count = 0

        # 1. 熔断器检查
        if self.breaker.is_open():
            raise CircuitBreakerOpenError(
                self.breaker.service, self.breaker.get_retry_after()
            )

        # 2. 带重试地获取首字 + 流
        first_chunk, stream_agen = await self._astream_first_with_retry(messages)

        # 3. 首字成功，消费剩余流
        try:
            if first_chunk is not None:
                yield first_chunk
            async for chunk in stream_agen:
                yield chunk.content if hasattr(chunk, "content") else str(chunk)
        finally:
            pass

    async def _astream_first_with_retry(
        self,
        messages: List[BaseMessage],
    ) -> tuple:
        """
        带重试地建立流并获取首字

        作用：
            流式调用的核心容错环节：重试只覆盖"建立连接+首字"阶段。
            成功后返回 (首字, 流生成器)，由调用方继续消费。

        参数：
            messages: List[BaseMessage] - 消息列表

        返回:
            tuple - (first_chunk: Optional[str], stream_agen: AsyncGenerator)
            first_chunk 为 None 表示流为空（LLM 返回空内容）

        异常:
            CircuitBreakerOpenError - 熔断器打开
            ModelInvocationError - 重试耗尽
        """
        last_exc: Optional[Exception] = None
        max_attempts = self.config.max_retries + 1
        retry_count = 0

        for attempt in range(1, max_attempts + 1):
            stream_agen = None
            try:
                # 熔断检查
                if self.breaker.is_open():
                    raise CircuitBreakerOpenError(
                        self.breaker.service, self.breaker.get_retry_after()
                    )

                # 建立流
                stream_agen = self._stream_llm.astream(messages).__aiter__()

                # 等待首字（带超时）
                try:
                    first_chunk = await asyncio.wait_for(
                        stream_agen.__anext__(),
                        timeout=self.config.stream_first_token_timeout,
                    )
                except asyncio.TimeoutError:
                    raise StreamTimeoutError(
                        f"流式首字超时（{self.config.stream_first_token_timeout}s 未收到响应）"
                    )
                except StopAsyncIteration:
                    # 空流：LLM 返回空内容，视为成功
                    self.breaker.record_success()
                    self._last_retry_count = retry_count
                    return (None, _empty_async_gen())

                # 首字获取成功
                self.breaker.record_success()
                first_text = (
                    first_chunk.content
                    if hasattr(first_chunk, "content")
                    else str(first_chunk)
                )
                self._last_retry_count = retry_count
                return (first_text, stream_agen)

            except CircuitBreakerOpenError:
                if stream_agen is not None:
                    await stream_agen.aclose()
                raise
            except Exception as e:
                last_exc = e
                # 清理未完成的流
                if stream_agen is not None:
                    try:
                        await stream_agen.aclose()
                    except Exception:
                        pass
                # 仅可重试错误计入熔断器
                if is_retryable(e):
                    self.breaker.record_failure()

                # 不可重试或已耗尽：跳出
                if not is_retryable(e) or attempt >= max_attempts:
                    break

                # 即将重试
                retry_count += 1
                delay = min(self.config.retry_base_delay * (2 ** (attempt - 1)), 60)
                logger.warning(
                    f"[{self.name}] 流式第{attempt}/{max_attempts}次失败: "
                    f"{type(e).__name__}: {e}，{delay:.1f}s 后重试"
                )
                await asyncio.sleep(delay)

        # 重试耗尽
        self._last_retry_count = retry_count
        raise ModelInvocationError(
            f"[{self.name}] LLM 流式调用失败（重试 {retry_count} 次后耗尽）: "
            f"{type(last_exc).__name__}: {last_exc}",
            provider_name=self.name,
            original_exc=last_exc,
        ) from last_exc


async def _empty_async_gen() -> AsyncGenerator[str, None]:
    """
    空异步生成器

    作用：
        当 LLM 返回空流时，返回一个空的异步生成器保持接口一致。
    """
    return
    yield  # 使其成为 async generator（不会被实际执行到）
