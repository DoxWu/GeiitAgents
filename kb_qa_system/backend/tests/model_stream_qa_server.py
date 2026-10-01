"""Loopback-only synthetic workbench HTTP fixture; real routes and transports.

No database, real account, provider registry, credentials, retries or mail.
Only the frontend stream QA runner should launch this module.
"""
import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from app.services import account_model, private_model
from app.core.model_provider.clients.openai_text import OpenAITextClient

upstream = os.environ["MODEL_STREAM_QA_UPSTREAM"]
if not upstream.startswith("http://127.0.0.1:") or not upstream.rsplit(":", 1)[1].isdigit():
    raise ValueError("Fixture must use a loopback port")
user = {"id": 1, "username": "stream-qa", "email": "stream@example.test", "is_active": True, "is_superuser": False, "user_type": "regular"}


def auth(request: Request):
    if request.headers.get("authorization") != "Bearer stream-account-fixture":
        raise HTTPException(401, "Fixture authentication required")
    return SimpleNamespace(**user)


async def endpoint(base_url, resource="chat/completions"):
    if base_url != "https://models.example/v1" or resource not in ("models", "chat/completions"):
        raise private_model.PrivateModelError(400, "Unexpected fixture endpoint")
    return upstream + "/v1/" + resource, "models.example", "models.example"


selected = SimpleNamespace(config=SimpleNamespace(api_base=upstream + "/v1", api_key="native-stream-fixture-key", model="native-chat", temperature=0.25), breaker=Mock())
selected.breaker.is_open.return_value = False
selected.astream_workbench = lambda messages, completion: OpenAITextClient.astream_workbench(selected, messages, completion)
account_model.select_account_client = lambda: selected
private_model.public_endpoint = endpoint
deps, limits = ModuleType("app.api.deps"), ModuleType("app.core.rate_limit")
deps.get_current_active_user = auth
limits.rate_limit = lambda *args, **kwargs: lambda: None
spec = importlib.util.spec_from_file_location("qa_private_routes", Path(__file__).parents[1] / "app/api/routes/private_models.py")
routes = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"app.api.deps": deps, "app.core.rate_limit": limits}):
    spec.loader.exec_module(routes)
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(routes.router, prefix="/api/v1")


@app.get("/healthz")
def health():
    return {"fixture": "workbench-stream-only"}


@app.get("/api/v1/auth/me")
def me():
    return user


@app.get("/api/v1/private-models/account")
def account():
    return {"available": True, "model": "native-chat"}


@app.get("/api/v1/{path:path}")
def other(path: str):
    return {}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ["MODEL_STREAM_QA_PORT"]), log_level="warning", access_log=False)
