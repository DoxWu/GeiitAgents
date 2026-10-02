"""Authenticated ephemeral completions for the desktop workbench."""

import json
from contextlib import aclosing

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from app.api.deps import get_current_active_user
from app.core.rate_limit import rate_limit
from app.schemas.private_model import AccountCompletion, PrivateCompletion, PrivateModelList
from app.services.private_model import PrivateModelError, complete_private, stream_private, list_private_models
from app.services.account_model import account_model_status, can_use_account_model, complete_account, stream_account
from app.schemas.office_tools import AccountToolCompletion, PrivateToolCompletion
from app.services.office_tools import complete_account_tools, complete_private_tools

router = APIRouter(prefix="/private-models", tags=["个人模型"])
NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}
STREAM_HEADERS = {**NO_STORE, "X-Accel-Buffering": "no"}


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def read_payload(request: Request, schema, max_bytes: int = 1024 * 1024):
    # Manual validation avoids echoing secret-bearing input through global validation errors.
    try:
        payload = bytearray()
        async for chunk in request.stream():
            payload.extend(chunk)
            if len(payload) > max_bytes:
                raise HTTPException(413, "请求内容过大。", headers=NO_STORE)
        return schema.model_validate_json(payload)
    except (ValidationError, ValueError):
        raise HTTPException(422, "模型请求参数无效。", headers=NO_STORE) from None


@router.post("/tools/complete", dependencies=[Depends(get_current_active_user), Depends(rate_limit("private_model_tools", per_minute=20))])
async def private_tools(request: Request):
    data = await read_payload(request, PrivateToolCompletion)
    try:
        return JSONResponse(await complete_private_tools(data, request.headers.get("x-model-api-key", "")), headers=NO_STORE)
    except PrivateModelError as exc:
        raise HTTPException(exc.status, str(exc), headers=NO_STORE) from None


@router.post("/account/tools/complete", dependencies=[Depends(rate_limit("account_model_tools", per_minute=20))])
async def account_tools(request: Request, user=Depends(get_current_active_user)):
    if not can_use_account_model(user):
        raise HTTPException(403, "当前账号无权使用云端模型。", headers=NO_STORE)
    data = await read_payload(request, AccountToolCompletion)
    try:
        return JSONResponse(await complete_account_tools(data), headers=NO_STORE)
    except PrivateModelError as exc:
        raise HTTPException(exc.status, str(exc), headers=NO_STORE) from None


@router.post("/models", dependencies=[
    Depends(get_current_active_user), Depends(rate_limit("private_model_list", per_minute=20)),
])
async def model_list(request: Request):
    try:
        data = await read_payload(request, PrivateModelList)
        result = await list_private_models(data, request.headers.get("x-model-api-key", ""))
        return JSONResponse(result, headers=NO_STORE)
    except PrivateModelError as exc:
        raise HTTPException(exc.status, str(exc), headers=NO_STORE) from None
    except HTTPException as exc:
        exc.headers = {**(exc.headers or {}), **NO_STORE}
        raise


@router.post("/complete", dependencies=[
    Depends(get_current_active_user), Depends(rate_limit("private_model", per_minute=20)),
])
async def complete(request: Request):
    data = await read_payload(request, PrivateCompletion, 6 * 1024 * 1024)
    api_key = request.headers.get("x-model-api-key", "")
    try:
        result = await complete_private(data, api_key)
        return JSONResponse(result, headers=NO_STORE)
    except PrivateModelError as exc:
        raise HTTPException(exc.status, str(exc)) from None


@router.post("/complete/stream", dependencies=[
    Depends(get_current_active_user), Depends(rate_limit("private_model", per_minute=20)),
])
async def complete_stream(request: Request):
    data = await read_payload(request, PrivateCompletion, 6 * 1024 * 1024)
    api_key = request.headers.get("x-model-api-key", "")

    async def events():
        content = []
        completion = {}
        try:
            async with aclosing(stream_private(data, api_key, completion)) as stream:
                async for chunk in stream:
                    content.append(chunk)
                    yield sse({"type": "chunk", "content": chunk})
            yield sse({"type": "done", "content": "".join(content), "model": data.model, "finish_reason": completion.get("finish_reason", "unknown")})
        except PrivateModelError as exc:
            yield sse({"type": "error", "content": str(exc)})

    return StreamingResponse(events(), media_type="text/event-stream", headers=STREAM_HEADERS)


@router.get("/account", dependencies=[Depends(rate_limit("account_model_status", per_minute=60))])
async def account_status(user=Depends(get_current_active_user)):
    result = await account_model_status() if can_use_account_model(user) else {"available": False}
    return JSONResponse(result, headers=NO_STORE)


@router.post("/account/complete", dependencies=[Depends(rate_limit("account_model", per_minute=20))])
async def account_complete(request: Request, user=Depends(get_current_active_user)):
    if not can_use_account_model(user):
        raise HTTPException(403, "当前账号无权使用云端模型。")
    data = await read_payload(request, AccountCompletion, 6 * 1024 * 1024)
    try:
        return JSONResponse(await complete_account(data), headers=NO_STORE)
    except PrivateModelError as exc:
        raise HTTPException(exc.status, str(exc)) from None


@router.post("/account/complete/stream", dependencies=[Depends(rate_limit("account_model", per_minute=20))])
async def account_complete_stream(request: Request, user=Depends(get_current_active_user)):
    if not can_use_account_model(user):
        raise HTTPException(403, "当前账号无权使用云端模型。")
    data = await read_payload(request, AccountCompletion, 6 * 1024 * 1024)

    async def events():
        content = []
        completion = {}
        try:
            async with aclosing(stream_account(data, completion)) as stream:
                async for chunk in stream:
                    content.append(chunk)
                    yield sse({"type": "chunk", "content": chunk})
            yield sse({"type": "done", "content": "".join(content), "model": "账号云端模型", "finish_reason": completion.get("finish_reason", "unknown")})
        except PrivateModelError as exc:
            yield sse({"type": "error", "content": str(exc)})

    return StreamingResponse(events(), media_type="text/event-stream", headers=STREAM_HEADERS)
