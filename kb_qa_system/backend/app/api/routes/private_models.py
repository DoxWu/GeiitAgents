"""Authenticated ephemeral completions for the desktop workbench."""

import json
from contextlib import aclosing

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from app.api.deps import get_current_active_user
from app.core.rate_limit import rate_limit
from app.core.config import settings
from app.services.request_concurrency import concurrency_limit
from app.schemas.private_model import AccountCompletion, PrivateCompletion, PrivateImageGeneration, PrivateModelList
from app.services.private_model import PrivateModelError, complete_private, stream_private, list_private_models, generate_private_image
from app.services.account_model import account_model_status, can_use_account_model, complete_account, stream_account
from app.schemas.office_tools import AccountToolCompletion, PrivateToolCompletion
from app.services.office_tools import complete_account_tools, complete_private_tools
from app.schemas.image_generation import ServerImageRequest
from app.services.server_image_generation import ImageGenerationError, configured_image_endpoints, generate_server_image

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


@router.post("/tools/complete", dependencies=[
    Depends(get_current_active_user), Depends(rate_limit("private_model_tools", per_minute=20)),
    Depends(concurrency_limit("provider", per_user=settings.MODEL_MAX_CONCURRENT_PER_USER,
                               global_limit=settings.MODEL_MAX_CONCURRENT_GLOBAL), scope="request"),
])
async def private_tools(request: Request):
    data = await read_payload(request, PrivateToolCompletion)
    try:
        return JSONResponse(await complete_private_tools(data, request.headers.get("x-model-api-key", "")), headers=NO_STORE)
    except PrivateModelError as exc:
        raise HTTPException(exc.status, str(exc), headers=NO_STORE) from None


@router.post("/account/tools/complete", dependencies=[
    Depends(rate_limit("account_model_tools", per_minute=20)),
    Depends(concurrency_limit("provider", per_user=settings.MODEL_MAX_CONCURRENT_PER_USER,
                               global_limit=settings.MODEL_MAX_CONCURRENT_GLOBAL), scope="request"),
])
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
    Depends(concurrency_limit("provider", per_user=settings.MODEL_MAX_CONCURRENT_PER_USER,
                               global_limit=settings.MODEL_MAX_CONCURRENT_GLOBAL), scope="request"),
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


@router.post("/images/generate", dependencies=[
    Depends(get_current_active_user), Depends(rate_limit("private_model_image", per_minute=5)),
    Depends(concurrency_limit("image", per_user=settings.IMAGE_MAX_CONCURRENT_PER_USER,
                               global_limit=settings.IMAGE_MAX_CONCURRENT_GLOBAL), scope="request"),
])
async def generate_image(request: Request):
    data = await read_payload(request, PrivateImageGeneration, 16 * 1024)
    try:
        result = await generate_private_image(data, request.headers.get("x-model-api-key", ""))
        return JSONResponse(result, headers=NO_STORE)
    except PrivateModelError as exc:
        raise HTTPException(exc.status, str(exc), headers=NO_STORE) from None


@router.get("/server-images", dependencies=[Depends(get_current_active_user), Depends(rate_limit("server_image_status", per_minute=30))])
async def server_image_models():
    return JSONResponse({"models": configured_image_endpoints()}, headers=NO_STORE)


@router.post("/server-images/generate", dependencies=[
    Depends(get_current_active_user), Depends(rate_limit("server_image_generate", per_minute=5)),
    Depends(concurrency_limit("image", per_user=settings.IMAGE_MAX_CONCURRENT_PER_USER,
                               global_limit=settings.IMAGE_MAX_CONCURRENT_GLOBAL), scope="request"),
])
async def generate_server_configured_image(request: Request):
    data = await read_payload(request, ServerImageRequest, 16 * 1024)
    if not data.consent:
        raise HTTPException(400, "发送图片描述到服务端模型前需要明确授权。", headers=NO_STORE)
    try:
        result = await generate_server_image(data.endpoint_id, data.prompt)
        return JSONResponse(result, headers=NO_STORE)
    except ImageGenerationError as exc:
        raise HTTPException(502, str(exc), headers=NO_STORE) from None


@router.post("/complete", dependencies=[
    Depends(get_current_active_user), Depends(rate_limit("private_model", per_minute=20)),
    Depends(concurrency_limit("provider", per_user=settings.MODEL_MAX_CONCURRENT_PER_USER,
                               global_limit=settings.MODEL_MAX_CONCURRENT_GLOBAL), scope="request"),
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
    Depends(concurrency_limit("provider", per_user=settings.MODEL_MAX_CONCURRENT_PER_USER,
                               global_limit=settings.MODEL_MAX_CONCURRENT_GLOBAL), scope="request"),
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


@router.post("/account/complete", dependencies=[
    Depends(rate_limit("account_model", per_minute=20)),
    Depends(concurrency_limit("provider", per_user=settings.MODEL_MAX_CONCURRENT_PER_USER,
                               global_limit=settings.MODEL_MAX_CONCURRENT_GLOBAL), scope="request"),
])
async def account_complete(request: Request, user=Depends(get_current_active_user)):
    if not can_use_account_model(user):
        raise HTTPException(403, "当前账号无权使用云端模型。")
    data = await read_payload(request, AccountCompletion, 6 * 1024 * 1024)
    try:
        return JSONResponse(await complete_account(data), headers=NO_STORE)
    except PrivateModelError as exc:
        raise HTTPException(exc.status, str(exc)) from None


@router.post("/account/complete/stream", dependencies=[
    Depends(rate_limit("account_model", per_minute=20)),
    Depends(concurrency_limit("provider", per_user=settings.MODEL_MAX_CONCURRENT_PER_USER,
                               global_limit=settings.MODEL_MAX_CONCURRENT_GLOBAL), scope="request"),
])
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
