"""Administrator maintenance interfaces; long work runs in the durable ops queue."""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_current_superuser
from app.ops.config import OpsSettings
from app.ops import jobs
from app.ops.postgres import OpsError

class MaintenanceRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def safe_handler(request):
            try:
                result = await handler(request)
            except RequestValidationError:
                # Never echo unexpected connection strings/credentials in invalid input.
                result = JSONResponse(status_code=422, content={"detail": {"code": "invalid_request"}})
            except HTTPException as exc:
                result = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)
            result.headers["Cache-Control"] = "no-store"
            return result
        return safe_handler


router = APIRouter(prefix="/admin/maintenance", tags=["备份与恢复"], route_class=MaintenanceRoute,
                   dependencies=[Depends(get_current_superuser)])


def config():
    # HTTP requests only inspect/enqueue; tools run in the independently configured worker.
    try:
        return OpsSettings().model_copy(update={"DB_OPERATION_TIMEOUT_SECONDS": 10})
    except Exception:
        raise HTTPException(503, detail={"code": "maintenance_configuration_invalid"}) from None


def call(response, function, *args, **kwargs):
    response.headers["Cache-Control"] = "no-store"
    try:
        return function(*args, **kwargs)
    except jobs.MaintenanceError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code}, headers={"Cache-Control": "no-store"}) from None
    except OpsError:
        raise HTTPException(409, detail={"code": "operation_precondition_failed"}, headers={"Cache-Control": "no-store"}) from None
    except Exception:
        raise HTTPException(503, detail={"code": "maintenance_unavailable"}, headers={"Cache-Control": "no-store"}) from None


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["backup", "verify", "restore"]
    request_id: UUID
    snapshot_id: str | None = Field(None, pattern=r"^[a-f0-9]{32}$")
    target_stamp: str | None = Field(None, pattern=r"^[a-f0-9]{64}$")
    confirmation: str | None = Field(None, max_length=64)


class RestorePlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot_id: str = Field(pattern=r"^[a-f0-9]{32}$")


@router.get("/status")
def get_status(response: Response, cfg=Depends(config)):
    return call(response, jobs.status, cfg)


@router.get("/snapshots")
def list_snapshots(response: Response, limit: int = Query(50, ge=1, le=100), cfg=Depends(config)):
    return call(response, jobs.snapshots, cfg, limit)


@router.get("/jobs")
def list_jobs(response: Response, limit: int = Query(50, ge=1, le=100), cfg=Depends(config)):
    return call(response, jobs.jobs, cfg, limit)


@router.post("/restore-plan")
def plan_restore(body: RestorePlanRequest, response: Response, cfg=Depends(config)):
    return call(response, jobs.restore_plan, cfg, body.snapshot_id)


@router.get("/jobs/{job_id}")
def get_job(job_id: UUID, response: Response, cfg=Depends(config)):
    return call(response, jobs.get_job, cfg, job_id.hex)


@router.post("/jobs", status_code=202)
def create_job(body: JobRequest, response: Response, admin=Depends(get_current_superuser), cfg=Depends(config)):
    return call(response, jobs.submit, cfg, kind=body.kind, request_id=str(body.request_id),
                actor_id=admin.id, snapshot_id=body.snapshot_id, stamp=body.target_stamp,
                confirmation=body.confirmation)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: UUID, response: Response, cfg=Depends(config)):
    return call(response, jobs.cancel, cfg, job_id.hex)
