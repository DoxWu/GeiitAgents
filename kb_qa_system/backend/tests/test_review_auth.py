"""HTTP/token/WS regression tests with isolated DB and Redis boundaries."""
import asyncio
import importlib.util
import json
import threading
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, WebSocketDisconnect
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_active_user
from app.core import security
from app.core.database import Base, get_db
from app.core.redis import RedisManager
from app.models import User


def load_route(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / 'app/api' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def auth_fixture(monkeypatch):
    module = load_route('review_auth', 'routes/auth.py')
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Base.metadata.tables[n] for n in ['users', 'registration_applications']])
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.add(User(id=1, username='fixture', email='fixture@example.test', hashed_password='fixture', is_active=True))
        db.commit()
    values = {}
    lock = threading.Lock()
    def once(key, value, ttl):
        with lock:
            if key in values:
                return False
            values[key] = value
            return True
    def many(entries):
        with lock:
            values.update({key: value for key, value, ttl in entries})
        return True
    monkeypatch.setattr(RedisManager, 'exists_strict', lambda key: key in values)
    monkeypatch.setattr(RedisManager, 'set_once_strict', once)
    monkeypatch.setattr(RedisManager, 'set_many_strict', many)
    monkeypatch.setattr(RedisManager, 'acquire_lock', lambda *a, **k: 'fixture-lock')
    monkeypatch.setattr(RedisManager, 'release_lock', lambda *a: True)
    monkeypatch.setattr(RedisManager, 'increment', lambda *a, **k: 1)
    app = FastAPI()
    app.include_router(module.router)
    def database():
        with factory() as db:
            yield db
    def user():
        with factory() as db:
            return db.get(User, 1)
    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_active_user] = user
    with TestClient(app) as client:
        yield SimpleNamespace(module=module, client=client, values=values, factory=factory)
    engine.dispose()


def test_same_second_tokens_are_unique():
    for create in (security.create_access_token, security.create_refresh_token):
        tokens = [create({'sub': '1', 'jti': 'untrusted'}) for _ in range(100)]
        assert len(set(tokens)) == 100


def test_immediate_refresh_replay_and_session_logout(auth_fixture):
    f = auth_fixture
    access, refresh, _ = security.create_token_pair(1, 'fixture')
    response = f.client.post('/auth/refresh', json={'refresh_token': refresh})
    assert response.status_code == 200, response.text
    rotated = response.json()
    assert rotated['refresh_token'] != refresh
    assert f.client.post('/auth/refresh', json={'refresh_token': refresh}).status_code == 401
    result = f.client.post('/auth/logout', headers={'Authorization': f'Bearer {access}'},
                          json={'refresh_token': rotated['refresh_token']})
    assert result.status_code == 200, result.text
    assert security.is_token_blacklisted(rotated['access_token'])
    assert f.client.post('/auth/refresh', json={'refresh_token': rotated['refresh_token']}).status_code == 401
    other_access, _, _ = security.create_token_pair(1, 'fixture')
    assert not security.is_token_blacklisted(other_access)


@pytest.mark.parametrize('operation', ['refresh', 'logout'])
def test_revocation_write_error_never_returns_success(auth_fixture, monkeypatch, operation):
    def broken(*args):
        raise ConnectionError('synthetic Redis failure')
    monkeypatch.setattr(RedisManager, 'set_once_strict', broken)
    monkeypatch.setattr(RedisManager, 'set_many_strict', broken)
    access, refresh, _ = security.create_token_pair(1, 'fixture')
    response = auth_fixture.client.post('/auth/' + operation,
        headers={'Authorization': f'Bearer {access}'}, json={'refresh_token': refresh})
    assert response.status_code == 503
    assert response.json()['detail']['error']['code'] in ('AUTH_SERVICE_UNAVAILABLE', 'LOGOUT_NOT_CONFIRMED')
    assert 'access_token' not in response.json()


def test_unacknowledged_logout_is_not_success(auth_fixture, monkeypatch):
    monkeypatch.setattr(RedisManager, 'set_many_strict', lambda _: False)
    access, _, _ = security.create_token_pair(1, 'fixture')
    assert auth_fixture.client.post('/auth/logout', headers={'Authorization': f'Bearer {access}'}).status_code == 503


def test_refresh_remains_atomic_after_request_lock_expiry(auth_fixture):
    token = security.create_refresh_token({'sub': '1'})
    payload = security.decode_refresh_token(token)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(lambda _: security.consume_refresh_token(token, payload), range(30)))
    assert sum(results) == 1


def test_ws_rejects_bearer_and_consumed_ticket(auth_fixture, monkeypatch):
    ws = load_route('review_ws', 'ws_notifications.py')
    monkeypatch.setattr(ws, 'SessionLocal', auth_fixture.factory)
    ticket_values = {}
    def set_ticket(key, value, **kwargs):
        ticket_values[key] = value
        return True
    def evaluate(script, count, key, *args):
        if 'zremrangebyscore' in script:
            return 1
        return ticket_values.pop(key, None)
    monkeypatch.setattr(ws, 'redis_client', SimpleNamespace(set=set_ticket, eval=evaluate, zrem=lambda *a: 1))
    app = FastAPI()
    app.include_router(ws.router)
    app.dependency_overrides[get_current_active_user] = lambda: User(id=1, is_active=True)
    access = security.create_access_token({'sub': '1'})
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/ws/notifications?token=' + access):
                pass
        result = client.post(ws.settings.API_V1_PREFIX + '/auth/ws-ticket', headers={'Authorization': f'Bearer {access}'})
        assert result.status_code == 200
        assert result.headers['cache-control'] == 'no-store'
        ticket = result.json()['ticket']
        # Revocation is checked at use time, not only when the ticket is issued.
        auth_fixture.values[security.RedisKeys.token_blacklist(access)] = '1'
        for _ in range(2):
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect('/ws/notifications?ticket=' + ticket):
                    pass
        assert not ticket_values


def test_ws_active_user_checks_expiry_disable_and_revocation(auth_fixture, monkeypatch):
    ws = load_route('review_ws_active', 'ws_notifications.py')
    monkeypatch.setattr(ws, 'SessionLocal', auth_fixture.factory)
    token = security.create_access_token({'sub': '1'})
    assert ws._active_user(token) == 1
    assert ws._active_user(security.create_access_token({'sub': '1'}, timedelta(seconds=-1))) is None
    with auth_fixture.factory() as db:
        db.get(User, 1).is_active = False
        db.commit()
    assert ws._active_user(token) is None
    assert ws._active_user(security.create_access_token({'sub': '999'})) is None


def test_ws_origin_must_match_configuration():
    ws = load_route('review_ws_origin', 'ws_notifications.py')
    assert not ws._allowed_origin('https://untrusted.example.test')
