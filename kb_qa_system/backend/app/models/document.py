"""
文档数据模型（生产版）

作用：
    定义文档表结构，存储用户上传的文档元数据。
    文档内容会被分块后向量化存储到 pgvector 中（document_chunks 表）。

实现方式：
    1. 使用 SQLAlchemy 2.0 声明式模型
    2. 与 User 模型建立一对多关系
    3. 与 DocumentChunk 模型建立一对多关系
    4. status 字段记录文档处理状态
    5. 新增质量分、文件哈希、软删除等字段
"""

from datetime import datetime
from typing import List, Optional, Any
from sqlalchemy import String, DateTime, Text, Integer, ForeignKey, JSON, Float, Boolean, func, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.document_folder import DocumentFolder


class Document(Base):
    """
    文档模型（生产版）

    作用：
        对应数据库 documents 表，存储用户上传文档的元数据。

    表结构：
        - id: 主键
        - title: 文档标题
        - file_name: 原始文件名
        - file_path: 服务器存储路径
        - file_type: 文件类型（pdf/md/txt/docx）
        - file_size: 文件大小（字节）
        - file_hash: 文件哈希（SHA256，用于去重）
        - content: 文档全文内容（可选）
        - status: 处理状态
        - quality_score: 文档质量分（0-100）
        - quality_issues: 质量问题列表（JSON）
        - chunk_count: 分块数量
        - total_tokens: 总 Token 数
        - error_message: 处理失败时的错误信息
        - processing_step: 当前处理步骤（流水线状态机）
        - processing_progress: 处理进度百分比（0-100）
        - task_id: Celery 任务ID
        - metadata_: 额外元数据
        - user_id: 上传用户ID
        - visibility: 可见性（private 个人库 / public 公共库）
        - is_deleted: 软删除标记
        - deleted_at: 删除时间
        - created_at: 创建时间
        - updated_at: 更新时间

    处理状态说明：
        - pending: 等待处理
        - processing: 正在处理
        - completed: 处理完成
        - failed: 处理失败
        - low_quality: 质量过低（需人工处理）

    处理步骤说明（processing_step）：
        - uploaded: 已上传
        - parsing: 正在解析
        - cleaning: 正在清洗脏数据
        - layout_analysis: 正在版面分析
        - table_extraction: 正在表格提取
        - ocr: 正在 OCR
        - chunking: 正在分块
        - embedding: 正在向量化
        - completed: 处理完成
        - failed: 处理失败
    """

    __tablename__ = "documents"

    # 主键 ID
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # 文档标题（用户可自定义）
    title: Mapped[str] = mapped_column(String(200), index=True)

    # 原始文件名
    file_name: Mapped[str] = mapped_column(String(255))

    # 服务器存储路径（相对路径）
    file_path: Mapped[str] = mapped_column(String(500))

    # 文件类型（扩展名，如 pdf/md/txt/docx）
    file_type: Mapped[str] = mapped_column(String(20), index=True)

    # 文件大小（字节）
    file_size: Mapped[int] = mapped_column(Integer)

    # 文件哈希（SHA256）
    # 作用：文件去重辅助字段。去重逻辑在应用层实现（仅检查 is_deleted=False 的活跃文档），
    #       不再使用 DB 唯一约束，避免软删除后无法重新上传相同内容的文件。
    #       并发安全由 Redis 分布式锁（upload:hash:{file_hash}）保证。
    file_hash: Mapped[Optional[str]] = mapped_column(
        String(64), index=True, nullable=True
    )
    supersedes_document_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("documents.id", ondelete="SET NULL"), nullable=True, unique=True
    )

    # 文档全文内容（可选，存储解析后的文本，用于全文搜索）
    content: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # 处理状态：pending/processing/completed/failed/low_quality
    status: Mapped[str] = mapped_column(
        String(20),
        default="pending",
        index=True
    )

    # 当前处理步骤（流水线状态机）
    # 作用：精确标识文档处于处理流程的哪一步
    processing_step: Mapped[str] = mapped_column(
        String(50),
        default="uploaded"
    )

    # 处理进度百分比（0-100）
    # 作用：前端展示处理进度条
    processing_progress: Mapped[int] = mapped_column(Integer, default=0)

    # Celery 任务ID
    # 作用：关联异步任务，便于查询任务状态
    task_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    # 文档质量分（0-100）
    # 作用：评估文档解析质量，低于阈值标记为低质量
    quality_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # 质量问题列表（JSON 格式）
    # 作用：记录具体质量问题，便于排查
    # 示例：["乱码内容", "空白页过多", "表格识别失败"]
    quality_issues: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # 处理失败时的错误信息
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # 文档分块数量（向量化后的小块数）
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)

    # 文档总 Token 数（用于成本计算）
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)

    # 额外元数据（JSON 格式，存储标签、分类、知识库ID等）
    metadata_: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # 上传用户ID（外键，关联 users 表）
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True
    )

    # 文档可见性（权限隔离核心字段）
    # 作用：控制文档的可见范围，实现"个人文档库"和"公共文档库"隔离
    # - private: 仅上传者和超级管理员可见/可检索（默认，个人文档库）
    # - public:  所有登录用户可见/可检索（公共文档库）
    visibility: Mapped[str] = mapped_column(
        String(20),
        default="private",
        index=True,
    )

    # 所属文档库分支ID（外键，删除分支时置 NULL）
    # 作用：文档按分支分类管理，NULL 表示未分类（默认分支）
    folder_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("document_folders.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # 软删除标记
    # 作用：不真正删除文档，便于数据恢复和审计
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    # 删除时间
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # 创建时间
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now()
    )

    # 更新时间
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now()
    )

    # ============================================
    # 关联关系
    # ============================================

    # 文档所属的用户（多对一）
    user: Mapped["User"] = relationship("User", back_populates="documents")

    # 文档的分块（一对多）
    # 作用：获取文档的所有向量块
    # cascade: 删除文档时级联删除其分块
    chunks: Mapped[List["DocumentChunk"]] = relationship(
        "DocumentChunk",
        back_populates="document",
        cascade="all, delete-orphan",
        order_by="DocumentChunk.chunk_index"  # 按块索引排序
    )

    # 所属文档库分支（多对一）
    # 作用：获取文档所属的分支信息，删除分支时 folder_id 置 NULL（不删除文档）
    folder: Mapped[Optional["DocumentFolder"]] = relationship(
        "DocumentFolder",
        back_populates="documents",
    )

    # ============================================
    # 索引
    # ============================================

    __table_args__ = (
        # 复合索引：按用户和状态查询（用户文档列表常用）
        Index("ix_documents_user_status",
              "user_id", "status"),
    )

    def __repr__(self) -> str:
        return (
            f"<Document(id={self.id}, title='{self.title}', "
            f"status='{self.status}', progress={self.processing_progress})>"
        )
