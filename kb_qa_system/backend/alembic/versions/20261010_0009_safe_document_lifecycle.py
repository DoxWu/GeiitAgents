"""Durable cleanup and deferred document replacement; purge QA payloads.

Revision ID: 20261010_0009
Revises: 20261001_0008
"""
import sqlalchemy as sa

from alembic import op

revision = '20261010_0009'
down_revision = '20261001_0008'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('documents', sa.Column('supersedes_document_id', sa.Integer(), nullable=True))
    op.create_foreign_key('fk_documents_supersedes', 'documents', 'documents', ['supersedes_document_id'], ['id'], ondelete='SET NULL')
    op.create_unique_constraint('uq_documents_supersedes', 'documents', ['supersedes_document_id'])
    op.create_table('file_cleanup_jobs',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('paths', sa.JSON(), nullable=False),
        sa.Column('status', sa.String(24), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False),
        sa.Column('error_code', sa.String(64), nullable=True),
        sa.Column('manual_review', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('available_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column('claimed_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column('completed_at', sa.DateTime(), nullable=True))
    op.create_index('ix_file_cleanup_jobs_status', 'file_cleanup_jobs', ['status'])
    op.create_index('ix_file_cleanup_jobs_available_at', 'file_cleanup_jobs', ['available_at'])
    # Historical telemetry payloads cannot be treated as anonymous statistics.
    op.execute("UPDATE qa_events SET question = '', answer = NULL, error_message = NULL")


def downgrade():
    raise RuntimeError('This migration purges telemetry payloads. Roll back the application image; do not drop the cleanup outbox.')
