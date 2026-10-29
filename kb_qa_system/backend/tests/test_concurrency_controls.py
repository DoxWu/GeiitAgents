import asyncio
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.document import Document
from app.models.user import User
from app.services import document_queue, request_concurrency
from app.services.rag_chain import RAGChainService
from app.tasks import document_tasks


class FakeAsyncRedis:
    def __init__(self):
        self.values = {}
        self.lock = threading.Lock()

    async def eval(self, script, numkeys, *args):
        keys = args[:numkeys]
        values = args[numkeys:]
        with self.lock:
            if script == request_concurrency._ACQUIRE_SCRIPT:
                per_user, global_limit, token, _ttl = values
                user_slot = next(
                    (i for i, key in enumerate(keys[:per_user]) if key not in self.values), None
                )
                offset = per_user
                global_slot = next(
                    (
                        offset + i
                        for i, key in enumerate(keys[offset : offset + global_limit])
                        if key not in self.values
                    ),
                    None,
                )
                if user_slot is None or global_slot is None:
                    return None
                self.values[keys[user_slot]] = token
                self.values[keys[global_slot]] = token
                return [user_slot + 1, global_slot + 1]
            if script == request_concurrency._RENEW_SCRIPT:
                token, _ttl = values
                return sum(self.values.get(key) == token for key in keys)
            if script == request_concurrency._RELEASE_SCRIPT:
                token = values[0]
                removed = 0
                for key in keys:
                    if self.values.get(key) == token:
                        del self.values[key]
                        removed += 1
                return removed
        raise AssertionError("unexpected Redis script")


@pytest.fixture
def fake_redis(monkeypatch):
    client = FakeAsyncRedis()
    monkeypatch.setattr(request_concurrency, "async_redis_client", client)
    monkeypatch.setattr(request_concurrency.RedisManager, "make_key", staticmethod(lambda key: key))
    return client


@pytest.mark.asyncio
async def test_request_leases_enforce_user_and_global_limits(fake_redis):
    first = await request_concurrency.acquire_lease("chat", 1, per_user=1, global_limit=1)
    assert first is not None
    assert await request_concurrency.acquire_lease("chat", 1, per_user=1, global_limit=1) is None
    assert await request_concurrency.acquire_lease("chat", 2, per_user=1, global_limit=1) is None
    assert await first.renew()
    await first.release()
    assert not fake_redis.values
    assert (
        await request_concurrency.acquire_lease("chat", 2, per_user=1, global_limit=1) is not None
    )


@pytest.mark.asyncio
async def test_request_dependency_holds_lease_until_stream_finishes(fake_redis):
    dependency = request_concurrency.concurrency_limit("chat", per_user=1, global_limit=1)
    stream_scope = dependency(SimpleNamespace(id=7))
    await anext(stream_scope)
    assert await request_concurrency.acquire_lease("chat", 7, per_user=1, global_limit=1) is None
    await stream_scope.aclose()
    assert (
        await request_concurrency.acquire_lease("chat", 7, per_user=1, global_limit=1) is not None
    )


def test_fastapi_stream_keeps_provider_slot_until_response_finishes(fake_redis):
    from app.api.deps import get_current_active_user

    app = FastAPI()
    app.dependency_overrides[get_current_active_user] = lambda: SimpleNamespace(id=7)
    dependency = request_concurrency.concurrency_limit("provider", per_user=1, global_limit=1)
    finish_stream = threading.Event()
    stream_started = threading.Event()

    @app.get("/stream", dependencies=[Depends(dependency, scope="request")])
    async def stream():
        async def body():
            stream_started.set()
            yield "started"
            await asyncio.to_thread(finish_stream.wait, 5)
            yield "finished"

        return StreamingResponse(body())

    @app.get("/provider", dependencies=[Depends(dependency, scope="request")])
    async def provider_request():
        return {"ok": True}

    stream_status = []

    def consume_stream():
        with TestClient(app) as client:
            stream_status.append(client.get("/stream").status_code)

    stream_thread = threading.Thread(target=consume_stream)
    stream_thread.start()
    try:
        assert stream_started.wait(5)
        with TestClient(app) as client:
            assert client.get("/provider").status_code == 429
    finally:
        finish_stream.set()
        stream_thread.join(timeout=5)

    assert not stream_thread.is_alive()
    assert stream_status == [200]


@pytest.mark.asyncio
async def test_request_dependency_fails_closed_when_redis_is_unavailable(monkeypatch):
    class BrokenRedis:
        async def eval(self, *_args):
            raise ConnectionError("synthetic")

    monkeypatch.setattr(request_concurrency, "async_redis_client", BrokenRedis())
    dependency = request_concurrency.concurrency_limit("chat", per_user=1, global_limit=1)
    with pytest.raises(HTTPException) as error:
        await anext(dependency(SimpleNamespace(id=1)))
    assert error.value.status_code == 503


@pytest.fixture
def queue_db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.add_all(
            [
                User(
                    id=1,
                    username="queue-user-1",
                    email="q1@example.test",
                    hashed_password="fixture",
                    is_active=True,
                    user_type="regular",
                ),
                User(
                    id=2,
                    username="queue-user-2",
                    email="q2@example.test",
                    hashed_password="fixture",
                    is_active=True,
                    user_type="regular",
                ),
            ]
        )
        db.commit()
        yield db
    engine.dispose()


def add_document(db, user_id, status="pending", *, deleted=False):
    row = Document(
        user_id=user_id,
        title=f"queued-{user_id}",
        file_name=f"queued-{user_id}.txt",
        file_path=f"/tmp/queued-{user_id}.txt",
        file_type=".txt",
        file_size=10,
        status=status,
        processing_step="queued",
        processing_progress=0,
        is_deleted=deleted,
    )
    db.add(row)
    db.commit()
    return row


def install_admission_lock(monkeypatch):
    released = []
    monkeypatch.setattr(
        document_queue.RedisManager, "acquire_lock", lambda *_args, **_kwargs: "admission-token"
    )
    monkeypatch.setattr(
        document_queue.RedisManager,
        "release_lock",
        lambda key, token: released.append((key, token)) or True,
    )
    monkeypatch.setattr(document_queue.RedisManager, "renew_lock", lambda *_args: True)
    return released


def test_document_admission_counts_pending_and_processing_per_user(queue_db, monkeypatch):
    released = install_admission_lock(monkeypatch)
    monkeypatch.setattr(document_queue.settings, "DOCUMENT_MAX_OUTSTANDING_PER_USER", 2)
    monkeypatch.setattr(document_queue.settings, "DOCUMENT_MAX_OUTSTANDING_GLOBAL", 10)
    add_document(queue_db, 1, "pending")
    add_document(queue_db, 1, "processing")

    with pytest.raises(HTTPException) as error:
        document_queue.acquire_document_admission(queue_db, 1)

    assert error.value.status_code == 429
    assert error.value.detail["error"]["code"] == "USER_DOCUMENT_QUEUE_FULL"
    assert len(released) == 1


def test_idle_document_capacity_allows_one_user_to_fill_worker_slots(queue_db, monkeypatch):
    released = install_admission_lock(monkeypatch)
    monkeypatch.setattr(document_queue.settings, "DOCUMENT_MAX_OUTSTANDING_PER_USER", 2)
    monkeypatch.setattr(document_queue.settings, "DOCUMENT_MAX_OUTSTANDING_GLOBAL", 4)

    for status in ("pending", "processing"):
        lease = document_queue.acquire_document_admission(queue_db, 1)
        add_document(queue_db, 1, status)
        document_queue.release_document_admission(lease)

    with pytest.raises(HTTPException) as error:
        document_queue.acquire_document_admission(queue_db, 1)

    assert error.value.detail["error"]["code"] == "USER_DOCUMENT_QUEUE_FULL"
    assert len(released) == 3


def test_document_admission_enforces_global_limit_and_ignores_deleted_rows(queue_db, monkeypatch):
    released = install_admission_lock(monkeypatch)
    monkeypatch.setattr(document_queue.settings, "DOCUMENT_MAX_OUTSTANDING_PER_USER", 3)
    monkeypatch.setattr(document_queue.settings, "DOCUMENT_MAX_OUTSTANDING_GLOBAL", 1)
    add_document(queue_db, 2, "pending")
    add_document(queue_db, 2, "processing", deleted=True)

    with pytest.raises(HTTPException) as error:
        document_queue.acquire_document_admission(queue_db, 1)

    assert error.value.status_code == 429
    assert error.value.detail["error"]["code"] == "DOCUMENT_QUEUE_FULL"
    assert len(released) == 1


def test_document_admission_can_exclude_its_own_active_row(queue_db, monkeypatch):
    install_admission_lock(monkeypatch)
    monkeypatch.setattr(document_queue.settings, "DOCUMENT_MAX_OUTSTANDING_PER_USER", 2)
    monkeypatch.setattr(document_queue.settings, "DOCUMENT_MAX_OUTSTANDING_GLOBAL", 4)
    own_row = add_document(queue_db, 1, "processing")

    lease = document_queue.acquire_document_admission(queue_db, 1, exclude_document_id=own_row.id)
    lease.ensure_valid()
    document_queue.release_document_admission(lease)


def test_document_admission_rejects_lost_lock_before_commit(monkeypatch):
    monkeypatch.setattr(document_queue.RedisManager, "renew_lock", lambda *_args: False)
    monkeypatch.setattr(document_queue.RedisManager, "release_lock", lambda *_args: True)
    lease = document_queue.DocumentAdmissionLease("lost-token", ttl_seconds=30)

    with pytest.raises(HTTPException) as error:
        lease.ensure_valid()

    assert error.value.status_code == 503
    lease.release()


def test_batch_document_task_dispatches_individually_with_admission(queue_db, monkeypatch):
    install_admission_lock(monkeypatch)
    monkeypatch.setattr(document_queue.settings, "DOCUMENT_MAX_OUTSTANDING_PER_USER", 2)
    monkeypatch.setattr(document_queue.settings, "DOCUMENT_MAX_OUTSTANDING_GLOBAL", 4)
    monkeypatch.setattr(
        document_tasks,
        "SessionLocal",
        sessionmaker(bind=queue_db.get_bind(), expire_on_commit=False),
    )
    documents = [add_document(queue_db, 1, "failed") for _ in range(3)]
    dispatched = []

    monkeypatch.setattr(
        document_tasks.process_document_task,
        "delay",
        lambda document_id: (
            dispatched.append(document_id) or SimpleNamespace(id=f"task-{document_id}")
        ),
    )

    result = document_tasks.batch_process_documents_task.run([row.id for row in documents])

    queue_db.expire_all()
    assert result["queued"] == 2
    assert result["failed"] == 1
    assert dispatched == [documents[0].id, documents[1].id]
    assert queue_db.get(Document, documents[0].id).status == "processing"
    assert queue_db.get(Document, documents[2].id).status == "failed"


def test_streaming_rag_offloads_sync_retrieval_and_postprocessing(monkeypatch):
    service = object.__new__(RAGChainService)
    monkeypatch.setattr("app.services.rag_chain.requires_medical_evidence", lambda _question: True)

    def blocking_result(*_args, **_kwargs):
        time.sleep(0.08)
        return [{"content": "evidence", "metadata": {"document_id": 1}, "score": 1.0}]

    monkeypatch.setattr(service, "retrieve_context", blocking_result)
    monkeypatch.setattr(service, "_medical_boundary_response", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(service, "_detect_conflicts", lambda *_args: time.sleep(0.08) or None)
    monkeypatch.setattr(
        service,
        "_validate_before_generation",
        lambda *_args: (
            time.sleep(0.08) or SimpleNamespace(should_generate=True, confidence="high", reason="")
        ),
    )
    monkeypatch.setattr(service, "_build_history", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(service, "_build_messages", lambda *_args: [])

    class FakeLLM:
        last_metrics = {}

        async def astream(self, _messages):
            yield "answer"

    monkeypatch.setattr(service, "_get_llm_service", lambda: FakeLLM())
    ticks = 0
    finished = False

    async def heartbeat():
        nonlocal ticks
        while not finished:
            ticks += 1
            await asyncio.sleep(0.005)

    async def run():
        nonlocal finished
        pulse = asyncio.create_task(heartbeat())
        events = [event async for event in service.ask_stream("question")]
        finished = True
        await pulse
        return events

    events = asyncio.run(run())
    assert ticks >= 20
    assert any(event["type"] == "chunk" and event["content"] == "answer" for event in events)
