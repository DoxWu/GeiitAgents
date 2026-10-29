"""Authenticated public agent library with owner-only mutation."""
import json
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy import or_
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import get_current_active_user, get_current_regular_user
from app.core.database import get_db
from app.models.shared_agent import SharedAgent
from app.models.organization import Organization, OrganizationMembership
from app.models.user import User
from app.schemas.agent import AgentSpec, SharedAgentCreate


class AgentRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def safe_handler(request):
            try:
                result = await handler(request)
            except RequestValidationError:
                result = JSONResponse(status_code=422, content={"detail": "invalid_agent_request"})
            except HTTPException as exc:
                result = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)
            except SQLAlchemyError:
                result = JSONResponse(status_code=503, content={"detail": "agent_library_unavailable"})
            result.headers["Cache-Control"] = "no-store"
            return result

        return safe_handler


router = APIRouter(prefix="/agents", tags=["智能体仓库"], route_class=AgentRoute)


def agent_output(item: SharedAgent, owner: User) -> dict:
    return {"id": item.id, "ownerName": owner.username, "agent": json.loads(item.definition),
            "organizationId": item.organization_id,
            "createdAt": item.created_at.isoformat(), "updatedAt": item.updated_at.isoformat()}


def _can_manage_agent(db: Session, item: SharedAgent, user: User) -> bool:
    if user.is_superuser:
        return True
    if item.organization_id is None:
        return item.owner_id == user.id
    membership = db.query(OrganizationMembership).join(
        Organization, Organization.id == OrganizationMembership.organization_id
    ).filter(
        OrganizationMembership.organization_id == item.organization_id,
        OrganizationMembership.user_id == user.id,
        OrganizationMembership.status == "active",
        Organization.is_active.is_(True),
    ).first()
    return bool(membership and (item.owner_id == user.id or membership.role == "org_admin"))


def _validate_capability_dependencies(db, user, body):
    for resource in body.agent.capabilities:
        _validate_capability_snapshot(db, user, resource, body.organization_id)


def _validate_capability_snapshot(db, user, resource, organization_id):
    from app.api.routes.capabilities import require_capability
    if not resource.sharedId:
        raise HTTPException(422, "publish_capabilities_before_sharing_agent")
    item = require_capability(db, user, resource.sharedId)
    if item.organization_id is not None and item.organization_id != organization_id:
        raise HTTPException(403, "capability_scope_mismatch")
    expected = json.loads(item.definition)
    actual = resource.model_dump(mode="json", by_alias=True, exclude_none=True)
    actual.pop("sharedId", None)
    if actual.get("fn"):
        actual["fn"]["reviewed"] = False
    if actual != expected:
        raise HTTPException(409, "capability_version_mismatch")


@router.get("/public")
def list_public_agents(limit: int = Query(50, ge=1, le=100), db: Session = Depends(get_db), _user=Depends(get_current_active_user)):
    organization_ids = [row[0] for row in db.query(OrganizationMembership.organization_id).join(
            Organization, Organization.id == OrganizationMembership.organization_id
        ).filter(OrganizationMembership.user_id == _user.id,
                 OrganizationMembership.status == "active", Organization.is_active.is_(True)).all()]
    scope_filter = True if _user.is_superuser else SharedAgent.organization_id.is_(None)
    if organization_ids:
        scope_filter = or_(scope_filter, SharedAgent.organization_id.in_(organization_ids))
    rows = db.query(SharedAgent, User).join(User, User.id == SharedAgent.owner_id).filter(User.is_active.is_(True), scope_filter) \
        .order_by(SharedAgent.updated_at.desc(), SharedAgent.id).limit(limit).all()
    return [agent_output(item, owner) for item, owner in rows]


@router.get("/mine")
def list_my_agents(db: Session = Depends(get_db), user: User = Depends(get_current_regular_user)):
    query = db.query(SharedAgent).filter(SharedAgent.owner_id == user.id)
    if not user.is_superuser:
        organization_ids = [row[0] for row in db.query(OrganizationMembership.organization_id).join(
            Organization, Organization.id == OrganizationMembership.organization_id
        ).filter(OrganizationMembership.user_id == user.id,
                 OrganizationMembership.status == "active", Organization.is_active.is_(True)).all()]
        scope_filter = SharedAgent.organization_id.is_(None)
        if organization_ids:
            scope_filter = or_(scope_filter, SharedAgent.organization_id.in_(organization_ids))
        query = query.filter(scope_filter)
    items = query.order_by(SharedAgent.updated_at.desc()).limit(100).all()
    return [agent_output(item, user) for item in items]


@router.post("/public", status_code=201)
def publish_agent(body: SharedAgentCreate, db: Session = Depends(get_db), user: User = Depends(get_current_regular_user)):
    _validate_capability_dependencies(db, user, body)
    if body.organization_id is not None:
        organization = db.query(Organization).filter(
            Organization.id == body.organization_id, Organization.is_active.is_(True)
        ).first()
        if organization is None:
            raise HTTPException(404, "organization_not_found")
        if not user.is_superuser and db.query(OrganizationMembership.id).filter(
            OrganizationMembership.organization_id == body.organization_id,
            OrganizationMembership.user_id == user.id,
            OrganizationMembership.status == "active",
        ).first() is None:
            raise HTTPException(403, "organization_membership_required")
    db.query(User).filter(User.id == user.id).with_for_update().one()
    if db.query(SharedAgent).filter(SharedAgent.owner_id == user.id).count() >= 100:
        raise HTTPException(409, "agent_limit_reached")
    item = SharedAgent(id=str(uuid4()), owner_id=user.id, name=body.agent.name, summary=body.agent.summary,
                       definition=body.agent.model_dump_json(by_alias=True, exclude_none=True), organization_id=body.organization_id)
    db.add(item)
    db.commit()
    db.refresh(item)
    return agent_output(item, user)


@router.put("/public/{agent_id}")
def update_agent(agent_id: str, body: SharedAgentCreate, db: Session = Depends(get_db), user: User = Depends(get_current_regular_user)):
    item = db.query(SharedAgent).filter(SharedAgent.id == agent_id).with_for_update().first()
    if not item or not _can_manage_agent(db, item, user):
        raise HTTPException(404, "agent_not_found")
    organization_id = item.organization_id
    if "organization_id" in body.model_fields_set:
        organization_id = body.organization_id
    _validate_capability_dependencies(db, user, body.model_copy(update={"organization_id": organization_id}))
    if organization_id is not None:
        organization = db.query(Organization).filter(
            Organization.id == organization_id, Organization.is_active.is_(True)
        ).first()
        if organization is None:
            raise HTTPException(404, "organization_not_found")
        if not user.is_superuser and db.query(OrganizationMembership.id).filter(
            OrganizationMembership.organization_id == organization_id,
            OrganizationMembership.user_id == user.id,
            OrganizationMembership.status == "active",
        ).first() is None:
            raise HTTPException(403, "organization_membership_required")
    item.name, item.summary = body.agent.name, body.agent.summary
    item.definition = body.agent.model_dump_json(by_alias=True, exclude_none=True)
    item.organization_id = organization_id
    item.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(item)
    return agent_output(item, user)


@router.delete("/public/{agent_id}", status_code=204)
def delete_agent(agent_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_regular_user)):
    item = db.query(SharedAgent).filter(SharedAgent.id == agent_id).first()
    if not item or not _can_manage_agent(db, item, user):
        raise HTTPException(404, "agent_not_found")
    db.delete(item)
    db.commit()
