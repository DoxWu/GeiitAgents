"""add persistent notes, todos and reminders"""
from alembic import op
import sqlalchemy as sa

revision = "20260929_0007"
down_revision = "20260715_0006"
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table("notes", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False), sa.Column("title", sa.String(120), nullable=False), sa.Column("content", sa.Text(), nullable=False, server_default=""), sa.Column("tags", sa.Text(), nullable=False, server_default="[]"), sa.Column("revision", sa.Integer(), nullable=False, server_default="1"), sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()), sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()))
    op.create_index("ix_notes_user_id", "notes", ["user_id"]); op.create_index("ix_notes_user_updated", "notes", ["user_id", "updated_at"])
    op.create_table("todos", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False), sa.Column("title", sa.String(120), nullable=False), sa.Column("content", sa.Text(), nullable=False, server_default=""), sa.Column("tags", sa.Text(), nullable=False, server_default="[]"), sa.Column("status", sa.String(20), nullable=False, server_default="open"), sa.Column("priority", sa.String(20), nullable=False, server_default="normal"), sa.Column("due_at", sa.DateTime(timezone=True), nullable=True), sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True), sa.Column("revision", sa.Integer(), nullable=False, server_default="1"), sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()), sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()))
    for name, columns in (("ix_todos_user_id", ["user_id"]), ("ix_todos_status", ["status"]), ("ix_todos_due_at", ["due_at"]), ("ix_todos_user_status_due", ["user_id", "status", "due_at"])): op.create_index(name, "todos", columns)
    op.create_table("reminders", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False), sa.Column("todo_id", sa.Integer(), sa.ForeignKey("todos.id", ondelete="SET NULL"), nullable=True), sa.Column("request_id", sa.String(36), nullable=False), sa.Column("request_hash", sa.String(64), nullable=False), sa.Column("revision", sa.Integer(), nullable=False, server_default="1"), sa.Column("recipient", sa.String(320), nullable=False), sa.Column("subject", sa.String(200), nullable=False), sa.Column("body", sa.Text(), nullable=False, server_default=""), sa.Column("timezone", sa.String(64), nullable=False, server_default="UTC"), sa.Column("recurrence", sa.String(32), nullable=False, server_default="once"), sa.Column("anchor_at", sa.DateTime(timezone=True), nullable=False), sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True), sa.Column("status", sa.String(20), nullable=False, server_default="active"), sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True), sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()), sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()))
    for name, columns in (("ix_reminders_user_id", ["user_id"]), ("ix_reminders_todo_id", ["todo_id"]), ("ix_reminders_next_run_at", ["next_run_at"]), ("ix_reminders_status", ["status"]), ("ix_reminders_due", ["status", "next_run_at"])): op.create_index(name, "reminders", columns)
    op.create_unique_constraint("uq_reminders_user_request", "reminders", ["user_id", "request_id"])
    op.create_table("reminder_deliveries", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("reminder_id", sa.Integer(), sa.ForeignKey("reminders.id", ondelete="CASCADE"), nullable=False), sa.Column("revision", sa.Integer(), nullable=False), sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False), sa.Column("email_log_id", sa.Integer(), sa.ForeignKey("email_logs.id", ondelete="RESTRICT"), nullable=False), sa.Column("status", sa.String(20), nullable=False, server_default="pending"), sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"), sa.Column("retry_limit", sa.Integer(), nullable=False, server_default="5"), sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False), sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True), sa.Column("enqueued_at", sa.DateTime(timezone=True), nullable=True), sa.Column("error_code", sa.String(64), nullable=True), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()))
    op.create_unique_constraint("uq_reminder_occurrence", "reminder_deliveries", ["reminder_id", "revision", "scheduled_at"])
    op.create_unique_constraint("uq_reminder_delivery_email", "reminder_deliveries", ["email_log_id"])
    op.create_index("ix_reminder_deliveries_due", "reminder_deliveries", ["status", "next_attempt_at"])
    # Link durable reminder deliveries to the existing idempotent email log.
    op.add_column("email_logs", sa.Column("reminder_id", sa.Integer(), nullable=True))
    op.create_index("ix_email_logs_reminder_id", "email_logs", ["reminder_id"])

def downgrade() -> None:
    op.drop_table("reminder_deliveries")
    op.drop_index("ix_email_logs_reminder_id", table_name="email_logs"); op.drop_column("email_logs", "reminder_id")
    op.drop_table("reminders"); op.drop_table("todos"); op.drop_table("notes")
