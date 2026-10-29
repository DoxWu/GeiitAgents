"""Create the authenticated public agent library."""
import sqlalchemy as sa
from alembic import op

revision = "20261027_0011"
down_revision = "20261010_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "shared_agents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("summary", sa.String(300), nullable=False, server_default=""),
        sa.Column("definition", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_shared_agents_updated", "shared_agents", ["updated_at"])
    op.create_index("ix_shared_agents_owner_updated", "shared_agents", ["owner_id", "updated_at"])


def downgrade() -> None:
    op.drop_index("ix_shared_agents_owner_updated", table_name="shared_agents")
    op.drop_index("ix_shared_agents_updated", table_name="shared_agents")
    op.drop_table("shared_agents")
