"""
用户数据模型

作用：
    定义用户表结构，存储用户基本信息（用户名、邮箱、密码哈希等）。
    这是认证授权的基础。

实现方式：
    1. 使用 SQLAlchemy 2.0 声明式模型
    2. 继承自 Base 类（在 database.py 中定义）
    3. 字段使用 Mapped 类型注解（类型安全）
"""

from datetime import datetime
from typing import TYPE_CHECKING, List, Optional
from sqlalchemy import String, Boolean, DateTime, Text, Integer, func, false, true
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.conversation import Conversation
    from app.models.document import Document
    from app.models.document_folder import DocumentFolder


class User(Base):
    """
    用户模型

    作用：
        对应数据库 users 表，存储用户账号信息。

    表结构：
        - id: 主键，自增
        - username: 用户名，唯一
        - email: 邮箱，唯一
        - hashed_password: 密码哈希值（不存明文！）
        - is_active: 是否激活（禁用用户设为 False）
        - is_superuser: 是否是超级管理员
        - created_at: 创建时间
        - updated_at: 更新时间

    关联关系：
        - documents: 用户上传的文档（一对多）
        - conversations: 用户的对话（一对多）
    """

    __tablename__ = "users"

    # 主键 ID，自增
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # 用户名，唯一索引，便于快速查找
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)

    # 邮箱，唯一索引
    email: Mapped[str] = mapped_column(String(100), unique=True, index=True)

    # 密码哈希值（使用 bcrypt 加密，不存储明文）
    hashed_password: Mapped[str] = mapped_column(String(255))

    # 是否激活（默认 True，管理员可禁用用户）
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())

    # 是否是超级管理员（默认 False）
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())

    # 用户类型（任务5）
    # 作用：区分正式注册用户（regular）与临时登录用户（guest），
    #       实施差异化权限控制（guest 限提问次数/禁上传/仅公共库）
    # regular: 正式注册用户，完整权限
    # guest: 临时登录用户，受限权限（20 次提问/禁上传/仅公共库检索）
    user_type: Mapped[str] = mapped_column(
        String(20),
        default="regular",
        server_default="regular",
        index=True,
    )

    # 创建时间（服务器默认当前时间）
    created_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime,
        server_default=func.now(),
        nullable=True,
    )

    # 更新时间（每次更新自动修改）
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
        nullable=True,
    )

    # ============================================
    # 关联关系
    # ============================================

    # 用户拥有的文档（一对多）
    # back_populates: 双向关联，Document.user 反向访问
    # cascade: 删除用户时级联删除其文档
    documents: Mapped[List["Document"]] = relationship(
        "Document",
        back_populates="user",
        cascade="all, delete-orphan"
    )

    # 用户的对话（一对多）
    conversations: Mapped[List["Conversation"]] = relationship(
        "Conversation",
        back_populates="user",
        cascade="all, delete-orphan"
    )

    # 用户的文档库分支（一对多）
    # 作用：用户创建的文档分支，删除用户时级联删除分支
    folders: Mapped[List["DocumentFolder"]] = relationship(
        "DocumentFolder",
        back_populates="user",
        cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        """
        字符串表示，便于调试

        作用：
            打印用户对象时显示有用信息，而非默认的 <User object>
        """
        return f"<User(id={self.id}, username='{self.username}', email='{self.email}')>"
