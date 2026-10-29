"""
对话和消息数据模型（生产版）

作用：
    定义对话表和消息表结构，存储用户的对话历史。
    支持多轮对话、记忆衰退（历史摘要）、对话管理等功能。

实现方式：
    1. Conversation（对话）：一次完整的对话会话
    2. Message（消息）：对话中的每条消息
    3. 一对多关系：一个对话包含多条消息
    4. 新增摘要字段，支持记忆衰退机制
"""

from datetime import datetime
from typing import TYPE_CHECKING, List, Optional
from sqlalchemy import String, DateTime, Text, Integer, ForeignKey, Boolean, JSON, func, Index, false, true
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.user import User


class Conversation(Base):
    """
    对话模型（生产版）

    作用：
        对应数据库 conversations 表，存储对话会话信息。
        一次对话包含多条消息（用户提问+AI回答）。

    表结构：
        - id: 主键
        - title: 对话标题
        - user_id: 用户ID
        - is_active: 是否活跃
        - is_pinned: 是否置顶/收藏
        - summary: 对话历史摘要（记忆衰退机制）
        - summary_turn_count: 摘要涵盖的轮数
        - metadata_: 额外元数据
        - created_at: 创建时间
        - updated_at: 最后更新时间
    """

    __tablename__ = "conversations"

    # 主键 ID
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # 对话标题（默认取第一条消息的前20个字）
    title: Mapped[str] = mapped_column(String(200), default="新对话", server_default="新对话")

    # 用户ID（外键，关联 users 表）
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True
    )

    # 是否活跃（软删除：False 表示已删除）
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())

    # 是否置顶/收藏
    # 作用：用户可收藏重要对话，置顶显示
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false(), index=True)

    # ============================================
    # 记忆衰退机制相关字段
    # ============================================

    # 对话历史摘要
    # 作用：当对话历史超出窗口时，用 LLM 生成摘要，保留关键信息
    # 实现记忆衰退：旧对话压缩为摘要，新对话保留完整内容
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # 摘要涵盖的轮数
    # 作用：记录摘要包含到第几轮，避免重复摘要
    summary_turn_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # 对话总轮数
    # 作用：用于判断是否需要生成摘要
    turn_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # 额外元数据（JSON 格式，存储对话设置等）
    metadata_: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # 创建时间
    created_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime,
        server_default=func.now(),
        nullable=True,
    )

    # 最后更新时间
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
        nullable=True,
    )

    # ============================================
    # 关联关系
    # ============================================

    # 对话包含的消息（一对多）
    # order_by: 按 created_at 排序，保证消息顺序
    messages: Mapped[List["Message"]] = relationship(
        "Message",
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="Message.created_at"
    )

    # 对话所属的用户（多对一）
    user: Mapped["User"] = relationship("User", back_populates="conversations")

    # ============================================
    # 索引
    # ============================================

    __table_args__ = (
        # 复合索引：按用户和活跃状态查询（对话列表常用）
        Index("ix_conversations_user_active",
              "user_id", "is_active"),
    )

    def __repr__(self) -> str:
        return f"<Conversation(id={self.id}, title='{self.title}', turn_count={self.turn_count})>"


class Message(Base):
    """
    消息模型（生产版）

    作用：
        对应数据库 messages 表，存储对话中的每条消息。
        包括用户提问和AI回答。

    表结构：
        - id: 主键
        - conversation_id: 对话ID
        - role: 消息角色（user/assistant/system）
        - content: 消息内容
        - sources: 引用来源（JSON）
        - is_streaming: 是否流式生成中
        - token_count: Token 数量
        - model_used: 使用的模型
        - response_time_ms: 响应耗时（毫秒）
        - is_regenerated: 是否重新生成
        - parent_message_id: 父消息ID（重新生成时关联原消息）
        - feedback: 用户反馈（positive/negative/null）
        - feedback_text: 反馈文本
        - created_at: 创建时间
    """

    __tablename__ = "messages"

    # 主键 ID
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # 对话ID（外键，关联 conversations 表）
    conversation_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("conversations.id", ondelete="CASCADE"),
        index=True
    )

    # 消息角色：user（用户）/ assistant（AI）/ system（系统）
    role: Mapped[str] = mapped_column(String(20))

    # 消息内容
    content: Mapped[str] = mapped_column(Text)

    # 引用来源（JSON 格式，存储检索到的文档片段信息）
    # 示例：[{"document_id": 1, "title": "xxx", "content": "xxx", "score": 0.95}]
    sources: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # 是否正在流式生成（True 表示生成中，False 表示完成）
    is_streaming: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())

    # ============================================
    # 新增字段
    # ============================================

    # Token 数量（用于成本计算和上下文长度控制）
    token_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # 使用的模型（记录实际使用的 LLM 模型）
    model_used: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # 响应耗时（毫秒）
    # 作用：性能监控
    response_time_ms: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # 是否是重新生成的消息
    # 作用：支持消息重新生成功能
    is_regenerated: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())

    # 父消息ID（重新生成时关联原消息）
    # 作用：重新生成的消息关联到原消息，便于追溯
    parent_message_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True
    )

    # 用户反馈：positive（点赞）/ negative（点踩）/ null（未反馈）
    feedback: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)

    # 反馈文本（用户可附加说明）
    feedback_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # 是否降级生成
    # 作用：标记该消息是否在降级模式下生成
    is_degraded: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())

    # 降级原因
    degrade_reason: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # 创建时间
    created_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime,
        server_default=func.now(),
        nullable=True,
    )

    # ============================================
    # 关联关系
    # ============================================

    # 消息所属的对话（多对一）
    conversation: Mapped["Conversation"] = relationship(
        "Conversation",
        back_populates="messages"
    )

    # 父消息（自引用关系，用于重新生成）
    parent_message: Mapped[Optional["Message"]] = relationship(
        "Message",
        remote_side=[id],
        foreign_keys=[parent_message_id]
    )

    def __repr__(self) -> str:
        return (
            f"<Message(id={self.id}, role='{self.role}', "
            f"content='{self.content[:50]}...')>"
        )
