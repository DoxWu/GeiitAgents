import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.schemas.private_model import AccountCompletion
from app.services.account_model import can_use_account_model, account_model_status, complete_account
from app.services.private_model import PrivateModelError


@pytest.mark.parametrize("active,admin,kind,allowed", [(True,False,"regular",True),(True,False,"guest",False),(False,True,"regular",False),(True,True,"guest",True),(True,False,"unknown",False)])
def test_account_permissions(active, admin, kind, allowed):
    assert can_use_account_model(SimpleNamespace(is_active=active,is_superuser=admin,user_type=kind)) is allowed


def test_uses_existing_provider_and_keeps_credentials_out_of_status():
    async def stream(messages):
        assert messages == ["converted"]
        yield "hello "
        yield "world"
    provider = SimpleNamespace(config=SimpleNamespace(model="server-model", api_key="secret-fixture"), astream=stream)
    async def run():
        with patch("app.services.account_model.select_account_client", return_value=provider), patch("app.services.account_model.model_messages", return_value=["converted"]):
            assert await account_model_status() == {"available": True, "model": "server-model"}
            result = await complete_account(AccountCompletion(messages=[{"role":"user","content":"hi"}]))
            assert result == {"content":"hello world", "model":"server-model"}
    asyncio.run(run())


def test_unavailable_provider_has_generic_error():
    async def run():
        with patch("app.services.account_model.select_account_client", side_effect=RuntimeError("secret-fixture")):
            assert await account_model_status() == {"available":False}
            with pytest.raises(PrivateModelError) as error:
                await complete_account(AccountCompletion(messages=[{"role":"user","content":"hi"}]))
            assert "secret-fixture" not in str(error.value)
    asyncio.run(run())
