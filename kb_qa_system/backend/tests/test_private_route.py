"""Exercise the actual router with isolated auth/rate-limit dependencies."""
import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


def test_authenticated_route_validation_no_cache_and_key_header():
    def auth():
        raise HTTPException(401, "Authentication required")
    def rate_limit(*args, **kwargs):
        return lambda: None
    deps = types.ModuleType("app.api.deps")
    deps.get_current_active_user = auth
    limits = types.ModuleType("app.core.rate_limit")
    limits.rate_limit = rate_limit
    path = Path(__file__).parents[1] / "app/api/routes/private_models.py"
    spec = importlib.util.spec_from_file_location("isolated_private_route", path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"app.api.deps": deps, "app.core.rate_limit": limits}):
        spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix="/api/v1")
    client = TestClient(app)
    url = "/api/v1/private-models/complete"
    body = {"base_url": "https://models.example/v1", "model": "test", "messages": [{"role": "user", "content": "hello"}]}
    assert client.post(url, json=body).status_code == 401
    app.dependency_overrides[auth] = lambda: object()
    completion = AsyncMock(return_value={"content": "done", "model": "test"})
    with patch.object(module, "complete_private", completion):
        response = client.post(url, json=body, headers={"X-Model-Api-Key": "fixture-private-key"})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {"content": "done", "model": "test"}
        assert completion.await_args.args[1] == "fixture-private-key"
        invalid = client.post(url, json={**body, "api_key": "fixture-private-key"})
        assert invalid.status_code == 422
        assert "fixture-private-key" not in invalid.text
        oversized = client.post(url, content=b"x" * (1024 * 1024 + 1))
        assert oversized.status_code == 413
        assert completion.await_count == 1

    status = AsyncMock(return_value={"available": True, "model": "server-model"})
    account_completion = AsyncMock(return_value={"content": "cloud reply", "model": "server-model"})
    with patch.object(module, "account_model_status", status), patch.object(module, "complete_account", account_completion):
        account_url = "/api/v1/private-models/account"
        app.dependency_overrides.clear()
        assert client.get(account_url).status_code == 401
        assert client.post(account_url + "/complete", json={"messages": body["messages"]}).status_code == 401
        app.dependency_overrides[auth] = lambda: types.SimpleNamespace(is_active=True, is_superuser=False, user_type="guest")
        assert client.get(account_url).json() == {"available": False}
        assert client.post(account_url + "/complete", json={"messages": body["messages"]}).status_code == 403
        status.assert_not_called(); account_completion.assert_not_called()
        app.dependency_overrides[auth] = lambda: types.SimpleNamespace(is_active=True, is_superuser=False, user_type="regular")
        assert client.get(account_url).json() == {"available": True, "model": "server-model"}
        response = client.post(account_url + "/complete", json={"messages": body["messages"]})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["content"] == "cloud reply"
        assert client.post(account_url + "/complete", json=body).status_code == 422
        assert account_completion.await_count == 1
