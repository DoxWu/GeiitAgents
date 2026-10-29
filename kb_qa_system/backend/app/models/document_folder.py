"""
文档库分支数据模型

作用：
    定义文档库分支表结构，支持用户将文档按分支（文件夹）分类管理。
    每个用户可创建多个分支，文档上传时可指定所属分支。

实现方式：
    1. 使用 SQLAlchemy 2.0 声明式模型
    2. 与 User 模型建立多对一关系（user_id 外键，ondelete=CASCADE）
    3. 与 Document 模型建立一对多关系（Document.folder_id 外键）
    4. 同一用户下分支名唯一（UniqueConstraint）
    5. 删除分支时，关联文档的 folder_id 置 NULL（ondelete=SET NULL）

设计说明：
    - 分支是用户私有的（user_id 隔离），不同用户的分支互不可见
    - 分支名在同一用户下唯一，防止重名混淆
    - 删除分支不删除文档，仅解除关联（folder_id 置 NULL）
    - document_count 为计算字段（运行时聚合），不持久化存储
"""

from datetime import datetime
from typing import TYPE_CHECKING, List, Optional
from sqlalchemy import String, DateTime, Integer, ForeignKey, func, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.document import Document
    from app.models.user import User


class DocumentFolder(Base):
    """
    文档库分支模型

    作用：
        对应数据库 document_folders 表，存储用户创建的文档分支。

    表结构：
        - id: 主键
        - name: 分支名称（同一用户下唯一）
        - user_id: 所属用户ID（外键，删除用户时级联删除分支）
        - created_at: 创建时间
        - updated_at: 更新时间

    关联关系：
        - user: 所属用户（多对一）
        - documents: 分支内的文档（一对多）

    使用方式：
        通过 /documents/folders 端点进行 CRUD 操作。
    """

    __tablename__ = "document_folders"

    # 主键 ID
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # 分支名称（同一用户下唯一）
    # 作用：用户可自定义分支名，如"技术文档"、"产品需求"等
    name: Mapped[str] = mapped_column(String(100))

    # 所属用户ID（外键，删除用户时级联删除分支）
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )

    # 创建时间
    created_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime,
        server_default=func.now(),
        nullable=True,
    )

    # 更新时间
    updated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
        nullable=True,
    )

    # ============================================
    # 关联关系
    # ============================================

    # 所属用户（多对一）
    user: Mapped["User"] = relationship("User", back_populates="folders")

    # 分支内的文档（一对多）
    # 作用：获取分支下的所有文档
    # 注意：不使用 cascade delete-orphan，删除分支时文档 folder_id 置 NULL（ondelete=SET NULL）
    documents: Mapped[List["Document"]] = relationship(
        "Document",
        back_populates="folder",
    )

    # ============================================
    # 约束
    # ============================================

    __table_args__ = (
        # 唯一约束：同一用户下分支名唯一
        # 作用：防止用户创建同名分支造成混淆
        UniqueConstraint("user_id", "name", name="uq_document_folders_user_name"),
    )

    def __repr__(self) -> str:
        return (
            f"<DocumentFolder(id={self.id}, name='{self.name}', "
            f"user_id={self.user_id})>"
        )
