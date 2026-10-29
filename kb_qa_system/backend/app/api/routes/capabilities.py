"""Capability approval, visibility and per-call authorization."""
import asyncio
import json
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import or_
from sqlalchemy.orm import Session
from app.api.deps import get_current_active_user, get_current_regular_user
from app.api.routes.agents import AgentRoute
from app.core.database import get_db
from app.models.capability import SharedCapability
from app.models.organization import Organization, OrganizationMembership
from app.models.user import User
from app.schemas.capability import CapabilityPublish, CapabilitySpec, McpCall
from app.services.mcp_client import call_mcp
from app.services.request_concurrency import concurrency_limit
from app.services.audit_service import audit_service

router = APIRouter(prefix="/capabilities", tags=["能力仓库"], route_class=AgentRoute)


def membership(db, user, organization_id):
    return db.query(OrganizationMembership).join(Organization).filter(
        OrganizationMembership.organization_id == organization_id,
        OrganizationMembership.user_id == user.id, OrganizationMembership.status == "active",
        Organization.is_active.is_(True)).first()


def can_review(db, user, org_id):
    member = membership(db, user, org_id) if org_id else None
    return user.is_superuser or bool(member and member.role == "org_admin")


def visible(db, user, item):
    owner = db.query(User).filter(User.id == item.owner_id, User.is_active.is_(True)).first()
    organization_active = item.organization_id is None or db.query(Organization).filter(Organization.id == item.organization_id, Organization.is_active.is_(True)).first() is not None
    return bool(owner and organization_active and item.status == "published" and (
        user.is_superuser or item.organization_id is None or membership(db, user, item.organization_id)))


def require_capability(db, user, resource_id):
    if not db.query(User).filter(User.id == user.id, User.is_active.is_(True)).first():
        raise HTTPException(404, "capability_not_available")
    item = db.query(SharedCapability).filter(SharedCapability.id == str(resource_id)).first()
    if item is None or not visible(db, user, item):
        raise HTTPException(404, "capability_not_available")
    return item


def output(item):
    return {"id": item.id, "organizationId": item.organization_id, "ownerId": item.owner_id,
            "status": item.status, "resource": json.loads(item.definition)}


@router.get("")
def list_resources(db: Session = Depends(get_db), user=Depends(get_current_active_user)):
    # Visibility is checked before the bounded response, including owners who left an organization.
    orgs = [row[0] for row in db.query(OrganizationMembership.organization_id).join(Organization).filter(
        OrganizationMembership.user_id == user.id, OrganizationMembership.status == "active", Organization.is_active.is_(True)).all()]
    scope = True if user.is_superuser else or_(SharedCapability.organization_id.is_(None), SharedCapability.organization_id.in_(orgs))
    query = db.query(SharedCapability).filter(scope)
    if not user.is_superuser:
        query = query.join(User, User.id == SharedCapability.owner_id).filter(User.is_active.is_(True))
        admin_orgs = [oid for oid in orgs if can_review(db, user, oid)]
        query = query.filter(or_(SharedCapability.status == "published", SharedCapability.owner_id == user.id, SharedCapability.organization_id.in_(admin_orgs)))
    return [output(item) for item in query.order_by(SharedCapability.created_at.desc()).limit(100).all()]


@router.post("", status_code=201)
def publish(body: CapabilityPublish, db: Session = Depends(get_db), user=Depends(get_current_regular_user)):
    if body.organizationId and not user.is_superuser and not membership(db, user, body.organizationId):
        raise HTTPException(403, "organization_membership_required")
    if body.organizationId and not db.query(Organization).filter(Organization.id == body.organizationId, Organization.is_active.is_(True)).first():
        raise HTTPException(404, "organization_not_found")
    db.query(User).filter(User.id == user.id).with_for_update().one()
    if db.query(SharedCapability).filter(SharedCapability.owner_id == user.id).count() >= 100:
        raise HTTPException(409, "capability_limit_reached")
    resource = body.resource.model_copy(deep=True)
    resource.sharedId = None
    if resource.fn:
        resource.fn.reviewed = False
    item = SharedCapability(id=str(uuid4()), owner_id=user.id, organization_id=body.organizationId,
        status="published" if can_review(db, user, body.organizationId) else "pending",
        definition=resource.model_dump_json(by_alias=True, exclude_none=True))
    db.add(item)
    db.commit()
    db.refresh(item)
    audit_service.log(db, user.id, 'capability.publish', 'capability', detail={'resource_id': item.id, 'organization_id': item.organization_id, 'status': item.status})
    return output(item)


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    approved: bool


@router.post("/{resource_id}/review")
def review(resource_id: str, body: Decision, db: Session = Depends(get_db), user=Depends(get_current_active_user)):
    item = db.query(SharedCapability).filter(SharedCapability.id == resource_id).with_for_update().first()
    if not item or not can_review(db, user, item.organization_id):
        raise HTTPException(404, "capability_not_found")
    item.status, item.reviewed_by = ("published" if body.approved else "disabled"), user.id
    db.commit()
    audit_service.log(db, user.id, 'capability.review', 'capability', detail={'resource_id': item.id, 'status': item.status})
    return output(item)


@router.delete("/{resource_id}", status_code=204)
def disable(resource_id: str, db: Session = Depends(get_db), user=Depends(get_current_active_user)):
    item = db.query(SharedCapability).filter(SharedCapability.id == resource_id).first()
    if not item or not (can_review(db, user, item.organization_id) or item.owner_id == user.id and (item.organization_id is None or membership(db, user, item.organization_id))):
        raise HTTPException(404, "capability_not_found")
    item.status = "disabled"
    db.commit()
    audit_service.log(db, user.id, 'capability.disable', 'capability', detail={'resource_id': item.id})


@router.get("/{resource_id}")
def get_resource(resource_id: str, db: Session = Depends(get_db), user=Depends(get_current_active_user)):
    return output(require_capability(db, user, resource_id))


def check_values(values, fields):
    if set(values) - {field.key for field in fields}:
        raise ValueError("Unknown field")
    for field in fields:
        if field.key not in values and not field.required:
            continue
        value = values.get(field.key)
        valid = (field.type == "string" and isinstance(value, str) and len(value) <= 50000
            or field.type == "boolean" and type(value) is bool
            or field.type == "number" and type(value) in (int, float) and __import__('math').isfinite(value))
        if not valid:
            raise ValueError("Invalid contract value")


@router.post("/{resource_id}/call", dependencies=[Depends(concurrency_limit("mcp", per_user=2, global_limit=8))])
async def call(resource_id: str, body: McpCall, db: Session = Depends(get_db), user=Depends(get_current_regular_user)):
    item = require_capability(db, user, resource_id)
    resource = CapabilitySpec.model_validate_json(item.definition)
    if not body.consent or resource.kind != "mcp":
        raise HTTPException(403, "mcp_consent_required")
    try:
        check_values(body.inputs, resource.inputFields)
        db.rollback()  # Release the read transaction before outbound I/O.
        audit_service.log(db, user.id, 'capability.call_started', 'capability', detail={'resource_id': resource_id})
        result = await asyncio.wait_for(asyncio.to_thread(call_mcp, resource.endpoint, resource.toolName, body.inputs), 25)
        check_values(result, resource.outputFields)
        require_capability(db, user, resource_id)  # Revocation during the request fences its result.
        audit_service.log(db, user.id, 'capability.call_succeeded', 'capability', detail={'resource_id': resource_id})
        return {"output": result}
    except HTTPException:
        raise
    except Exception:
        audit_service.log(db, user.id, 'capability.call_failed', 'capability', detail={'resource_id': resource_id})
        raise HTTPException(422, "mcp_call_failed_or_invalid_contract") from None
