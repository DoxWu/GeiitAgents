"""初始迁移：创建所有表和 pgvector 扩展

Revision ID: 20260705_0001
Revises:
Create Date: 2026-07-05

作用：
    创建数据库初始结构，包括：
    1. 启用 pgvector 扩展
    2. 创建 users 表
    3. 创建 documents 表
    4. 创建 document_chunks 表（含 pgvector 向量列）
    5. 创建 conversations 表
    6. 创建 messages 表
    7. 创建 qa_events 表
    8. 创建必要索引
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import Vector


# revision identifiers, used by Alembic.
revision: str = "20260705_0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    升级：创建所有表

    作用：
        创建数据库初始结构。
        按依赖顺序创建：先创建被依赖的表（users），后创建依赖表。
    """

    # Read model dimensions only when migrating. Independent ops monitors load
    # revision metadata without requiring the main application's secrets.
    from app.core.config import settings

    # ============================================
    # 1. 启用 pgvector 扩展
    # ============================================
    # 作用：PostgreSQL 需要先启用 pgvector 扩展才能使用 Vector 类型
    op.execute("CREATE EXTENSION IF NOT EXISTS vector;")

    # ============================================
    # 2. 创建 users 表
    # ============================================
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("username", sa.String(50), nullable=False),
        sa.Column("email", sa.String(100), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("is_superuser", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )

    # 用户名和邮箱唯一索引
    op.create_index("ix_users_username", "users", ["username"], unique=True)
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_id", "users", ["id"])

    # ============================================
    # 3. 创建 documents 表
    # ============================================
    op.create_table(
        "documents",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("file_name", sa.String(255), nullable=False),
        sa.Column("file_path", sa.String(500), nullable=False),
        sa.Column("file_type", sa.String(20), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("file_hash", sa.String(64), nullable=True),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("processing_step", sa.String(50), nullable=False, server_default="uploaded"),
        sa.Column("processing_progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("task_id", sa.String(255), nullable=True),
        sa.Column("quality_score", sa.Float(), nullable=True),
        sa.Column("quality_issues", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("metadata_", sa.JSON(), nullable=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )

    # 索引
    op.create_index("ix_documents_id", "documents", ["id"])
    op.create_index("ix_documents_title", "documents", ["title"])
    op.create_index("ix_documents_file_type", "documents", ["file_type"])
    op.create_index("ix_documents_status", "documents", ["status"])
    op.create_index("ix_documents_file_hash", "documents", ["file_hash"], unique=True)
    op.create_index("ix_documents_user_id", "documents", ["user_id"])
    op.create_index("ix_documents_is_deleted", "documents", ["is_deleted"])
    op.create_index("ix_documents_user_status", "documents", ["user_id", "status"])

    # ============================================
    # 4. 创建 document_chunks 表（含 pgvector）
    # ============================================
    op.create_table(
        "document_chunks",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        # pgvector 向量列
        sa.Column("content_vector", Vector(settings.EMBEDDING_DIMENSION), nullable=True),
        # 全文检索列（tsvector 类型）
        sa.Column("content_tsv", sa.Text(), nullable=True),
        sa.Column("token_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("page_number", sa.Integer(), nullable=True),
        sa.Column("char_start", sa.Integer(), nullable=True),
        sa.Column("char_end", sa.Integer(), nullable=True),
        sa.Column("metadata_", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )

    # 索引
    op.create_index("ix_document_chunks_id", "document_chunks", ["id"])
    op.create_index("ix_document_chunks_document_id", "document_chunks", ["document_id"])
    op.create_index("ix_document_chunks_document_id_chunk_index",
                    "document_chunks", ["document_id", "chunk_index"])

    # 全文检索 GIN 索引
    # 作用：加速关键词检索
    op.execute(
        "CREATE INDEX ix_document_chunks_content_tsv "
        "ON document_chunks USING gin (to_tsvector('simple', content));"
    )

    # 向量索引（IVFFlat）
    # 作用：加速向量相似度检索
    # 注意：IVFFlat 需要先有数据才能创建，这里先创建空索引
    # lists 参数：聚类中心数，建议 sqrt(行数)
    op.execute(
        f"CREATE INDEX ix_document_chunks_content_vector "
        f"ON document_chunks USING ivfflat (content_vector vector_cosine_ops) "
        f"WITH (lists = 100);"
    )

    # ============================================
    # 5. 创建 conversations 表
    # ============================================
    op.create_table(
        "conversations",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(200), nullable=False, server_default="新对话"),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("is_pinned", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("summary_turn_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("turn_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("metadata_", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )

    op.create_index("ix_conversations_id", "conversations", ["id"])
    op.create_index("ix_conversations_user_id", "conversations", ["user_id"])
    op.create_index("ix_conversations_is_pinned", "conversations", ["is_pinned"])
    op.create_index("ix_conversations_user_active", "conversations", ["user_id", "is_active"])

    # ============================================
    # 6. 创建 messages 表
    # ============================================
    op.create_table(
        "messages",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("conversation_id", sa.Integer(), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("sources", sa.JSON(), nullable=True),
        sa.Column("is_streaming", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("token_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("model_used", sa.String(100), nullable=True),
        sa.Column("response_time_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_regenerated", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("parent_message_id", sa.Integer(), sa.ForeignKey("messages.id", ondelete="SET NULL"), nullable=True),
        sa.Column("feedback", sa.String(20), nullable=True),
        sa.Column("feedback_text", sa.Text(), nullable=True),
        sa.Column("is_degraded", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("degrade_reason", sa.String(100), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )

    op.create_index("ix_messages_id", "messages", ["id"])
    op.create_index("ix_messages_conversation_id", "messages", ["conversation_id"])

    # ============================================
    # 7. 创建 qa_events 表
    # ============================================
    op.create_table(
        "qa_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("messages.id", ondelete="SET NULL"), nullable=True),
        sa.Column("conversation_id", sa.Integer(), sa.ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("degraded", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("degrade_reason", sa.String(100), nullable=True),
        sa.Column("retrieval_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("retrieval_top_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("retrieval_time_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("llm_time_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("token_input", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("token_output", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("model_used", sa.String(100), nullable=True),
        sa.Column("total_time_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("user_feedback", sa.String(20), nullable=True),
        sa.Column("feedback_text", sa.Text(), nullable=True),
        sa.Column("error_code", sa.String(50), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )

    op.create_index("ix_qa_events_id", "qa_events", ["id"])
    op.create_index("ix_qa_events_message_id", "qa_events", ["message_id"])
    op.create_index("ix_qa_events_conversation_id", "qa_events", ["conversation_id"])
    op.create_index("ix_qa_events_user_id", "qa_events", ["user_id"])
    op.create_index("ix_qa_events_status", "qa_events", ["status"])
    op.create_index("ix_qa_events_created_at", "qa_events", ["created_at"])
    op.create_index("ix_qa_events_status_created", "qa_events", ["status", "created_at"])
    op.create_index("ix_qa_events_user_created", "qa_events", ["user_id", "created_at"])


def downgrade() -> None:
    """
    降级：删除所有表

    作用：
        回滚迁移，删除所有表。
        按依赖顺序逆序删除。
    """
    op.drop_table("qa_events")
    op.drop_table("messages")
    op.drop_table("conversations")
    op.drop_table("document_chunks")
    op.drop_table("documents")
    op.drop_table("users")
