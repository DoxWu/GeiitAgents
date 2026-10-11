"""
邮件发送日志模型

作用：
    记录所有发出的邮件，便于追踪发送状态和排查失败原因。
    Celery task 从此表读取渲染后的 HTML 内容并发送。

实现方式：
    1. 使用 SQLAlchemy 2.0 声明式模型
    2. html_body 字段存储渲染后的 HTML，避免 task 中重新渲染
    3. error_message 字段脱敏存储（仅异常类型名，不含原始堆栈）
"""

from datetime import datetime
from typing import Optional
from sqlalchemy import String, DateTime, Text, Integer, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EmailLog(Base):
    """
    邮件发送日志模型

    作用：
        对应数据库 email_logs 表，记录每封邮件的发送状态和结果。

    业务流程：
        1. API 创建 EmailLog（status=pending，存储渲染后 html_body）
        2. Celery task 读取 EmailLog，调用 SMTP 发送
        3. 成功：status=sent，sent_at=now
        4. 失败：status=failed，error_message=脱敏错误，retry_count+1，触发重试

    表结构：
        - id: 主键，自增
        - recipient: 收件人邮箱
        - subject: 邮件主题
        - email_type: 邮件类型（register_notify_admin/password_setup/register_rejected/account_created）
        - status: 发送状态（pending/sent/failed）
        - html_body: 渲染后的 HTML 邮件内容
        - error_message: 失败原因（脱敏，仅异常类型名）
        - retry_count: 重试次数
        - application_id: 关联的申请 ID（外键）
        - celery_task_id: Celery 任务 ID
        - sent_at: 发送成功时间
    """

    __tablename__ = "email_logs"

    # 邮件类型常量
    TYPE_REGISTER_NOTIFY_ADMIN: str = "register_notify_admin"
    TYPE_PASSWORD_SETUP: str = "password_setup"
    TYPE_REGISTER_REJECTED: str = "register_rejected"
    TYPE_ACCOUNT_CREATED: str = "account_created"

    # 状态常量
    STATUS_PENDING: str = "pending"
    STATUS_SENDING: str = "sending"
    STATUS_SENT: str = "sent"
    STATUS_FAILED: str = "failed"
    STATUS_UNKNOWN: str = "unknown"

    # 主键 ID，自增
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # 收件人邮箱
    recipient: Mapped[str] = mapped_column(String(100))

    # 邮件主题
    subject: Mapped[str] = mapped_column(String(200))

    # 邮件类型（索引，便于按场景统计）
    email_type: Mapped[str] = mapped_column(String(50), index=True)

    # 发送状态（索引，便于查询失败邮件重试）
    status: Mapped[str] = mapped_column(
        String(20), default=STATUS_PENDING, server_default="pending", index=True
    )

    # 渲染后的 HTML 邮件内容
    # 作用：Celery task 直接读取此字段发送，无需重新查关联表和渲染模板
    html_body: Mapped[str] = mapped_column(Text)

    # 失败原因（脱敏存储，仅异常类型名，不含原始堆栈）
    # 安全：防止数据库泄露后暴露内部路径/SMTP 凭证等敏感信息
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # 重试次数
    retry_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0"
    )

    # 关联的申请 ID（外键，ondelete=SET NULL 保留邮件记录）
    application_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("registration_applications.id", ondelete="SET NULL"),
        nullable=True, index=True
    )

    reminder_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)

    # Celery 任务 ID（用于追踪任务状态）
    celery_task_id: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True
    )

    # 发送成功时间（null 表示未成功）
    sent_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    # 创建时间 / 更新时间
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # 复合索引：按状态 + 创建时间查询（用于失败重试）
    __table_args__ = (
        Index("ix_email_logs_status_created", "status", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<EmailLog(id={self.id}, recipient='{self.recipient}', type='{self.email_type}', status='{self.status}')>"
