"""Encrypted offline recovery boundaries; no real supplier or email calls."""

import base64
import io
import json
import struct
import tarfile
from contextlib import nullcontext
from pathlib import Path

import pytest
from test_ops import config, live, seeded  # noqa: F401

from app.ops import recovery_bundle as bundle
from app.ops.postgres import OpsError


@pytest.fixture
def archive(tmp_path):
    sources = {}
    for name, value in {
        "database.dump": b"synthetic-dump",
        "uploads/report.txt": "报销期限为七天。".encode(),
        "uploads/images_1/image.png": b"synthetic-derived-image",
        "config/runtime.env": b"SECRET_KEY=synthetic-private-value",
    }.items():
        path = tmp_path / name
        path.parent.mkdir(exist_ok=True, parents=True)
        path.write_bytes(value)
        sources[name] = path
    manifest = {
        "format": 1,
        "database": {"counts": {}, "revisions": ["fixture"]},
        "documents": [{"id": 1, "stored_path": "uploads/report.txt", "file": "uploads/report.txt"}],
        "uploads_path": "/app/uploads",
        "files": [bundle._entry(name, sources[name]) for name in sorted(sources)],
    }
    plain = tmp_path / "bundle.tar"
    bundle._write_tar(plain, manifest, sources)
    cfg = config(BACKUP_MAX_BYTES=4 * 1024**2)
    encrypted = tmp_path / "test.geiit-recovery"
    bundle._encrypt(plain, encrypted, cfg)
    return cfg, encrypted, manifest, sources


def test_authenticated_roundtrip_and_exclusive_backup_output(archive, tmp_path):
    cfg, encrypted, manifest, sources = archive
    assert b"synthetic-private-value" not in encrypted.read_bytes()
    before = encrypted.read_bytes()
    plain = tmp_path / "readback.tar"
    bundle._decrypt(encrypted, plain, cfg)
    destination = tmp_path / "unpacked"
    assert bundle._unpack(plain, destination, cfg) == manifest
    for name, path in sources.items():
        assert (destination / name).read_bytes() == path.read_bytes()
    with pytest.raises(FileExistsError):
        bundle._encrypt(plain, encrypted, cfg)
    assert encrypted.read_bytes() == before


@pytest.mark.parametrize(
    "failure", ["key", "source", "flip", "truncate", "terminal", "append", "length", "budget"]
)
def test_integrity_failures_rejected_before_database_or_workspace(
    archive, tmp_path, monkeypatch, failure
):
    cfg, encrypted, _, _ = archive
    value = encrypted.read_bytes()
    if failure == "key":
        cfg = cfg.model_copy(update={"BACKUP_ENCRYPTION_KEY": base64.b64encode(b"x" * 32).decode()})
    elif failure == "source":
        cfg = cfg.model_copy(update={"BACKUP_SOURCE_ID": "different-source"})
    elif failure == "flip":
        value = value[:80] + bytes([value[80] ^ 1]) + value[81:]
    elif failure == "truncate":
        value = value[:-10]
    elif failure == "terminal":
        value = value[:-32]
    elif failure == "append":
        value += b"undeclared"
    elif failure == "length":
        value = bundle.MAGIC + struct.pack(">I", 0xFFFFFFFF)
    elif failure == "budget":
        cfg = cfg.model_copy(update={"BACKUP_MAX_BYTES": 1024})
    encrypted.write_bytes(value)
    monkeypatch.setattr(bundle, "database_lock", lambda *a: pytest.fail("must not connect"))
    destination = tmp_path / "restore"
    with pytest.raises(OpsError, match="integrity"):
        bundle.restore_bundle(cfg, encrypted, destination, writers_stopped=True)
    assert not destination.exists()


@pytest.mark.parametrize(
    "name",
    [
        "../outside",
        "/outside",
        "uploads/../outside",
        "uploads/a\\b",
        "uploads/C:evil",
        "uploads/NUL.txt",
        "uploads/COM1",
        "uploads/a.",
        "uploads//a",
        "uploads/./a",
    ],
)
def test_unsafe_or_nonportable_names_rejected(archive, name):
    cfg, _, manifest, _ = archive
    manifest["files"][1]["name"] = name
    with pytest.raises(OpsError):
        bundle._manifest(manifest, cfg)


@pytest.mark.parametrize(
    "failure",
    [
        "duplicate",
        "missing_ref",
        "duplicate_ref",
        "too_many",
        "negative_size",
        "no_dump",
        "bad_revision",
    ],
)
def test_manifest_reference_and_budget_validation(archive, monkeypatch, failure):
    cfg, _, manifest, _ = archive
    if failure == "duplicate":
        manifest["files"].append({**manifest["files"][0], "name": "CONFIG/RUNTIME.ENV"})
    elif failure == "missing_ref":
        manifest["documents"][0]["file"] = "uploads/missing.txt"
    elif failure == "duplicate_ref":
        manifest["documents"].append(manifest["documents"][0])
    elif failure == "too_many":
        monkeypatch.setattr(bundle, "MAX_FILES", 1)
    elif failure == "negative_size":
        manifest["files"][0]["size"] = -1
    elif failure == "no_dump":
        manifest["files"] = [
            entry for entry in manifest["files"] if entry["name"] != "database.dump"
        ]
    elif failure == "bad_revision":
        manifest["database"]["revisions"] = []
    with pytest.raises(OpsError):
        bundle._manifest(manifest, cfg)


@pytest.mark.parametrize("failure", ["symlink", "checksum", "extra", "missing"])
def test_archive_cannot_disagree_with_manifest(archive, tmp_path, failure):
    cfg, _, manifest, sources = archive
    archive_path = tmp_path / "malformed.tar"
    with tarfile.open(archive_path, "w") as target:
        raw = json.dumps(manifest).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(raw)
        target.addfile(info, io.BytesIO(raw))
        for index, entry in enumerate(manifest["files"]):
            if failure == "missing" and index == 0:
                continue
            info = tarfile.TarInfo(entry["name"])
            value = sources[entry["name"]].read_bytes()
            if failure == "symlink" and index == 0:
                info.type, info.linkname = tarfile.SYMTYPE, "../../external"
                target.addfile(info)
                continue
            if failure == "checksum" and index == 0:
                value = b"X" * len(value)
            info.size = len(value)
            target.addfile(info, io.BytesIO(value))
        if failure == "extra":
            info = tarfile.TarInfo("undeclared")
            target.addfile(info, io.BytesIO())
    with pytest.raises(OpsError):
        bundle._unpack(archive_path, tmp_path / "unpacked", cfg)
    assert not (tmp_path.parent / "external").exists()


def test_changed_file_aborts_before_publishing(archive, tmp_path):
    _, _, manifest, sources = archive
    sources["uploads/report.txt"].write_bytes(b"changed")
    with pytest.raises(OpsError):
        bundle._write_tar(tmp_path / "changed.tar", manifest, sources)


def test_offline_acknowledgement_and_existing_directory_guard(archive, tmp_path):
    cfg, encrypted, _, _ = archive
    with pytest.raises(OpsError, match="Stop API"):
        bundle.create_bundle(cfg, encrypted, tmp_path, config_files={})
    with pytest.raises(OpsError, match="Stop all"):
        bundle.restore_bundle(cfg, encrypted, tmp_path / "new")
    with pytest.raises(OpsError, match="already exist"):
        bundle.restore_bundle(cfg, encrypted, tmp_path, writers_stopped=True)


def test_failed_restore_preserves_explicit_incomplete_marker(archive, monkeypatch, tmp_path):
    cfg, encrypted, _, _ = archive
    monkeypatch.setattr(bundle, "verify_dump", lambda *a: None)
    monkeypatch.setattr(bundle, "database_lock", lambda *a: nullcontext(object()))
    monkeypatch.setattr(bundle, "is_empty", lambda *a: True)

    def fail_restore(*args):
        raise OpsError("synthetic restore failure")

    monkeypatch.setattr(bundle, "restore_dump", fail_restore)
    destination = tmp_path / "failed"
    with pytest.raises(OpsError, match="synthetic"):
        bundle.restore_bundle(cfg, encrypted, destination, writers_stopped=True)
    assert (destination / bundle.INCOMPLETE).is_file()
    assert not (destination / bundle.READY).exists()
    assert (destination / "uploads/report.txt").is_file()


def test_cli_never_prints_native_errors_or_configuration(capsys, monkeypatch, tmp_path):
    monkeypatch.setattr(bundle, "OpsSettings", lambda: config())

    def fail(*args):
        raise OSError("postgresql://real-user:private-secret@host/db internal/path")

    monkeypatch.setattr(bundle, "verify_bundle", fail)
    with pytest.raises(SystemExit):
        bundle.main(["verify", "--bundle", str(tmp_path / "missing")])
    output = capsys.readouterr().out
    assert "private-secret" not in output and "internal/path" not in output
    assert json.loads(output)["status"] == "failed"


def test_live_joint_recovery_login_files_vector_query_and_todo(live, tmp_path, monkeypatch):  # noqa: F811
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.api import deps
    from app.api.routes import auth, documents, personal
    from app.core import database
    from app.core.config import settings
    from app.models import Document, DocumentChunk, Todo, User
    from app.services import rag_chain, vector_store

    cfg, target = live
    cfg = seeded(cfg)
    app_root = tmp_path / "original"
    uploads = app_root / "uploads"
    uploads.mkdir(parents=True)
    (uploads / "report.txt").write_text(
        "Orion reimbursement deadline is seven days.", encoding="utf-8"
    )
    (uploads / "guide.pdf").write_bytes(b"%PDF-1.7\nsynthetic-download-fixture\n%%EOF")
    (uploads / "images_1").mkdir()
    (uploads / "images_1/image.png").write_bytes(b"synthetic-derived-image")
    configuration = app_root / "runtime.env"
    configuration.write_text(
        "SECRET_KEY=synthetic-restore-key\nUPLOAD_DIR=./uploads\n", encoding="utf-8"
    )
    source_engine = create_engine(
        cfg.DATABASE_URL.replace("postgresql://", "postgresql+psycopg://")
    )
    source_sessions = sessionmaker(bind=source_engine, expire_on_commit=False)
    try:
        client = SimpleNamespace(
            name="synthetic-restored-vector",
            dimension=settings.EMBEDDING_DIMENSION,
            config=SimpleNamespace(
                type="openai", model="fixture", api_base="https://invalid.example/v1"
            ),
            embed_query=lambda value: [1.0] + [0.0] * (settings.EMBEDDING_DIMENSION - 1),
        )
        space = vector_store.VectorStoreService._embedding_space_id(client)
        with source_sessions() as session:
            user = session.query(User).one()
            doc = Document(
                user_id=user.id,
                title="Orion deadline",
                file_name="report.txt",
                file_type="txt",
                file_size=(uploads / "report.txt").stat().st_size,
                file_path="uploads/report.txt",
                status="completed",
                content="Orion reimbursement deadline is seven days.",
            )
            pdf = Document(
                user_id=user.id,
                title="Guide",
                file_name="guide.pdf",
                file_type="pdf",
                file_size=45,
                file_path="uploads/guide.pdf",
                status="completed",
            )
            todo = Todo(
                user_id=user.id, title="Complete recovery check", content="synthetic open task"
            )
            session.add_all([doc, pdf, todo])
            session.flush()
            session.add(
                DocumentChunk(
                    document_id=doc.id,
                    chunk_index=0,
                    content=doc.content,
                    content_vector=client.embed_query("fixture"),
                    embedding_space=space,
                )
            )
            session.commit()
            owner_id, doc_id, pdf_id, todo_id = user.id, doc.id, pdf.id, todo.id
        encrypted = tmp_path / "joint.geiit-recovery"
        result = bundle.create_bundle(
            cfg,
            encrypted,
            uploads,
            config_files={"runtime.env": configuration},
            writers_stopped=True,
            app_root=app_root,
        )
        assert result == {"status": "created", "documents": 2, "uploads": 3, "config_files": 1}
        assert bundle.verify_bundle(cfg, encrypted)["status"] == "verified"
        assert b"synthetic-restore-key" not in encrypted.read_bytes()

        restored = cfg.model_copy(update={"DATABASE_URL": target})
        workspace = tmp_path / "recovered"
        assert (
            bundle.restore_bundle(restored, encrypted, workspace, writers_stopped=True)["status"]
            == "restored"
        )
        assert (workspace / bundle.READY).is_file() and not (workspace / bundle.INCOMPLETE).exists()
        assert json.loads((workspace / bundle.READY).read_text())["restored_uploads_path"] == str(
            workspace / "uploads"
        )
        for original in uploads.rglob("*"):
            if original.is_file():
                assert (
                    workspace / "uploads" / original.relative_to(uploads)
                ).read_bytes() == original.read_bytes()
        assert (workspace / "config/runtime.env").read_bytes() == configuration.read_bytes()

        target_engine = create_engine(target.replace("postgresql://", "postgresql+psycopg://"))
        factory = sessionmaker(bind=target_engine, expire_on_commit=False)
        try:
            with factory() as session:
                relocated = session.get(Document, doc_id)
                assert relocated.file_path == str(workspace / "uploads/report.txt")
                assert Path(relocated.file_path).read_text(encoding="utf-8") == doc.content
            monkeypatch.setattr(database, "SessionLocal", factory)
            monkeypatch.setattr(vector_store, "SessionLocal", factory)
            monkeypatch.setattr(settings, "UPLOAD_DIR", str(workspace / "uploads"))
            monkeypatch.setattr(settings, "ENABLE_RATE_LIMIT", False)
            monkeypatch.setattr(settings, "ENABLE_RERANKING", False)
            monkeypatch.setattr(deps, "is_token_blacklisted", lambda *a: False)
            monkeypatch.setattr(auth, "clear_login_failure", lambda *a: None)
            monkeypatch.setattr(vector_store.RedisManager, "get", lambda *a: None)
            monkeypatch.setattr(vector_store.RedisManager, "set", lambda *a, **kw: True)
            store = object.__new__(vector_store.VectorStoreService)
            store._manager = SimpleNamespace(
                get_embedding_client_with_fallback=lambda: (client, [])
            )
            monkeypatch.setattr(rag_chain, "get_vector_store", lambda: store)

            def sessions():
                with factory() as session:
                    yield session

            app = FastAPI()
            app.include_router(auth.router)
            app.include_router(documents.router)
            app.include_router(personal.router)
            app.dependency_overrides[database.get_db] = sessions
            with TestClient(app) as http:
                login = http.post(
                    "/auth/login", json={"username": "test_admin", "password": "TestOnly123!"}
                )
                assert login.status_code == 200, login.text
                http.headers["Authorization"] = "Bearer " + login.json()["access_token"]
                preview = http.get(f"/documents/{doc_id}/content")
                assert preview.status_code == 200 and "seven days" in preview.text
                download = http.get(f"/documents/{pdf_id}/content")
                assert (
                    download.status_code == 200
                    and download.content == (uploads / "guide.pdf").read_bytes()
                )
                context = rag_chain.RAGChainService().retrieve_context(
                    "Orion deadline", user_id=owner_id
                )
                assert {item["metadata"]["document_id"] for item in context} == {doc_id}
                assert "seven days" in context[0]["content"]
                tasks = http.get("/personal/todos").json()
                assert tasks[0]["id"] == todo_id and tasks[0]["status"] == "open"
                updated = http.patch(
                    f"/personal/todos/{todo_id}",
                    json={"revision": tasks[0]["revision"], "status": "completed"},
                )
                assert updated.status_code == 200 and updated.json()["status"] == "completed"

            with pytest.raises(OpsError, match="empty target"):
                bundle.restore_bundle(
                    restored, encrypted, tmp_path / "refused", writers_stopped=True
                )
            assert not (tmp_path / "refused").exists()
            bad_manifest = {"file": "uploads/absent.txt"}
            monkeypatch.setattr(bundle, "_references", lambda *a: [bad_manifest])
            with pytest.raises(OpsError, match="absent"):
                bundle.create_bundle(
                    cfg,
                    tmp_path / "bad.geiit-recovery",
                    uploads,
                    config_files={"runtime.env": configuration},
                    writers_stopped=True,
                    app_root=app_root,
                )
        finally:
            target_engine.dispose()
    finally:
        source_engine.dispose()
