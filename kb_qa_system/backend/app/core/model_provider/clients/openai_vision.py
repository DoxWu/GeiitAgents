"""
OpenAI 兼容 Vision 客户端

作用：
    封装 openai.OpenAI SDK，提供带重试+熔断+超时的多模态图片描述。
    修复现有 image_processor.py 无任何容错的问题。

容错机制：
    1. 重试（tenacity 指数退避）：仅对瞬时错误重试
    2. 熔断器（Redis）：服务级保护
    3. 超时控制：OpenAI 客户端内置 timeout
    4. 优雅降级：失败返回空字符串（保持现有 ImageProcessor 行为兼容）

使用方式：
    client = OpenAIVisionClient(config)
    description = client.describe_image("/path/to/image.png")
"""

import base64
import logging
import os
from typing import Optional

from tenacity import (
    Retrying,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception,
)

from app.core.circuit_breaker import CircuitBreakerOpenError
from app.core.model_provider.base import VisionModelClient
from app.core.model_provider.clients._retry_utils import is_retryable
from app.core.model_provider.diagnostics import safe_error_label
from app.core.model_provider.exceptions import ModelInvocationError
from app.core.model_provider.schemas import ProviderEndpointConfig

logger = logging.getLogger(__name__)

# 默认多模态描述 Prompt
# 作用：引导模型生成对检索友好的图片描述
_DEFAULT_VISION_PROMPT = (
    "请详细描述这张图片的内容，重点关注：\n"
    "1. 图片类型（流程图/图表/示意图/截图/照片等）\n"
    "2. 主要元素和结构\n"
    "3. 文字内容（如有）\n"
    "4. 图片传达的核心信息\n"
    "请用简洁的中文回答，便于检索。"
)

# 图片扩展名 → MIME 类型映射
_MIME_MAP = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}


class OpenAIVisionClient(VisionModelClient):
    """
    OpenAI 兼容 Vision 客户端

    作用：
        封装 openai.OpenAI，提供 describe_image 接口。
        新增 tenacity 重试 + 熔断器 + 超时控制（修复现有 Vision 裸奔问题）。

    容错流程：
        1. 熔断器检查 → 打开则返回空字符串
        2. 带重试地调用 Vision API（指数退避）
        3. 成功 → record_success + 返回描述
        4. 重试耗尽 → record_failure + 返回空字符串（优雅降级）
    """

    def __init__(self, config: ProviderEndpointConfig):
        """
        初始化 OpenAI Vision 客户端

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
            首次调用时创建 openai.OpenAI 客户端，复用避免重复创建。
        """
        if self._client is not None:
            return self._client

        try:
            from openai import OpenAI
            self._client = OpenAI(
                api_key=self.config.api_key,
                base_url=self.config.api_base,
                timeout=self.config.timeout,
            )
            logger.info(f"[{self.model_type}:{self.name}] Vision 客户端已初始化")
        except Exception as e:
            logger.warning(
                f"[{self.model_type}:{self.name}] Vision 客户端初始化失败: {safe_error_label(e)}"
            )
            self._client = None

        return self._client

    def describe_image(self, image_path: str, prompt: Optional[str] = None) -> str:
        """
        描述图片内容（带重试+熔断+超时）

        作用：
            调用多模态模型生成图片描述。
            失败时返回空字符串（保持现有 ImageProcessor 行为兼容）。

        容错流程：
            1. 检查客户端是否可用 → 不可用返回空字符串
            2. 熔断器检查 → 打开返回空字符串
            3. 带重试地调用 Vision API
            4. 成功 → 返回描述文本
            5. 重试耗尽 → 返回空字符串

        参数：
            image_path: str - 图片文件路径
            prompt: Optional[str] - 自定义提示词，None 用默认

        返回:
            str - 图片描述（失败返回空字符串）
        """
        client = self.client
        if client is None:
            return ""

        # 熔断器检查
        if self.breaker.is_open():
            logger.debug(f"[{self.model_type}:{self.name}] 熔断器打开，跳过 Vision 调用")
            return ""

        # 准备图片数据
        try:
            with open(image_path, "rb") as f:
                image_data = base64.b64encode(f.read()).decode("utf-8")

            ext = os.path.splitext(image_path)[1].lower().lstrip(".")
            mime_type = _MIME_MAP.get(ext, "image/png")
        except Exception as e:
            logger.debug(
                f"[{self.model_type}:{self.name}] 读取图片失败: {safe_error_label(e)}"
            )
            return ""

        vision_prompt = prompt or _DEFAULT_VISION_PROMPT
        max_tokens = self.config.max_tokens or 500
        temperature = self.config.temperature

        # 带重试地调用
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
            result = retryer(
                self._call_vision_once,
                client=client,
                image_data=image_data,
                mime_type=mime_type,
                prompt=vision_prompt,
                max_tokens=max_tokens,
                temperature=temperature,
            )
            return result
        except CircuitBreakerOpenError:
            return ""
        except Exception as e:
            if is_retryable(e):
                self.breaker.record_failure()
            logger.debug(
                f"[{self.model_type}:{self.name}] 多模态描述失败"
                f"（重试 {retry_counter['count']} 次）: {safe_error_label(e)}"
            )
            return ""

    def _call_vision_once(
        self,
        *,
        client,
        image_data: str,
        mime_type: str,
        prompt: str,
        max_tokens: int,
        temperature: float,
    ) -> str:
        """
        单次 Vision API 调用（带熔断器集成）

        作用：
            执行一次多模态调用，前后更新熔断器状态。

        参数：
            client: OpenAI 客户端实例
            image_data: str - base64 编码的图片数据
            mime_type: str - 图片 MIME 类型
            prompt: str - 提示词
            max_tokens: int - 最大输出 token
            temperature: float - 采样温度

        返回:
            str - 图片描述
        """
        # 重试期间熔断器可能被打开
        if self.breaker.is_open():
            raise CircuitBreakerOpenError(
                self.breaker.service, self.breaker.get_retry_after()
            )

        try:
            response = client.chat.completions.create(
                model=self.config.model,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{mime_type};base64,{image_data}"
                                },
                            },
                        ],
                    }
                ],
                max_tokens=max_tokens,
                temperature=temperature,
            )
            self.breaker.record_success()
            return response.choices[0].message.content.strip()
        except Exception as e:
            if is_retryable(e):
                self.breaker.record_failure()
            raise

    def close(self):
        """
        释放资源

        作用：
            释放 OpenAI 客户端连接。
        """
        self._client = None
