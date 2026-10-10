"""
文档分块模型（pgvector 向量存储）

作用：
    使用 PostgreSQL + pgvector 存储文档分块的向量化表示。
    替代之前的 Chroma 方案，统一技术栈，减少组件依赖。

实现方式：
    1. 使用 pgvector 的 Vector 类型存储 Embedding 向量
    2. 使用 tsvector 支持全文检索（混合检索）
    3. 通过 IVFFlat 索引加速向量相似度检索
    4. 通过 GIN 索引加速全文检索

表结构：
    document_chunks
    - id: 主键
    - document_id: 文档ID（外键）
    - chunk_index: 块在文档中的索引
    - content: 块文本内容
    - content_vector: 文本向量（pgvector）
    - content_tsv: 全文检索向量（tsvector）
    - token_count: Token 数量
    - metadata_: 元数据（页码、位置等）
    - created_at: 创建时间
"""

from datetime import datetime
from typing import Optional, Dict, Any
from sqlalchemy import String, DateTime, Integer, ForeignKey, Text, JSON, func, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from pgvector.sqlalchemy import Vector

from app.core.database import Base
from app.core.config import settings


class DocumentChunk(Base):
    """
    文档分块模型

    作用：
        存储文档分块的文本和向量表示，用于 RAG 检索。
        一个文档会被切分为多个块，每个块独立向量化。

    表结构：
        - id: 主键
        - document_id: 所属文档ID
        - chunk_index: 块在文档中的索引（从0开始）
        - content: 块文本内容
        - content_vector: 文本的 Embedding 向量（pgvector Vector 类型）
        - content_tsv: 全文检索向量（PostgreSQL tsvector，用于关键词检索）
        - token_count: 块的 Token 数量（用于成本计算）
        - page_number: 页码（PDF等分页文档）
        - char_start: 块在原文中的起始字符位置
        - char_end: 块在原文中的结束字符位置
        - metadata_: 额外元数据
        - created_at: 创建时间

    检索方式：
        - 向量检索：使用 <=> 操作符计算余弦距离
        - 全文检索：使用 @@ 操作符进行关键词匹配
        - 混合检索：两者结合，加权排序
    """

    __tablename__ = "document_chunks"

    # 主键 ID
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # 所属文档ID（外键，关联 documents 表）
    # 删除文档时级联删除所有分块
    document_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("documents.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    # 块在文档中的索引（从0开始）
    # 作用：保持块的顺序，便于回溯原文
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)

    # 块文本内容
    # 作用：存储分块后的文本，检索时返回
    content: Mapped[str] = mapped_column(Text, nullable=False)

    # 文本的 Embedding 向量
    # 作用：存储文本的向量表示，用于相似度检索
    # 维度从配置读取（OpenAI ada-002 = 1536 维）
    content_vector: Mapped[Optional[Any]] = mapped_column(
        Vector(settings.EMBEDDING_DIMENSION),
        nullable=True,  # 可空，向量化可能失败
    )

    # Hash of provider type, model, endpoint and dimension. NULL means legacy
    # vectors whose model cannot be verified and therefore must not be compared.
    embedding_space: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)

    # 全文检索向量
    # 作用：支持 PostgreSQL 原生全文检索（关键词搜索）
    # 使用 to_tsvector 自动生成，支持中文（需 zhparser 扩展或简单分词）
    content_tsv: Mapped[Optional[Any]] = mapped_column(
        Text,  # 实际为 tsvector 类型，迁移脚本中处理
        nullable=True,
    )

    # Token 数量（用于成本计算和上下文长度控制）
    token_count: Mapped[int] = mapped_column(Integer, default=0)

    # 页码（PDF等分页文档）
    # 作用：引用定位时告知用户来自哪一页
    page_number: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # 块在原文中的字符位置
    # 作用：精确定位，前端可高亮显示引用位置
    char_start: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    char_end: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # 额外元数据（JSON 格式）
    # 作用：存储块类型（文本/表格/图片描述）、标题层级等
    metadata_: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # 创建时间
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now(),
    )

    # ============================================
    # 关联关系
    # ============================================

    # 块所属的文档（多对一）
    document: Mapped["Document"] = relationship(
        "Document",
        back_populates="chunks",
    )

    # ============================================
    # 索引
    # ============================================

    __table_args__ = (
        # 复合索引：按文档查询所有块时使用
        Index("ix_document_chunks_document_id_chunk_index",
              "document_id", "chunk_index"),

        # 向量索引：加速相似度检索
        # IVFFlat 索引，适合中等规模数据
        # 注意：IVFFlat 索引需要在迁移脚本中手动创建
        # 因为需要先有数据才能训练聚类中心
        # Index("ix_document_chunks_content_vector",
        #       "content_vector",
        #       postgresql_using="ivfflat",
        #       postgresql_with={"lists": 100},
        #       postgresql_ops={"content_vector": "vector_cosine_ops"}),

        # 全文检索索引：加速关键词检索
        # GIN 索引，支持高效的全文检索
        Index("ix_document_chunks_content_tsv",
              "content_tsv",
              postgresql_using="gin"),
    )

    def __repr__(self) -> str:
        return (
            f"<DocumentChunk(id={self.id}, document_id={self.document_id}, "
            f"chunk_index={self.chunk_index})>"
        )
