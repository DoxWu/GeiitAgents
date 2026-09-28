"""Account access to the existing server-managed text provider."""
import asyncio
from contextlib import aclosing
from collections.abc import AsyncGenerator

from app.schemas.private_model import AccountCompletion
from app.services.private_model import PrivateModelError


def can_use_account_model(user) -> bool:
    return bool(user.is_active and (user.is_superuser or getattr(user, "user_type", "regular") == "regular"))


def select_account_client():
    from app.core.model_provider import get_model_manager
    return get_model_manager().get_text_client()


def model_messages(request):
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
    classes = {"user": HumanMessage, "assistant": AIMessage, "system": SystemMessage}
    return [classes[item.role](content=item.content) for item in request.messages]


async def account_model_status() -> dict:
    try:
        client = await asyncio.to_thread(select_account_client)
        return {"available": True, "model": client.config.model}
    except Exception:
        return {"available": False}


async def complete_account(request: AccountCompletion) -> dict:
    try:
        async with asyncio.timeout(120):
            client = await asyncio.to_thread(select_account_client)
            chunks = []
            size = 0
            # Use the existing provider's defaults without changing shared config.
            async with aclosing(client.astream(model_messages(request))) as stream:
                async for chunk in stream:
                    size += len(chunk.encode("utf-8"))
                    if size > 2 * 1024 * 1024:
                        raise PrivateModelError(502, "模型响应超过大小限制。")
                    chunks.append(chunk)
            content = "".join(chunks)
            if not content.strip():
                raise ValueError
            return {"content": content, "model": client.config.model}
    except PrivateModelError:
        raise
    except Exception:
        raise PrivateModelError(502, "账号云端模型暂不可用，请稍后重试。") from None


async def stream_account(request: AccountCompletion) -> AsyncGenerator[str, None]:
    """Yield chunks from the existing account-managed provider."""
    try:
        async with asyncio.timeout(120):
            client = await asyncio.to_thread(select_account_client)
            size = 0
            emitted = False
            async with aclosing(client.astream(model_messages(request))) as stream:
                async for chunk in stream:
                    size += len(chunk.encode("utf-8"))
                    if size > 2 * 1024 * 1024:
                        raise PrivateModelError(502, "模型响应超过大小限制。")
                    if chunk:
                        emitted = True
                        yield chunk
            if not emitted:
                raise PrivateModelError(502, "账号云端模型暂不可用，请稍后重试。")
    except PrivateModelError:
        raise
    except Exception:
        raise PrivateModelError(502, "账号云端模型暂不可用，请稍后重试。") from None
