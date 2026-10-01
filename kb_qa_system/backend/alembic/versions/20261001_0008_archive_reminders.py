"""allow account owners to archive closed reminders"""
from alembic import op
import sqlalchemy as sa

revision = "20261001_0008"
down_revision = "20260929_0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reminders", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_reminders_archived_at", "reminders", ["archived_at"])


def downgrade() -> None:
    op.drop_index("ix_reminders_archived_at", table_name="reminders")
    op.drop_column("reminders", "archived_at")
