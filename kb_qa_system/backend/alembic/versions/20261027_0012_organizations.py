"""Add flat organizations, memberships, and organization-scoped resources."""
import sqlalchemy as sa
from alembic import op

revision = "20261027_0012"
down_revision = "20261027_0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False, unique=True),
        sa.Column("slug", sa.String(80), nullable=False, unique=True),
        sa.Column("description", sa.String(500), nullable=False, server_default=""),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "organization_memberships",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(20), nullable=False, server_default="member"),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("pending_action", sa.String(20)),
        sa.Column("requested_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime()),
        sa.Column("reviewed_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.UniqueConstraint("organization_id", "user_id", name="uq_organization_membership_org_user"),
    )
    op.create_index("ix_organization_membership_org_status", "organization_memberships", ["organization_id", "status"])
    op.create_index("ix_organization_membership_user_status", "organization_memberships", ["user_id", "status"])
    op.create_table(
        "organization_workflows",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("definition", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_organization_workflows_org_updated", "organization_workflows", ["organization_id", "updated_at"])
    op.add_column("documents", sa.Column("organization_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_documents_organization_id", "documents", "organizations", ["organization_id"], ["id"], ondelete="SET NULL")
    op.create_index("ix_documents_organization_id", "documents", ["organization_id"])
    op.add_column("registration_applications", sa.Column("organization_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_registration_applications_organization_id", "registration_applications", "organizations", ["organization_id"], ["id"], ondelete="SET NULL")
    op.create_index("ix_registration_applications_organization_id", "registration_applications", ["organization_id"])
    op.add_column("shared_agents", sa.Column("organization_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_shared_agents_organization_id", "shared_agents", "organizations", ["organization_id"], ["id"], ondelete="CASCADE")
    op.create_index("ix_shared_agents_organization_updated", "shared_agents", ["organization_id", "updated_at"])


def downgrade() -> None:
    op.drop_index("ix_shared_agents_organization_updated", table_name="shared_agents")
    op.drop_constraint("fk_shared_agents_organization_id", "shared_agents", type_="foreignkey")
    op.drop_column("shared_agents", "organization_id")
    op.drop_index("ix_registration_applications_organization_id", table_name="registration_applications")
    op.drop_constraint("fk_registration_applications_organization_id", "registration_applications", type_="foreignkey")
    op.drop_column("registration_applications", "organization_id")
    op.drop_index("ix_documents_organization_id", table_name="documents")
    op.drop_constraint("fk_documents_organization_id", "documents", type_="foreignkey")
    op.drop_column("documents", "organization_id")
    op.drop_index("ix_organization_workflows_org_updated", table_name="organization_workflows")
    op.drop_table("organization_workflows")
    op.drop_index("ix_organization_membership_user_status", table_name="organization_memberships")
    op.drop_index("ix_organization_membership_org_status", table_name="organization_memberships")
    op.drop_table("organization_memberships")
    op.drop_table("organizations")
