"""
问答事件模型（质量埋点）

作用：
    记录每次问答的全链路数据，用于评估系统效果：
    - 回答成功率、失败率、降级率
    - 检索耗时、LLM 耗时、总耗时
    - 重试次数、超时次数
    - Token 消耗、成本
    - 用户反馈（点赞/点踩）

    这些数据为后续优化提供数据支撑。

实现方式：
    1. 每次 RAG 问答创建一条事件记录
    2. 记录各环节耗时和状态
    3. 支持按时间、用户、模型等维度聚合统计
"""

from datetime import datetime
from typing import Optional, Dict, Any
from sqlalchemy import String, DateTime, Integer, ForeignKey, Text, JSON, Float, func, Index, false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class QAEvent(Base):
    """
    问答事件模型

    作用：
        记录每次问答的完整链路数据，用于质量评估和优化。

    表结构：
        - id: 主键
        - message_id: 关联的消息ID
        - conversation_id: 对话ID
        - user_id: 用户ID
        - question: 问题
        - answer: 回答（可空，失败时为空）
        - status: 状态（success/failed/degraded/timeout）
        - retrieval_count: 检索到的文档数
        - retrieval_top_score: 最高相关度
        - retrieval_time_ms: 检索耗时（毫秒）
        - llm_time_ms: LLM 耗时（毫秒）
        - total_time_ms: 总耗时（毫秒）
        - retry_count: 重试次数
        - token_input: 输入 Token 数
        - token_output: 输出 Token 数
        - model_used: 实际使用的模型
        - degraded: 是否降级
        - degrade_reason: 降级原因
        - user_feedback: 用户反馈（positive/negative/null）
        - error_code: 错误码
        - error_message: 错误信息
        - created_at: 创建时间

    使用场景：
        - 统计回答成功率：status='success' 的比例
        - 统计超时率：status='timeout' 的比例
        - 计算平均重试次数
        - 计算平均耗时
        - 计算准确率（基于用户反馈）
        - Token 消耗和成本分析
    """

    __tablename__ = "qa_events"

    # 主键 ID
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # 关联的消息ID（可空，失败时可能没有消息记录）
    message_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True, index=True
    )

    # 对话ID
    conversation_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True, index=True
    )

    # 用户ID
    user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True, index=True
    )

    # 问题内容
    question: Mapped[str] = mapped_column(Text, nullable=False)

    # 回答内容（可空，失败时为空）
    answer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ============================================
    # 状态信息
    # ============================================

    # 状态：success（成功）/ failed（失败）/ degraded（降级）/ timeout（超时）
    status: Mapped[str] = mapped_column(String(20), nullable=False, index=True)

    # 是否降级
    degraded: Mapped[bool] = mapped_column(default=False, server_default=false())

    # 降级原因
    # 示例："llm_timeout" / "llm_unavailable" / "embedding_failed" / "circuit_breaker_open"
    degrade_reason: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # ============================================
    # 检索指标
    # ============================================

    # 检索到的文档数
    retrieval_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # 最高相关度分数（0-1）
    retrieval_top_score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")

    # 检索耗时（毫秒）
    retrieval_time_ms: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # ============================================
    # LLM 指标
    # ============================================

    # LLM 调用耗时（毫秒）
    llm_time_ms: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # 重试次数
    retry_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # 输入 Token 数
    token_input: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # 输出 Token 数
    token_output: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # 实际使用的模型
    model_used: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # ============================================
    # 总体指标
    # ============================================

    # 总耗时（毫秒）
    total_time_ms: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # ============================================
    # 用户反馈
    # ============================================

    # 用户反馈：positive（点赞）/ negative（点踩）/ null（未反馈）
    user_feedback: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )

    # 反馈文本（用户可附加说明）
    feedback_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ============================================
    # 错误信息
    # ============================================

    # 错误码
    # 示例："LLM_TIMEOUT" / "LLM_RATE_LIMIT" / "EMBEDDING_FAILED" / "NO_CONTEXT"
    error_code: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)

    # 错误详情
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ============================================
    # 时间戳
    # ============================================

    # 创建时间
    created_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, server_default=func.now(), index=True,
        nullable=True,
    )

    # ============================================
    # 索引
    # ============================================

    __table_args__ = (
        # 按状态和时间查询（用于统计报表）
        Index("ix_qa_events_status_created",
              "status", "created_at"),

        # 按用户和时间查询（用于用户级统计）
        Index("ix_qa_events_user_created",
              "user_id", "created_at"),
    )

    def __repr__(self) -> str:
        return (
            f"<QAEvent(id={self.id}, status='{self.status}', "
            f"total_time_ms={self.total_time_ms}, retry_count={self.retry_count})>"
        )
