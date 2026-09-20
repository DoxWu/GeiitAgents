"""Authenticated ephemeral completions for the desktop workbench."""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.api.deps import get_current_active_user
from app.core.rate_limit import rate_limit
from app.schemas.private_model import AccountCompletion, PrivateCompletion
from app.services.private_model import PrivateModelError, complete_private
from app.services.account_model import account_model_status, can_use_account_model, complete_account

router = APIRouter(prefix="/private-models", tags=["个人模型"])
NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


async def read_payload(request: Request, schema):
    # Manual validation avoids echoing secret-bearing input through global validation errors.
    try:
        payload = bytearray()
        async for chunk in request.stream():
            payload.extend(chunk)
            if len(payload) > 1024 * 1024:
                raise HTTPException(413, "请求内容过大。")
        return schema.model_validate_json(payload)
    except (ValidationError, ValueError):
        raise HTTPException(422, "模型请求参数无效。") from None


@router.post("/complete", dependencies=[
    Depends(get_current_active_user), Depends(rate_limit("private_model", per_minute=20)),
])
async def complete(request: Request):
    data = await read_payload(request, PrivateCompletion)
    api_key = request.headers.get("x-model-api-key", "")
    try:
        result = await complete_private(data, api_key)
        return JSONResponse(result, headers=NO_STORE)
    except PrivateModelError as exc:
        raise HTTPException(exc.status, str(exc)) from None


@router.get("/account", dependencies=[Depends(rate_limit("account_model_status", per_minute=60))])
async def account_status(user=Depends(get_current_active_user)):
    result = await account_model_status() if can_use_account_model(user) else {"available": False}
    return JSONResponse(result, headers=NO_STORE)


@router.post("/account/complete", dependencies=[Depends(rate_limit("account_model", per_minute=20))])
async def account_complete(request: Request, user=Depends(get_current_active_user)):
    if not can_use_account_model(user):
        raise HTTPException(403, "当前账号无权使用云端模型。")
    data = await read_payload(request, AccountCompletion)
    try:
        return JSONResponse(await complete_account(data), headers=NO_STORE)
    except PrivateModelError as exc:
        raise HTTPException(exc.status, str(exc)) from None
