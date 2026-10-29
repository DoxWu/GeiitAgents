"""Immutable capability library."""
from alembic import op
import sqlalchemy as sa

revision = "20261029_0013"
down_revision = "20261027_0012"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("shared_capabilities",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE")),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("definition", sa.Text(), nullable=False),
        sa.Column("reviewed_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()))
    for field in ("owner_id", "organization_id", "status"):
        op.create_index("ix_shared_capabilities_" + field, "shared_capabilities", [field])


def downgrade():
    op.drop_table("shared_capabilities")
