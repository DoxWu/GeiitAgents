import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_active_user, get_current_regular_user, get_current_superuser
from app.core.database import get_db
from app.models.organization import Organization, OrganizationMembership, OrganizationWorkflow
from app.models.user import User
from app.schemas.organization import (
    DirectMembershipUpdate,
    MembershipRoleUpdate,
    OrganizationCreate,
    OrganizationMemberDecision,
    OrganizationPatch,
    OrganizationWorkflowRequest,
)

router = APIRouter(prefix="/organizations", tags=["组织"])


def _organization(item: Organization) -> dict:
    return {"id": item.id, "name": item.name, "slug": item.slug,
            "description": item.description, "isActive": item.is_active}


def _membership(item: OrganizationMembership, org: Organization) -> dict:
    return {"organization": _organization(org), "role": item.role, "status": item.status,
            "pendingAction": item.pending_action, "requestedAt": item.requested_at.isoformat()}


def _get_organization(db: Session, organization_id: int, *, active: bool = True) -> Organization:
    org = db.query(Organization).filter(Organization.id == organization_id).first()
    if org is None or (active and not org.is_active):
        raise HTTPException(status_code=404, detail="organization_not_found")
    return org


def _membership_row(db: Session, organization_id: int, user_id: int) -> OrganizationMembership | None:
    return db.query(OrganizationMembership).filter(
        OrganizationMembership.organization_id == organization_id,
        OrganizationMembership.user_id == user_id,
    ).with_for_update().first()


def _is_org_admin(db: Session, organization_id: int, user: User) -> bool:
    if user.is_superuser:
        return True
    return db.query(OrganizationMembership.id).filter(
        OrganizationMembership.organization_id == organization_id,
        OrganizationMembership.user_id == user.id,
        OrganizationMembership.role == "org_admin",
        OrganizationMembership.status == "active",
    ).first() is not None


def _require_org_access(db: Session, organization_id: int, user: User) -> Organization:
    org = _get_organization(db, organization_id)
    if user.is_superuser:
        return org
    member = db.query(OrganizationMembership.id).filter(
        OrganizationMembership.organization_id == organization_id,
        OrganizationMembership.user_id == user.id,
        OrganizationMembership.status == "active",
    ).first()
    if member is None:
        raise HTTPException(status_code=403, detail="organization_membership_required")
    return org


def _require_org_admin(db: Session, organization_id: int, user: User) -> Organization:
    org = _require_org_access(db, organization_id, user)
    if not _is_org_admin(db, organization_id, user):
        raise HTTPException(status_code=403, detail="organization_admin_required")
    return org


def _active_org_ids(db: Session, user_id: int) -> list[int]:
    return [row[0] for row in db.query(OrganizationMembership.organization_id)
            .join(Organization, Organization.id == OrganizationMembership.organization_id)
            .filter(OrganizationMembership.user_id == user_id,
                    OrganizationMembership.status == "active", Organization.is_active.is_(True)).all()]


def _protect_last_admin(db: Session, organization_id: int, membership: OrganizationMembership) -> None:
    if membership.role != "org_admin" or membership.status != "active":
        return
    # Serialize membership removals for one organization so concurrent reviews
    # cannot both observe two admins and remove both of them.
    db.query(Organization.id).filter(Organization.id == organization_id).with_for_update().first()
    count = db.query(func.count(OrganizationMembership.id)).filter(
        OrganizationMembership.organization_id == organization_id,
        OrganizationMembership.role == "org_admin",
        OrganizationMembership.status == "active",
    ).scalar() or 0
    if count <= 1:
        raise HTTPException(status_code=409, detail="organization_requires_an_admin")


@router.get("/catalog")
def organization_catalog(db: Session = Depends(get_db)):
    return [_organization(item) for item in db.query(Organization).filter(
        Organization.is_active.is_(True)).order_by(Organization.name).limit(500).all()]


@router.get("/mine")
def my_organizations(db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    rows = db.query(OrganizationMembership, Organization).join(
        Organization, Organization.id == OrganizationMembership.organization_id
    ).filter(OrganizationMembership.user_id == user.id,
             OrganizationMembership.status.in_(["active", "pending"])).order_by(Organization.name).all()
    return [{**_membership(member, org), "role": member.role} for member, org in rows]


@router.get("/admin")
def admin_organizations(db: Session = Depends(get_db), _admin: User = Depends(get_current_superuser)):
    rows = db.query(Organization).order_by(Organization.name).limit(500).all()
    return [{**_organization(org), "memberCount": db.query(func.count(OrganizationMembership.id)).filter(
        OrganizationMembership.organization_id == org.id,
        OrganizationMembership.status == "active").scalar() or 0} for org in rows]


@router.get("/search-users")
def search_users(q: str = Query(min_length=3, max_length=100), db: Session = Depends(get_db),
                 _admin: User = Depends(get_current_superuser)):
    pattern = f"%{q.strip()}%"
    rows = db.query(User).filter(User.is_active.is_(True),
        (User.username.ilike(pattern) | User.email.ilike(pattern))).order_by(User.id).limit(20).all()
    return [{"id": item.id, "username": item.username, "email": item.email} for item in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_organization(body: OrganizationCreate, db: Session = Depends(get_db),
                        admin: User = Depends(get_current_superuser)):
    org = Organization(name=body.name, slug=body.slug.lower(), description=body.description, created_by=admin.id)
    db.add(org)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="organization_name_or_slug_exists") from None
    db.refresh(org)
    return _organization(org)


@router.patch("/{organization_id}")
def update_organization(organization_id: int, body: OrganizationPatch, db: Session = Depends(get_db),
                        _admin: User = Depends(get_current_superuser)):
    org = _get_organization(db, organization_id, active=False)
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(org, key, value.strip() if isinstance(value, str) else value)
    org.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="organization_name_exists") from None
    db.refresh(org)
    return _organization(org)


@router.post("/{organization_id}/join", status_code=status.HTTP_202_ACCEPTED)
def request_join(organization_id: int, db: Session = Depends(get_db),
                 user: User = Depends(get_current_regular_user)):
    _get_organization(db, organization_id)
    row = _membership_row(db, organization_id, user.id)
    if row is not None and row.status in {"active", "pending"}:
        raise HTTPException(status_code=409, detail="organization_request_already_exists")
    if row is None:
        row = OrganizationMembership(organization_id=organization_id, user_id=user.id,
                                     role="member", status="pending", pending_action="join")
        db.add(row)
    else:
        row.role, row.status, row.pending_action = "member", "pending", "join"
        row.requested_at = datetime.now(timezone.utc).replace(tzinfo=None)
        row.reviewed_at = None
        row.reviewed_by = None
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="organization_request_already_exists") from None
    return {"status": "pending", "organizationId": organization_id}


@router.post("/{organization_id}/leave", status_code=status.HTTP_202_ACCEPTED)
def request_leave(organization_id: int, db: Session = Depends(get_db),
                  user: User = Depends(get_current_regular_user)):
    _get_organization(db, organization_id)
    row = _membership_row(db, organization_id, user.id)
    if row is None or row.status != "active" or row.pending_action:
        raise HTTPException(status_code=409, detail="active_organization_membership_required")
    if row.role == "org_admin":
        _protect_last_admin(db, organization_id, row)
    row.pending_action = "leave"
    row.requested_at = datetime.now(timezone.utc).replace(tzinfo=None)
    row.reviewed_at = None
    row.reviewed_by = None
    db.commit()
    return {"status": "pending", "organizationId": organization_id, "action": "leave"}


@router.get("/{organization_id}/members")
def list_members(organization_id: int, db: Session = Depends(get_db),
                 user: User = Depends(get_current_active_user)):
    _require_org_admin(db, organization_id, user)
    rows = db.query(OrganizationMembership, User).join(
        User, User.id == OrganizationMembership.user_id
    ).filter(OrganizationMembership.organization_id == organization_id,
             OrganizationMembership.status.in_(["active", "pending"])).order_by(User.username).limit(1000).all()
    return [{"userId": member.user_id, "username": target.username, "email": target.email,
             "role": member.role, "status": member.status, "pendingAction": member.pending_action}
            for member, target in rows]


@router.post("/{organization_id}/requests/{user_id}")
def decide_membership_request(organization_id: int, user_id: int, body: OrganizationMemberDecision,
                              db: Session = Depends(get_db), reviewer: User = Depends(get_current_active_user)):
    _require_org_admin(db, organization_id, reviewer)
    if reviewer.id == user_id:
        raise HTTPException(status_code=403, detail="cannot_review_own_membership_request")
    row = _membership_row(db, organization_id, user_id)
    if row is None or row.pending_action not in {"join", "leave"}:
        raise HTTPException(status_code=404, detail="membership_request_not_found")
    action = row.pending_action
    if action == "leave" and body.decision == "approve":
        _protect_last_admin(db, organization_id, row)
    if body.decision == "approve":
        row.status = "active" if action == "join" else "removed"
    elif action == "join":
        row.status = "removed"
    row.pending_action = None
    row.reviewed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    row.reviewed_by = reviewer.id
    db.commit()
    return {"userId": user_id, "action": action, "decision": body.decision, "status": row.status}


@router.put("/{organization_id}/members/{user_id}")
def set_membership(organization_id: int, user_id: int, body: DirectMembershipUpdate,
                   db: Session = Depends(get_db), admin: User = Depends(get_current_superuser)):
    _get_organization(db, organization_id, active=False)
    target = db.query(User).filter(User.id == user_id).first()
    if target is None or not target.is_active:
        raise HTTPException(status_code=404, detail="user_not_found")
    row = _membership_row(db, organization_id, user_id)
    if row is None:
        row = OrganizationMembership(organization_id=organization_id, user_id=user_id, role=body.role,
                                     status="active" if body.active else "removed")
        db.add(row)
    elif not body.active:
        _protect_last_admin(db, organization_id, row)
        row.status, row.pending_action = "removed", None
    else:
        row.role, row.status, row.pending_action = body.role, "active", None
    row.reviewed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    row.reviewed_by = admin.id
    db.commit()
    return {"userId": user_id, "organizationId": organization_id,
            "status": row.status, "role": row.role}


@router.put("/{organization_id}/members/{user_id}/role")
def set_membership_role(organization_id: int, user_id: int, body: MembershipRoleUpdate,
                        db: Session = Depends(get_db), admin: User = Depends(get_current_superuser)):
    row = _membership_row(db, organization_id, user_id)
    if row is None or row.status != "active":
        raise HTTPException(status_code=404, detail="active_membership_not_found")
    if body.role == "member":
        _protect_last_admin(db, organization_id, row)
    row.role = body.role
    row.reviewed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    row.reviewed_by = admin.id
    db.commit()
    return {"userId": user_id, "organizationId": organization_id, "role": row.role}


@router.get("/{organization_id}/requests")
def list_membership_requests(organization_id: int, db: Session = Depends(get_db),
                             user: User = Depends(get_current_active_user)):
    _require_org_admin(db, organization_id, user)
    rows = db.query(OrganizationMembership, User).join(
        User, User.id == OrganizationMembership.user_id
    ).filter(OrganizationMembership.organization_id == organization_id,
             OrganizationMembership.pending_action.isnot(None)).order_by(
                 OrganizationMembership.requested_at, OrganizationMembership.id).limit(500).all()
    return [{"userId": member.user_id, "username": target.username, "email": target.email,
             "action": member.pending_action, "requestedAt": member.requested_at.isoformat()}
            for member, target in rows]


def _validate_workflow_definition(definition: dict) -> str:
    if set(definition) != {"format", "version", "exportedAt", "workflow"}:
        raise HTTPException(status_code=422, detail="invalid_workflow_template")
    if definition.get("format") != "geiit-workflow-definition" or definition.get("version") not in (3, 4):
        raise HTTPException(status_code=422, detail="unsupported_workflow_template")
    workflow = definition.get("workflow")
    if not isinstance(workflow, dict) or set(workflow) != {"name", "nodes", "edges"}:
        raise HTTPException(status_code=422, detail="invalid_workflow_template")
    nodes, edges = workflow.get("nodes"), workflow.get("edges")
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= 12 or not isinstance(edges, list) or len(edges) > 32:
        raise HTTPException(status_code=422, detail="workflow_template_limit_exceeded")
    forbidden = {"apikey", "password", "secret", "authorization", "credential", "profileid", "accesstoken", "refreshtoken"}

    def scan(value: Any) -> None:
        if isinstance(value, dict):
            if any(str(key).replace("_", "").lower() in forbidden for key in value):
                raise HTTPException(status_code=422, detail="workflow_template_contains_connection_data")
            for child in value.values():
                scan(child)
        elif isinstance(value, list):
            for child in value:
                scan(child)

    scan(definition)
    serialized = json.dumps(definition, ensure_ascii=False, separators=(",", ":"))
    if len(serialized.encode("utf-8")) > 512 * 1024:
        raise HTTPException(status_code=413, detail="workflow_template_too_large")
    return serialized


def _workflow_can_manage(db: Session, item: OrganizationWorkflow, user: User) -> bool:
    return item.owner_id == user.id or user.is_superuser or _is_org_admin(db, item.organization_id, user)


def _workflow_capabilities(db, user, definition, organization_id):
    from app.api.routes.agents import _validate_capability_snapshot
    from app.schemas.capability import CapabilitySpec
    for node in definition['workflow']['nodes']:
        if not isinstance(node, dict):
            raise HTTPException(422, 'invalid_workflow_node')
        agent = node.get('agent') or {}
        if not isinstance(agent, dict) or not isinstance(agent.get('capabilities', []), list) or len(agent.get('capabilities', [])) > 12:
            raise HTTPException(422, 'invalid_workflow_capabilities')
        resources = [*agent.get('capabilities', []), *([node['capability']] if node.get('capability') else [])]
        for raw in resources:
            try:
                resource = CapabilitySpec.model_validate(raw)
            except ValueError:
                raise HTTPException(422, 'invalid_workflow_capability') from None
            _validate_capability_snapshot(db, user, resource, organization_id)


@router.get("/{organization_id}/workflows")
def list_organization_workflows(organization_id: int, db: Session = Depends(get_db),
                               user: User = Depends(get_current_active_user)):
    _require_org_access(db, organization_id, user)
    rows = db.query(OrganizationWorkflow).filter(
        OrganizationWorkflow.organization_id == organization_id
    ).order_by(OrganizationWorkflow.updated_at.desc()).limit(100).all()
    return [{"id": row.id, "organizationId": row.organization_id, "name": row.name,
             "definition": json.loads(row.definition), "ownerId": row.owner_id,
             "updatedAt": row.updated_at.isoformat()} for row in rows]


@router.post("/{organization_id}/workflows", status_code=status.HTTP_201_CREATED)
def publish_organization_workflow(organization_id: int, body: OrganizationWorkflowRequest,
                                  db: Session = Depends(get_db), user: User = Depends(get_current_regular_user)):
    _require_org_access(db, organization_id, user)
    db.query(Organization.id).filter(Organization.id == organization_id).with_for_update().first()
    if db.query(OrganizationWorkflow).filter(OrganizationWorkflow.organization_id == organization_id,
                                             OrganizationWorkflow.owner_id == user.id).count() >= 50:
        raise HTTPException(status_code=409, detail="organization_workflow_limit_reached")
    serialized = _validate_workflow_definition(body.definition)
    _workflow_capabilities(db, user, body.definition, organization_id)
    row = OrganizationWorkflow(id=str(uuid4()), organization_id=organization_id, owner_id=user.id,
                               name=body.name, definition=serialized)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"id": row.id, "organizationId": row.organization_id, "name": row.name,
            "definition": json.loads(row.definition), "ownerId": row.owner_id,
            "updatedAt": row.updated_at.isoformat()}


@router.put("/{organization_id}/workflows/{workflow_id}")
def update_organization_workflow(organization_id: int, workflow_id: str, body: OrganizationWorkflowRequest,
                                db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    _require_org_access(db, organization_id, user)
    row = db.query(OrganizationWorkflow).filter(OrganizationWorkflow.id == workflow_id,
        OrganizationWorkflow.organization_id == organization_id).with_for_update().first()
    if row is None or not _workflow_can_manage(db, row, user):
        raise HTTPException(status_code=404, detail="workflow_template_not_found")
    serialized = _validate_workflow_definition(body.definition)
    _workflow_capabilities(db, user, body.definition, organization_id)
    row.name, row.definition = body.name, serialized
    row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(row)
    return {"id": row.id, "organizationId": row.organization_id, "name": row.name,
            "definition": json.loads(row.definition), "ownerId": row.owner_id,
            "updatedAt": row.updated_at.isoformat()}


@router.delete("/{organization_id}/workflows/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_organization_workflow(organization_id: int, workflow_id: str, db: Session = Depends(get_db),
                                 user: User = Depends(get_current_active_user)):
    _require_org_access(db, organization_id, user)
    row = db.query(OrganizationWorkflow).filter(OrganizationWorkflow.id == workflow_id,
        OrganizationWorkflow.organization_id == organization_id).first()
    if row is None or not _workflow_can_manage(db, row, user):
        raise HTTPException(status_code=404, detail="workflow_template_not_found")
    db.delete(row)
    db.commit()
