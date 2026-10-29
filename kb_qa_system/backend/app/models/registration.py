"""
注册申请数据模型

作用：
    存储用户提交的注册申请记录，支持管理员审批流程。
    审批通过后生成密码设置 Token，用户通过邮件链接设置密码并创建账号。

实现方式：
    1. 使用 SQLAlchemy 2.0 声明式模型
    2. 密码设置 Token 以 SHA-256 哈希存储（password_token_hash），不存明文
    3. Token 一次性使用（password_token_used_at 标记）
    4. Token 24 小时过期（password_token_expires_at）
"""

from datetime import datetime
from typing import Optional
from sqlalchemy import String, DateTime, Text, Integer, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RegistrationApplication(Base):
    """
    注册申请模型

    作用：
        对应数据库 registration_applications 表，存储用户注册申请和审批状态。

    业务流程：
        1. 用户提交申请 → status=pending
        2. 管理员批准 → status=approved，生成 password_token_hash
        3. 用户设置密码 → 创建 User 账号，标记 password_token_used_at
        4. 管理员拒绝 → status=rejected，记录 reject_reason

    表结构：
        - id: 主键，自增
        - email: 申请人邮箱
        - username: 申请用户名
        - status: 申请状态（pending/approved/rejected）
        - password_token_hash: 密码设置 Token 的 SHA-256 哈希（不存明文！）
        - password_token_expires_at: Token 过期时间
        - password_token_used_at: Token 使用时间（一次性标记，null=未使用）
        - submitted_at: 申请提交时间
        - reviewed_at: 审批时间
        - reviewed_by: 审批管理员 ID（外键）
        - reject_reason: 拒绝原因
        - created_user_id: 设置密码后创建的用户 ID（外键）
    """

    __tablename__ = "registration_applications"

    # 状态常量（供业务代码引用，避免硬编码字符串）
    STATUS_PENDING: str = "pending"
    STATUS_APPROVED: str = "approved"
    STATUS_REJECTED: str = "rejected"

    # 主键 ID，自增
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # 申请人邮箱（索引，便于按邮箱查询最新申请）
    email: Mapped[str] = mapped_column(String(100), index=True)

    # 申请用户名
    username: Mapped[str] = mapped_column(String(50))

    # 申请状态：pending / approved / rejected
    # 作用：驱动审批流程状态机，索引便于管理员按状态筛选
    status: Mapped[str] = mapped_column(
        String(20), default=STATUS_PENDING, server_default="pending", index=True
    )

    # 密码设置 Token 的 SHA-256 哈希值
    # 安全：不存明文 Token，防止数据库泄露后 Token 被复用
    # 审批通过时生成，设置密码后比对哈希验证
    password_token_hash: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True, unique=True, index=True
    )

    # Token 过期时间（审批通过时设置，默认 24 小时后）
    password_token_expires_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    # Token 使用时间（设置密码成功后填充，null 表示未使用）
    # 作用：一次性 Token 校验，使用后不可重复使用
    password_token_used_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    # 申请提交时间（服务器默认当前时间）
    submitted_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, server_default=func.now(),
        nullable=True,
    )

    # 审批时间（管理员审批时填充，null 表示未审批）
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    # 审批管理员 ID（外键关联 users 表）
    # ondelete=SET NULL：管理员被删除后保留审批记录
    reviewed_by: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # 拒绝原因（status=rejected 时填充）
    reject_reason: Mapped[Optional[str]] = mapped_column(
        String(500), nullable=True
    )

    # 设置密码后创建的用户 ID（外键关联 users 表）
    # 作用：关联申请记录与最终创建的用户账号
    created_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    organization_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # 创建时间 / 更新时间
    created_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, server_default=func.now(),
        nullable=True,
    )
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(),
        nullable=True,
    )

    # ============================================
    # 复合索引
    # ============================================

    # 按邮箱 + 提交时间查询最新申请（状态查询接口使用）
    __table_args__ = (
        Index("ix_registration_applications_email_submitted", "email", "submitted_at"),
        Index("ix_registration_applications_status_submitted", "status", "submitted_at"),
    )

    def __repr__(self) -> str:
        return f"<RegistrationApplication(id={self.id}, email='{self.email}', status='{self.status}')>"
