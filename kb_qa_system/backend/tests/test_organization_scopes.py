import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.routes import agents, organizations
from app.core.database import Base
from app.models.organization import Organization, OrganizationMembership, OrganizationWorkflow
from app.models.shared_agent import SharedAgent
from app.models.user import User
from app.schemas.agent import AgentSpec, SharedAgentCreate
from app.schemas.organization import OrganizationMemberDecision


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[
        User.__table__, Organization.__table__, OrganizationMembership.__table__,
        SharedAgent.__table__, OrganizationWorkflow.__table__,
    ])
    with Session(engine, expire_on_commit=False) as session:
        yield session
    engine.dispose()


def seed_users(db):
    users = [
        User(id=1, username="owner", email="owner@example.test", hashed_password="hash"),
        User(id=2, username="admin", email="admin@example.test", hashed_password="hash"),
        User(id=3, username="member", email="member@example.test", hashed_password="hash"),
        User(id=4, username="outsider", email="outsider@example.test", hashed_password="hash"),
    ]
    db.add_all(users)
    db.commit()
    return users


def agent_spec(name="Shared helper"):
    return AgentSpec(
        name=name,
        summary="",
        instructions="Follow the task contract.",
        inputFields=[{"key": "context", "label": "Context", "type": "string", "required": True}],
        outputFields=[{"key": "result", "label": "Result", "type": "string", "required": True}],
    )


def test_shared_agents_are_filtered_by_active_membership_and_revoked_on_leave(db):
    owner, admin, member, outsider = seed_users(db)
    org_a = Organization(id=1, name="Alpha", slug="alpha", created_by=admin.id)
    org_b = Organization(id=2, name="Beta", slug="beta", created_by=admin.id)
    db.add_all([org_a, org_b])
    db.flush()
    db.add_all([
        OrganizationMembership(organization_id=1, user_id=owner.id, role="member", status="removed"),
        OrganizationMembership(organization_id=1, user_id=member.id, role="member", status="active"),
        OrganizationMembership(organization_id=1, user_id=admin.id, role="org_admin", status="active"),
        OrganizationMembership(organization_id=2, user_id=outsider.id, role="member", status="active"),
    ])
    scoped = SharedAgent(
        id="10000000-0000-4000-8000-000000000001", owner_id=owner.id, organization_id=1,
        name="Alpha helper", summary="", definition=agent_spec("Alpha helper").model_dump_json(by_alias=True),
    )
    global_agent = SharedAgent(
        id="10000000-0000-4000-8000-000000000002", owner_id=owner.id, organization_id=None,
        name="Global helper", summary="", definition=agent_spec("Global helper").model_dump_json(by_alias=True),
    )
    other_org = SharedAgent(
        id="10000000-0000-4000-8000-000000000003", owner_id=outsider.id, organization_id=2,
        name="Beta helper", summary="", definition=agent_spec("Beta helper").model_dump_json(by_alias=True),
    )
    db.add_all([scoped, global_agent, other_org])
    db.commit()

    visible = agents.list_public_agents(limit=100, db=db, _user=member)
    assert {item["id"] for item in visible} == {scoped.id, global_agent.id}
    own = agents.list_my_agents(db=db, user=owner)
    assert [item["id"] for item in own] == [global_agent.id]

    with pytest.raises(HTTPException) as denied:
        agents.update_agent(
            scoped.id,
            SharedAgentCreate(agent=agent_spec("Leaked"), organizationId=None),
            db=db,
            user=owner,
        )
    assert denied.value.status_code == 404
    assert db.query(SharedAgent).filter(SharedAgent.id == scoped.id).one().organization_id == 1

    db.delete(db.query(OrganizationMembership).filter_by(organization_id=1, user_id=member.id).one())
    db.commit()
    assert {item["id"] for item in agents.list_public_agents(limit=100, db=db, _user=member)} == {global_agent.id}


def test_membership_leave_requires_org_admin_review_and_last_admin_is_protected(db):
    owner, admin, member, outsider = seed_users(db)
    org = Organization(id=1, name="Alpha", slug="alpha", created_by=admin.id)
    db.add(org)
    db.flush()
    admin_membership = OrganizationMembership(organization_id=1, user_id=admin.id, role="org_admin", status="active")
    member_membership = OrganizationMembership(organization_id=1, user_id=member.id, role="member", status="active")
    db.add_all([admin_membership, member_membership])
    db.commit()

    with pytest.raises(HTTPException) as last_admin:
        organizations._protect_last_admin(db, 1, admin_membership)
    assert last_admin.value.status_code == 409

    organizations.request_leave(1, db=db, user=member)
    with pytest.raises(HTTPException) as non_admin:
        organizations.list_membership_requests(1, db=db, user=member)
    assert non_admin.value.status_code == 403

    organizations.decide_membership_request(
        1, member.id, OrganizationMemberDecision(decision="approve"), db=db, reviewer=admin
    )
    db.refresh(member_membership)
    assert member_membership.status == "removed"
    assert member_membership.pending_action is None
    with pytest.raises(HTTPException) as revoked:
        organizations.list_organization_workflows(1, db=db, user=member)
    assert revoked.value.status_code == 403
