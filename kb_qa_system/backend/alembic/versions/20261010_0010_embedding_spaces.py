"""Keep vector comparisons within a verified embedding model space.

Revision ID: 20261010_0010
Revises: 20261010_0009
"""
import sqlalchemy as sa

from alembic import op

revision = "20261010_0010"
down_revision = "20261010_0009"
branch_labels = None
depends_on = None


def upgrade():
    # Existing vectors have no trustworthy provider/model provenance. Keep them
    # out of semantic search until documents are explicitly reprocessed.
    op.add_column("document_chunks", sa.Column("embedding_space", sa.String(64), nullable=True))
    op.create_index("ix_document_chunks_embedding_space", "document_chunks", ["embedding_space"])


def downgrade():
    op.drop_index("ix_document_chunks_embedding_space", table_name="document_chunks")
    op.drop_column("document_chunks", "embedding_space")
