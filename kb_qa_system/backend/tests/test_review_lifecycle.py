"""Real HTTP/SQLite transactions and filesystem failure injection."""
import hashlib
import importlib.util
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_active_user, get_current_regular_user
from app.core.database import Base, get_db
from app.core.redis import RedisManager
from app.models import (
    AuditLog,
    Conversation,
    Document,
    DocumentChunk,
    EmailLog,
    FileCleanupJob,
    Note,
    QAEvent,
    Reminder,
    ReminderDelivery,
    Todo,
    User,
)
from app.services.document_lifecycle import activate_replacement
from app.services.file_cleanup import run_cleanup


def load_route(name, path):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / 'app/api/routes' / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def fixture(monkeypatch, tmp_path):
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    event.listen(engine, 'connect', lambda connection, _: connection.execute('PRAGMA foreign_keys=ON'))
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.add_all([User(id=i, username=f'user{i}', email=f'user{i}@example.test', hashed_password='fixture',
                          is_active=True, user_type='regular') for i in [1, 2]])
        db.commit()
    auth = load_route('review_lifecycle_auth', 'auth.py')
    docs = load_route('review_lifecycle_docs', 'documents.py')
    monkeypatch.setattr(auth.settings, 'UPLOAD_DIR', str(tmp_path))
    monkeypatch.setattr(docs.document_processor, 'compute_file_hash',
                        lambda file_path: hashlib.sha256(Path(file_path).read_bytes()).hexdigest())
    monkeypatch.setattr(auth, 'verify_password', lambda *args: True)
    monkeypatch.setattr(auth, 'blacklist_token', lambda *args, **kwargs: True)
    monkeypatch.setattr(RedisManager, 'increment', lambda *args, **kwargs: 1)
    monkeypatch.setattr(RedisManager, 'acquire_lock', lambda *args, **kwargs: 'fixture-lock')
    monkeypatch.setattr(RedisManager, 'release_lock', lambda *args: True)
    from app.tasks.document_tasks import process_document_task
    monkeypatch.setattr(process_document_task, 'delay', lambda *args: SimpleNamespace(id='fixture-task'))
    state = {'fail_commit': False}
    def database():
        with factory() as db:
            if state['fail_commit']:
                db.commit = Mock(side_effect=RuntimeError('synthetic DB failure'))
            yield db
    def user():
        with factory() as db:
            return db.get(User, 1)
    app = FastAPI()
    app.include_router(auth.router)
    app.include_router(docs.router)
    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_active_user] = user
    app.dependency_overrides[get_current_regular_user] = user
    with TestClient(app, raise_server_exceptions=False) as client:
        yield SimpleNamespace(client=client, factory=factory, state=state, auth=auth, docs=docs, root=tmp_path)
    engine.dispose()


def seed_document(f, name='report.txt'):
    path = f.root / name
    path.write_bytes(b'synthetic report')
    with f.factory() as db:
        document = Document(user_id=1, title='Report', file_name=name, file_type='.txt', file_size=16,
            file_path=str(path), file_hash=hashlib.sha256(path.read_bytes()).hexdigest(), status='completed')
        db.add(document)
        db.flush()
        db.add(DocumentChunk(document_id=document.id, chunk_index=0, content='original indexed content'))
        db.commit()
        return document.id


def test_account_commit_failure_keeps_files_and_qa(fixture):
    f = fixture
    doc_id = seed_document(f)
    f.state['fail_commit'] = True
    response = f.client.request('DELETE', '/auth/account', json={'password': 'fixture'})
    assert response.status_code == 500
    assert (f.root / 'report.txt').exists()
    with f.factory() as db:
        assert db.get(User, 1)
        assert db.get(Document, doc_id)
        assert db.query(FileCleanupJob).count() == 0


def test_account_delete_erases_payloads_and_queues_files(fixture, monkeypatch):
    f = fixture
    doc_id = seed_document(f)
    image_dir = f.root / f'images_{doc_id}'
    image_dir.mkdir()
    (image_dir / 'image.png').write_bytes(b'fixture')
    with f.factory() as db:
        db.add(QAEvent(user_id=1, question='personal secret', answer='private', status='success'))
        db.add(QAEvent(user_id=2, question='', status='success'))
        db.add(AuditLog(user_id=1, action='old', resource_type='user', resource_id=1,
                        detail={'email': 'private'}, ip_address='1.1.1.1'))
        db.add(Note(user_id=1, title='private', content='private'))
        db.add(EmailLog(recipient='user1@example.test', subject='private', html_body='private', email_type='test'))
        db.commit()
    response = f.client.request('DELETE', '/auth/account', json={'password': 'fixture'})
    assert response.status_code == 200, response.text
    assert response.json()['file_cleanup_status'] == 'pending'
    assert (f.root / 'report.txt').exists()
    with f.factory() as db:
        assert db.get(User, 1) is None
        assert db.query(Note).count() == 0
        assert db.query(QAEvent).count() == 1
        assert all(log.detail is None or log.detail == {'result': 'deleted'} for log in db.query(AuditLog))
        assert db.query(EmailLog).first().html_body == ''
        assert run_cleanup(db)['completed'] == 1
        assert run_cleanup(db)['examined'] == 0
    assert not (f.root / 'report.txt').exists()
    assert not image_dir.exists()


def test_cleanup_failure_is_durable_and_retryable(fixture, monkeypatch):
    f = fixture
    seed_document(f)
    assert f.client.request('DELETE', '/auth/account', json={'password': 'fixture'}).status_code == 200
    from app.services import file_cleanup
    remove = file_cleanup.os.remove
    monkeypatch.setattr(file_cleanup.os, 'remove', Mock(side_effect=PermissionError('fixture')))
    now = datetime.now()
    with f.factory() as db:
        assert run_cleanup(db, now=now)['completed'] == 0
        job = db.query(FileCleanupJob).one()
        assert job.status == 'retry' and job.attempts == 1
    monkeypatch.setattr(file_cleanup.os, 'remove', remove)
    with f.factory() as db:
        assert run_cleanup(db, now=now + timedelta(hours=1))['completed'] == 1


def test_cleanup_does_not_remove_shared_legacy_image_directory(fixture):
    f = fixture
    seed_document(f, 'report.txt')
    shared = f.root / 'images_report'
    shared.mkdir()
    (shared / 'shared.png').write_bytes(b'belongs to both records')
    other_file = f.root / 'other-report.docx'
    other_file.write_bytes(b'other account document')
    with f.factory() as db:
        db.add(Document(user_id=2, title='Other', file_name='report.docx', file_type='.docx',
            file_size=23, file_path=str(other_file), status='completed'))
        db.commit()
    assert f.client.request('DELETE', '/auth/account', json={'password': 'fixture'}).status_code == 200
    with f.factory() as db:
        result = run_cleanup(db)
        job = db.query(FileCleanupJob).one()
        assert result['completed'] == 0
        assert job.status == 'needs_review'
        assert job.paths == []
        assert job.manual_review
    assert shared.exists()
    assert (shared / 'shared.png').exists()
    assert other_file.exists()
    assert not (f.root / 'report.txt').exists()


@pytest.mark.parametrize('failure', ['folder', 'commit', 'publish'])
def test_overwrite_failures_preserve_old_document_and_vectors(fixture, monkeypatch, failure):
    f = fixture
    doc_id = seed_document(f)
    data = {'conflict_resolution': 'overwrite'}
    if failure == 'folder':
        data['folder_id'] = '999'
    if failure == 'commit':
        f.state['fail_commit'] = True
    if failure == 'publish':
        from app.tasks.document_tasks import process_document_task
        monkeypatch.setattr(process_document_task, 'delay', Mock(side_effect=RuntimeError('broker failure')))
    response = f.client.post('/documents/upload', data=data, files={'file': ('report.txt', b'synthetic report', 'text/plain')})
    assert response.status_code == (400 if failure == 'folder' else 500 if failure == 'commit' else 201), response.text
    with f.factory() as db:
        old = db.get(Document, doc_id)
        assert not old.is_deleted and old.status == 'completed'
        assert db.query(DocumentChunk).filter_by(document_id=doc_id).count() == 1
        assert db.query(Document).count() == (2 if failure == 'publish' else 1)
    assert len(list(f.root.iterdir())) == (2 if failure == 'publish' else 1)


def test_replacement_switch_is_one_transaction(fixture):
    f = fixture
    doc_id = seed_document(f)
    response = f.client.post('/documents/upload', data={'conflict_resolution': 'overwrite'},
        files={'file': ('report.txt', b'synthetic report', 'text/plain')})
    assert response.status_code == 201, response.text
    new_id = response.json()['id']
    with f.factory() as db:
        new = db.get(Document, new_id)
        assert new.supersedes_document_id == doc_id
        assert not db.get(Document, doc_id).is_deleted
        new.status, new.chunk_count = 'completed', 1
        activate_replacement(db, new)
        db.rollback()  # final commit failure leaves the old version fully intact
        assert not db.get(Document, doc_id).is_deleted
        assert db.query(DocumentChunk).filter_by(document_id=doc_id).count() == 1
        new = db.get(Document, new_id)
        new.status, new.chunk_count = 'completed', 1
        activate_replacement(db, new)
        db.commit()
        assert db.get(Document, doc_id).is_deleted
        assert db.query(DocumentChunk).filter_by(document_id=doc_id).count() == 0
        activate_replacement(db, new)  # idempotent after the switch


def test_account_export_includes_personal_and_archived_modules(fixture):
    f = fixture
    seed_document(f)
    with f.factory() as db:
        db.add(Note(user_id=1, title='note', content='content'))
        db.add(Note(user_id=2, title='other-private', content='must not export'))
        db.add(Todo(user_id=1, title='todo', status='archived'))
        db.add(Conversation(user_id=1, title='inactive', is_active=False))
        reminder = Reminder(user_id=1, recipient='user1@example.test', request_id='fixture', request_hash='x'*64,
                            subject='reminder', body='body', anchor_at=datetime.now(), archived_at=datetime.now())
        db.add(reminder)
        db.flush()
        email = EmailLog(recipient='user1@example.test', subject='r', html_body='r', email_type='reminder')
        db.add(email)
        db.flush()
        db.add(ReminderDelivery(reminder_id=reminder.id, email_log_id=email.id, revision=1,
                               scheduled_at=datetime.now(), next_attempt_at=datetime.now()))
        db.commit()
    response = f.client.get('/auth/export-data')
    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload['notes']) == len(payload['todos']) == len(payload['reminders']) == len(payload['reminder_deliveries']) == 1
    assert payload['conversations'][0]['is_active'] is False
    assert 'other-private' not in response.text
    assert 'client_local_knowledge' in payload['coverage']['excluded']
    assert response.headers['cache-control'] == 'no-store'
