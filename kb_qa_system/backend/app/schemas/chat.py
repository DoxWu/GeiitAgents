"""
对话相关 Schema

作用：
    定义对话和问答相关的请求和响应数据模型。
"""

from datetime import datetime
from typing import Optional, List, Any, Literal
from pydantic import BaseModel, Field, ConfigDict, field_validator


class QuestionRequest(BaseModel):
    """
    提问请求 Schema

    作用：
        定义用户提问的请求体格式。

    使用场景：
        POST /api/v1/chat/ask
        POST /api/v1/chat/ask/stream

    示例请求体：
        {
            "question": "如何使用异步编程？",
            "conversation_id": 123,
            "stream": true,
            "idempotency_key": "req-abc-123"
        }
    """
    rerank_mode: Literal["current", "qwen3.7-text-rerank"] = "current"
    question: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="问题内容"
    )
    # L-5 修复：conversation_id 添加 ge=1 正整数校验，防止 0/负数 ID 触发异常查询
    conversation_id: Optional[int] = Field(
        None,
        ge=1,
        description="会话ID，不填则创建新会话（正整数）"
    )
    stream: bool = Field(
        False,
        description="是否使用流式响应"
    )
    # 幂等性键（可选）
    # 作用：防止前端重复提交（如网络抖动、用户连点）导致重复调用 LLM
    # 实现：相同 idempotency_key 的重复请求返回首次结果（非流式）或拒绝（流式）
    # 约束：长度 1-100，仅含字母数字及 - _ 字符
    idempotency_key: Optional[str] = Field(
        None,
        max_length=100,
        description="幂等性键，防止重复提交。相同 key 的重复请求返回首次结果（非流式）或返回 409（流式正在处理）"
    )

    @field_validator("question")
    @classmethod
    def validate_question_not_blank(cls, v: str) -> str:
        """
        校验问题内容不能为纯空白

        作用：
            原实现仅校验 min_length=1，允许 "   " 等纯空白通过，
            导致 LLM 收到空问题产生无意义回答。
            修复：去除首尾空白后校验非空，并返回去除空白后的内容。

        参数：
            v: str - 原始问题字符串

        返回:
            str - 去除首尾空白后的字符串

        异常:
            ValueError - 去除空白后为空时抛出
        """
        stripped = v.strip()
        if not stripped:
            raise ValueError("问题内容不能为空白")
        return stripped

    @field_validator("idempotency_key")
    @classmethod
    def validate_idempotency_key(cls, v: Optional[str]) -> Optional[str]:
        """
        校验幂等性键格式

        作用：
            限制 idempotency_key 仅含字母、数字、连字符、下划线，
            防止注入攻击或异常字符导致 Redis key 异常。

        参数：
            v: Optional[str] - 幂等性键

        返回:
            Optional[str] - 校验后的幂等性键

        异常:
            ValueError - 格式不合法时抛出
        """
        if v is None:
            return v
        import re
        if not re.match(r"^[a-zA-Z0-9_\-]{1,100}$", v):
            raise ValueError("idempotency_key 仅支持字母、数字、下划线和连字符，长度 1-100")
        return v


class RegenerateRequest(BaseModel):
    """
    重新生成请求 Schema

    作用：
        定义重新生成 AI 回答的请求体格式。

    使用场景：
        POST /api/v1/chat/regenerate/stream

    实现方式：
        接收 conversation_id（必填）和可选 message_id（要重新生成的 assistant 消息 ID），
        后端查找该消息前最近的 user 消息，删除原 assistant 消息后重新生成。

    示例请求体：
        {
            "conversation_id": 123,
            "message_id": 456,
            "idempotency_key": "req-abc-123"
        }
    """
    rerank_mode: Literal["current", "qwen3.7-text-rerank"] = "current"
    # L-5 修复：conversation_id 添加 ge=1 正整数校验
    conversation_id: int = Field(
        ...,
        ge=1,
        description="会话ID（正整数，必填）"
    )
    # 要重新生成的 assistant 消息 ID（可选，不填则默认重新生成最后一条 assistant 消息）
    message_id: Optional[int] = Field(
        None,
        ge=1,
        description="要重新生成的 AI 消息ID（不填则默认重新生成最后一条 AI 消息）"
    )
    # 幂等性键（可选，防止重复提交）
    idempotency_key: Optional[str] = Field(
        None,
        max_length=100,
        description="幂等性键，防止重复提交"
    )

    @field_validator("idempotency_key")
    @classmethod
    def validate_idempotency_key(cls, v: Optional[str]) -> Optional[str]:
        """校验幂等性键格式（同 QuestionRequest）"""
        if v is None:
            return v
        import re
        if not re.match(r"^[a-zA-Z0-9_\-]{1,100}$", v):
            raise ValueError("idempotency_key 仅支持字母、数字、下划线和连字符，长度 1-100")
        return v


class SourceItem(BaseModel):
    """
    引用来源项 Schema

    作用：
        定义单个引用来源的数据格式。
    """
    document_id: Optional[int] = None
    title: str
    content: str
    score: float = Field(..., description="相关度分数（0-1）")


class AnswerResponse(BaseModel):
    """
    回答响应 Schema（非流式）

    作用：
        定义非流式问答的响应格式。

    示例响应：
        {
            "answer": "异步编程是一种...",
            "sources": [...],
            "conversation_id": 123,
            "message_id": 456,
            "degraded": false,
            "degrade_reason": null
        }

    字段说明：
        degraded: 是否走了降级兜底（LLM 熔断/不可用时为 true）
        degrade_reason: 降级原因（circuit_open/llm_unavailable/unknown_error）
    """
    answer: str
    sources: List[SourceItem] = []
    conversation_id: int
    message_id: Optional[int] = None
    degraded: bool = Field(False, description="是否降级兜底回复")
    degrade_reason: Optional[str] = Field(None, description="降级原因")


class MessageResponse(BaseModel):
    """
    消息响应 Schema

    作用：
        定义单条消息的响应格式。

    示例响应：
        {
            "id": 1,
            "role": "user",
            "content": "如何使用异步编程？",
            "sources": null,
            "created_at": "2026-07-05T10:00:00"
        }
    """
    id: int
    role: str
    content: str
    sources: Optional[List[Any]] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ConversationResponse(BaseModel):
    """
    对话响应 Schema

    作用：
        定义对话的响应格式。

    示例响应：
        {
            "id": 1,
            "title": "Python异步编程",
            "is_active": true,
            "created_at": "2026-07-05T10:00:00",
            "messages": [...]
        }
    """
    id: int
    title: str
    is_active: bool
    created_at: datetime
    updated_at: datetime
    messages: List[MessageResponse] = []

    model_config = ConfigDict(from_attributes=True)


class ConversationListResponse(BaseModel):
    """
    对话列表响应 Schema

    作用：
        定义对话列表的响应格式。
    """
    items: List[ConversationResponse]
    total: int
    # M-7 修复：新增分页字段，支持前端分页加载
    page: int = Field(default=1, description="当前页码")
    page_size: int = Field(default=20, description="每页数量")
    # D4-02 游标分页：传入 cursor 参数时返回 next_cursor，旧客户端可忽略此字段
    next_cursor: Optional[int] = Field(
        None, description="下一页游标（传入 cursor 参数时返回，无更多数据时为 null）"
    )
