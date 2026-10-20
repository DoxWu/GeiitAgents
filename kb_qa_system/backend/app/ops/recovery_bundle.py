"""Offline, encrypted database/uploads/config bundles for an empty recovery site.

Writers must be stopped externally, including workers and cleanup/ops schedulers.
This command never stops services, rewrites live configuration, or switches traffic.
"""

import argparse
import hashlib
import io
import json
import os
import re
import stat
import struct
import tarfile
import tempfile
import unicodedata
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath, PureWindowsPath

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.ops.backup import (
    CHUNK_SIZE,
    check_restored,
    encryption_key,
    file_hash,
    inventory,
    restore_dump,
    seal,
    unseal,
    verify_dump,
)
from app.ops.config import OpsSettings
from app.ops.postgres import OpsError, connect, database_lock, is_empty, pg_tool

MAGIC = b"GEIIT-RECOVERY-1\n"
MAX_FILES = 100_000
MAX_MANIFEST_BYTES = 16 * 1024**2
INCOMPLETE = "RESTORE_INCOMPLETE"
READY = "RESTORE_VERIFIED.json"


def _name(value):
    """One portable, relative regular-file name; never an extraction instruction."""
    if not isinstance(value, str) or unicodedata.normalize("NFC", value) != value:
        raise OpsError("Bundle contains an invalid file name")
    parts = PurePosixPath(value).parts
    if not parts or str(PurePosixPath(value)) != value:
        raise OpsError("Bundle contains an invalid file name")
    for part in parts:
        reserved = part.split(".")[0].upper()
        if (
            part in {"/", ".", ".."}
            or part.endswith((" ", "."))
            or any(ord(char) < 32 or char in '\\:<>"|?*' for char in part)
            or reserved in {"CON", "PRN", "AUX", "NUL"}
            or re.fullmatch(r"(?:COM|LPT)[1-9]", reserved)
        ):
            raise OpsError("Bundle contains a nonportable file name")
    return value


def _regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or _reparse(info):
        raise OpsError("Bundle sources must be regular files without links")
    return info


def _reparse(info):
    return bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def _tree(root):
    if not root.is_dir() or root.is_symlink() or _reparse(root.lstat()):
        raise OpsError("Uploads must be a real directory without links")
    files = []
    for directory, directories, names in os.walk(root, followlinks=False):
        for name in directories:
            child = Path(directory) / name
            if child.is_symlink() or _reparse(child.lstat()):
                raise OpsError("Linked upload directories cannot be bundled")
        for name in names:
            path = Path(directory) / name
            _regular(path)
            files.append(path)
            if len(files) > MAX_FILES:
                raise OpsError("Bundle file count exceeds its limit")
    return sorted(files)


def _same_file(before, after):
    return all(
        getattr(before, key) == getattr(after, key)
        for key in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    )


def _entry(name, path):
    before = _regular(path)
    digest = file_hash(path)
    if not _same_file(before, _regular(path)):
        raise OpsError("A bundle source changed; stop all writers and retry")
    return {"name": _name(name), "size": before.st_size, "sha256": digest}


def _references(connection, uploads, app_root):
    result = []
    for doc_id, stored in connection.execute(
        "SELECT id,file_path FROM documents WHERE NOT is_deleted ORDER BY id"
    ):
        path = Path(stored)
        if not path.is_absolute():
            path = app_root / path
        try:
            relative = path.resolve(strict=True).relative_to(uploads).as_posix()
        except (ValueError, OSError):
            raise OpsError("An active document has a missing or external upload") from None
        result.append({"id": doc_id, "stored_path": stored, "file": _name("uploads/" + relative)})
        if len(result) > MAX_FILES:
            raise OpsError("Bundle document count exceeds its limit")
    return result


class _HashReader:
    def __init__(self, handle):
        self.handle = handle
        self.digest = hashlib.sha256()

    def read(self, count):
        value = self.handle.read(count)
        self.digest.update(value)
        return value


def _write_tar(target, manifest, sources):
    raw = json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode("utf-8")
    if len(raw) > MAX_MANIFEST_BYTES:
        raise OpsError("Bundle manifest exceeds its limit")
    with tarfile.open(target, "w", format=tarfile.PAX_FORMAT) as archive:
        meta = tarfile.TarInfo("manifest.json")
        meta.size, meta.mode = len(raw), 0o600
        archive.addfile(meta, io.BytesIO(raw))
        for entry in manifest["files"]:
            path = sources[entry["name"]]
            before = _regular(path)
            if before.st_size != entry["size"]:
                raise OpsError("A bundle source changed; stop all writers and retry")
            with path.open("rb") as handle:
                if not _same_file(before, os.fstat(handle.fileno())):
                    raise OpsError("A bundle source changed; stop all writers and retry")
                reader = _HashReader(handle)
                info = tarfile.TarInfo(entry["name"])
                info.size, info.mode = entry["size"], 0o600
                archive.addfile(info, reader)
            if reader.digest.hexdigest() != entry["sha256"] or not _same_file(
                before, _regular(path)
            ):
                raise OpsError("A bundle source changed; stop all writers and retry")


def _context(source, sequence):
    return json.dumps(["geiit-recovery-1", source, sequence], separators=(",", ":")).encode()


def _encrypt(plain, output, cfg):
    """Publish via an exclusive hard link, never overwrite an existing backup."""
    cipher = AESGCM(encryption_key(cfg))
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".geiit-", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(MAGIC)
            with plain.open("rb") as source:
                sequence = 0
                while value := source.read(CHUNK_SIZE):
                    payload = seal(cipher, value, _context(cfg.BACKUP_SOURCE_ID, sequence))
                    handle.write(struct.pack(">I", len(payload)))
                    handle.write(payload)
                    sequence += 1
            # An authenticated terminal record detects truncation, including an
            # otherwise valid prefix that ends exactly at a chunk boundary.
            payload = seal(cipher, b"", _context(cfg.BACKUP_SOURCE_ID, sequence))
            handle.write(struct.pack(">I", len(payload)))
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
            os.link(temporary, output)
        finally:
            handle.close()
            temporary.unlink(missing_ok=True)


def _decrypt(bundle, plain, cfg):
    cipher = AESGCM(encryption_key(cfg))
    try:
        with bundle.open("rb") as source, plain.open("xb") as target:
            if source.read(len(MAGIC)) != MAGIC:
                raise ValueError
            sequence, total = 0, 0
            while True:
                header = source.read(4)
                if len(header) != 4:
                    raise ValueError
                size = struct.unpack(">I", header)[0]
                if not 28 <= size <= CHUNK_SIZE + 28:
                    raise ValueError
                payload = source.read(size)
                if len(payload) != size:
                    raise ValueError
                value = unseal(cipher, payload, _context(cfg.BACKUP_SOURCE_ID, sequence))
                if not value:
                    if source.read(1):
                        raise ValueError
                    return
                total += len(value)
                if total > cfg.BACKUP_MAX_BYTES:
                    raise ValueError
                target.write(value)
                sequence += 1
    except Exception:
        raise OpsError("Bundle integrity/key/source verification failed") from None


def _manifest(value, cfg):
    if not isinstance(value, dict) or value.get("format") != 1:
        raise OpsError("Unsupported recovery bundle")
    files = value.get("files")
    documents = value.get("documents")
    if (
        not isinstance(files, list)
        or not 1 <= len(files) <= MAX_FILES
        or not isinstance(documents, list)
        or len(documents) > MAX_FILES
        or not isinstance(value.get("database"), dict)
        or not isinstance(value["database"].get("counts"), dict)
        or not isinstance(value["database"].get("revisions"), list)
        or not value["database"]["revisions"]
        or any(
            type(count) is not int or count < 0 for count in value["database"]["counts"].values()
        )
        or any(
            not isinstance(revision, str) or not revision
            for revision in value["database"]["revisions"]
        )
        or not isinstance(value.get("uploads_path"), str)
        or not (
            PurePosixPath(value["uploads_path"]).is_absolute()
            or PureWindowsPath(value["uploads_path"]).is_absolute()
        )
    ):
        raise OpsError("Invalid recovery bundle manifest")
    names, exact_names, size = set(), set(), 0
    for entry in files:
        if not isinstance(entry, dict):
            raise OpsError("Invalid recovery bundle file entry")
        name = _name(entry.get("name"))
        if (
            name != "database.dump"
            and not name.startswith(("uploads/", "config/"))
            or name.casefold() in names
            or type(entry.get("size")) is not int
            or entry["size"] < 0
            or not re.fullmatch(r"[a-f0-9]{64}", str(entry.get("sha256", "")))
        ):
            raise OpsError("Invalid or duplicate recovery bundle file")
        names.add(name.casefold())
        exact_names.add(name)
        size += entry["size"]
    if "database.dump" not in names or size > cfg.BACKUP_MAX_BYTES:
        raise OpsError("Bundle is incomplete or exceeds its size limit")
    document_ids = set()
    for doc in documents:
        if (
            not isinstance(doc, dict)
            or type(doc.get("id")) is not int
            or doc["id"] in document_ids
            or not isinstance(doc.get("stored_path"), str)
            or not isinstance(doc.get("file"), str)
            or not doc["file"].startswith("uploads/")
            or doc["file"] not in exact_names
        ):
            raise OpsError("Bundle has a missing or duplicate document reference")
        document_ids.add(doc["id"])
    return value


def _unpack(plain, destination, cfg):
    try:
        with tarfile.open(plain, "r|", bufsize=CHUNK_SIZE) as archive:
            header = archive.next()
            if (
                header is None
                or header.name != "manifest.json"
                or not header.isfile()
                or not 0 < header.size <= MAX_MANIFEST_BYTES
            ):
                raise OpsError("Bundle manifest must be its first regular file")
            with archive.extractfile(header) as handle:
                manifest = _manifest(json.loads(handle.read()), cfg)
            for entry in manifest["files"]:
                info = archive.next()
                if (
                    info is None
                    or info.name != entry["name"]
                    or not info.isfile()
                    or info.size != entry["size"]
                ):
                    raise OpsError("Bundle archive differs from its manifest")
                path = destination.joinpath(*PurePosixPath(entry["name"]).parts)
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                digest = hashlib.sha256()
                with archive.extractfile(info) as source, path.open("xb") as target:
                    while chunk := source.read(CHUNK_SIZE):
                        target.write(chunk)
                        digest.update(chunk)
                path.chmod(0o600)
                if digest.hexdigest() != entry["sha256"]:
                    raise OpsError("Bundle file checksum verification failed")
            if archive.next() is not None:
                raise OpsError("Bundle contains undeclared files")
            return manifest
    except (OSError, ValueError, tarfile.TarError, KeyError, TypeError):
        raise OpsError("Invalid recovery bundle archive") from None


def _summary(manifest, status):
    return {
        "status": status,
        "documents": len(manifest["documents"]),
        "uploads": sum(entry["name"].startswith("uploads/") for entry in manifest["files"]),
        "config_files": sum(entry["name"].startswith("config/") for entry in manifest["files"]),
    }


def create_bundle(cfg, output, uploads, *, config_files, writers_stopped=False, app_root=None):
    if not writers_stopped:
        raise OpsError("Stop API, worker, beat, cleanup and ops writers before bundling")
    if not config_files:
        raise OpsError("Explicit recovery configuration files are required")
    encryption_key(cfg)
    output, uploads = Path(output).absolute(), Path(uploads).absolute()
    root = Path(app_root or Path.cwd()).resolve(strict=True)
    # Resolve only after rejecting root links; descendants are checked by _tree.
    _tree(uploads)
    uploads = uploads.resolve(strict=True)
    upload_files = _tree(uploads)
    if output.resolve().is_relative_to(uploads):
        raise OpsError("Bundle output must be outside the uploads directory")
    sources = {"uploads/" + path.relative_to(uploads).as_posix(): path for path in upload_files}
    for alias, path in config_files.items():
        _name(alias)
        if "/" in alias or alias.casefold() in {
            key.removeprefix("config/").casefold() for key in sources
        }:
            raise OpsError("Configuration aliases must be unique file names")
        sources["config/" + alias] = Path(path)
    with (
        database_lock(cfg.DATABASE_URL, cfg),
        tempfile.TemporaryDirectory(prefix="geiit-bundle-") as tmp,
    ):
        directory = Path(tmp)
        dump, archive = directory / "database.dump", directory / "bundle.tar"
        sources["database.dump"] = dump
        with connect(cfg.DATABASE_URL, cfg) as source:
            source.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            snapshot = source.execute("SELECT pg_export_snapshot()").fetchone()[0]
            expected = inventory(source)
            if not cfg.BACKUP_ALLOW_EMPTY and expected["counts"]["users"] == 0:
                raise OpsError("No users in source database")
            documents = _references(source, uploads, root)
            if any(doc["file"] not in sources for doc in documents):
                raise OpsError("An active document is absent from uploads")
            pg_tool(
                "pg_dump",
                [
                    "--format=custom",
                    "--no-owner",
                    "--no-privileges",
                    "--snapshot",
                    snapshot,
                    "--file",
                    str(dump),
                ],
                cfg,
                cfg.DATABASE_URL,
            )
        if sum(_regular(path).st_size for path in sources.values()) > cfg.BACKUP_MAX_BYTES:
            raise OpsError("Bundle exceeds its size limit")
        manifest = {
            "format": 1,
            "created_at": datetime.now(UTC).isoformat(),
            "database": expected,
            "uploads_path": str(uploads),
            "documents": documents,
            "files": [_entry(name, sources[name]) for name in sorted(sources)],
        }
        _manifest(manifest, cfg)
        verify_dump(dump, expected, cfg)
        _write_tar(archive, manifest, sources)
        if (
            set(_tree(uploads)) != set(upload_files)
            or archive.stat().st_size > cfg.BACKUP_MAX_BYTES
        ):
            raise OpsError("Uploads changed or bundle exceeds its size limit")
        _encrypt(archive, output, cfg)
        return _summary(manifest, "created")


def verify_bundle(cfg, bundle):
    with tempfile.TemporaryDirectory(prefix="geiit-bundle-verify-") as tmp:
        directory = Path(tmp)
        _decrypt(Path(bundle), directory / "bundle.tar", cfg)
        manifest = _unpack(directory / "bundle.tar", directory / "files", cfg)
        verify_dump(directory / "files/database.dump", manifest["database"], cfg)
        return _summary(manifest, "verified")


def restore_bundle(cfg, bundle, workspace, *, writers_stopped=False):
    if not writers_stopped:
        raise OpsError("Stop all target writers before recovery")
    workspace = Path(workspace).absolute()
    if workspace.exists() or workspace.is_symlink():
        raise OpsError("Recovery workspace must not already exist")
    parent = workspace.parent
    try:
        resolved_parent = parent.resolve(strict=True)
    except OSError:
        raise OpsError("Recovery workspace parent must already exist") from None
    if resolved_parent != parent or _reparse(parent.lstat()):
        raise OpsError("Recovery workspace parent cannot be a link")
    with tempfile.TemporaryDirectory(prefix="geiit-bundle-restore-") as tmp:
        directory = Path(tmp)
        _decrypt(Path(bundle), directory / "bundle.tar", cfg)
        manifest = _unpack(directory / "bundle.tar", directory / "files", cfg)
        dump = directory / "files/database.dump"
        verify_dump(dump, manifest["database"], cfg)
        with database_lock(cfg.DATABASE_URL, cfg) as lock:
            if not is_empty(lock):
                raise OpsError("Restore only supports an empty target database")
            # Exclusive reservation; failures remain explicitly incomplete, with
            # no destructive rollback of either target database or directories.
            workspace.mkdir(mode=0o700)
            (workspace / INCOMPLETE).write_text(
                "Recovery incomplete. Keep services stopped; inspect before retrying with fresh targets.\n",
                encoding="utf-8",
            )
            for entry in manifest["files"]:
                if entry["name"] == "database.dump":
                    continue
                relative = PurePosixPath(entry["name"])
                target = workspace.joinpath(*relative.parts)
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with (
                    (directory / "files" / relative).open("rb") as source,
                    target.open("xb") as handle,
                ):
                    while chunk := source.read(CHUNK_SIZE):
                        handle.write(chunk)
                target.chmod(0o600)
                if file_hash(target) != entry["sha256"]:
                    raise OpsError("Restored file checksum differs from bundle")
            (workspace / "uploads").mkdir(exist_ok=True, mode=0o700)
            if not is_empty(lock):
                raise OpsError("Recovery database changed during file restoration")
            restore_dump(dump, cfg.DATABASE_URL, cfg)
            check_restored(cfg.DATABASE_URL, manifest["database"], cfg)
            with connect(cfg.DATABASE_URL, cfg) as target:
                restored_paths = []
                for doc in manifest["documents"]:
                    parts = PurePosixPath(doc["file"]).parts[1:]
                    restored_path = workspace.joinpath("uploads", *parts)
                    if len(str(restored_path)) > 500:
                        raise OpsError("Recovery upload path exceeds the database limit")
                    row = target.execute(
                        """UPDATE documents SET file_path=%s
                        WHERE id=%s AND file_path=%s AND NOT is_deleted
                        RETURNING id""",
                        (str(restored_path), doc["id"], doc["stored_path"]),
                    ).fetchone()
                    if row is None:
                        raise OpsError("Restored document references differ from bundle")
                    restored_paths.append((doc["id"], str(restored_path)))
                target.commit()
                actual = target.execute(
                    "SELECT id,file_path FROM documents WHERE NOT is_deleted ORDER BY id"
                ).fetchall()
                if actual != restored_paths:
                    raise OpsError("Relocated document references differ from bundle")
            result = _summary(manifest, "restored")
            result["original_uploads_path"] = manifest["uploads_path"]
            result["restored_uploads_path"] = str(workspace / "uploads")
            # This local receipt is private and may include the original mount
            # path. Only counts/status are printed by the CLI.
            (workspace / READY).write_text(json.dumps(result), encoding="utf-8")
            (workspace / INCOMPLETE).unlink()
            return _summary(manifest, "restored")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Offline encrypted GeiIt database/uploads/config recovery"
    )
    parser.add_argument("command", choices=["create", "verify", "restore"])
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--uploads", type=Path)
    parser.add_argument("--app-root", type=Path)
    parser.add_argument("--config-file", action="append", default=[], metavar="ALIAS=PATH")
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--writers-stopped", action="store_true")
    args = parser.parse_args(argv)
    try:
        cfg = OpsSettings()
        if args.command == "create":
            if not args.uploads or args.workspace:
                raise OpsError("Create requires uploads and explicit configuration files")
            config_files = {}
            for value in args.config_file:
                alias, separator, path = value.partition("=")
                if (
                    not separator
                    or not path
                    or alias.casefold() in {key.casefold() for key in config_files}
                ):
                    raise OpsError("Configuration files require unique ALIAS=PATH arguments")
                config_files[alias] = Path(path)
            result = create_bundle(
                cfg,
                args.bundle,
                args.uploads,
                config_files=config_files,
                writers_stopped=args.writers_stopped,
                app_root=args.app_root,
            )
        elif args.command == "verify":
            if (
                args.uploads
                or args.app_root
                or args.config_file
                or args.workspace
                or args.writers_stopped
            ):
                raise OpsError("Verify only accepts a bundle path")
            result = verify_bundle(cfg, args.bundle)
        else:
            if not args.workspace or args.uploads or args.app_root or args.config_file:
                raise OpsError("Restore requires a fresh workspace")
            result = restore_bundle(
                cfg, args.bundle, args.workspace, writers_stopped=args.writers_stopped
            )
        print(json.dumps(result))
    except Exception as exc:
        # File paths, document names, DSNs, config contents and supplier keys
        # must not escape through native filesystem/database exceptions.
        detail = (
            str(exc)
            if isinstance(exc, OpsError)
            else "Check tools, permissions, configuration and fresh targets."
        )
        print(json.dumps({"status": "failed", "detail": detail}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
