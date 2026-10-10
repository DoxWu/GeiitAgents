"""Create cleanup in the deleting transaction; perform filesystem IO later."""
import os
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import or_

from app.core.config import settings
from app.models import Document, FileCleanupJob


def _relative_path(value, root):
    path = Path(value)
    if not path.is_absolute():
        candidate = path.resolve()
        path = candidate if candidate.is_relative_to(root) else root / path.name
    path = path.parent.resolve() / path.name
    if not path.is_relative_to(root) or path == root:
        raise ValueError('cleanup path outside upload root')
    return path.relative_to(root).as_posix()


def enqueue_document_cleanup(db, documents):
    root = Path(settings.UPLOAD_DIR).resolve()
    paths = set()
    manual_review = False
    other_docs = db.query(Document.file_path, Document.file_name).filter(
        Document.user_id.notin_([document.user_id for document in documents])
    ).all() if documents else []
    other_paths = set()
    other_stems = set()
    for file_path, file_name in other_docs:
        if file_name:
            other_stems.add(Path(file_name).stem.casefold())
        if file_path:
            try:
                other_paths.add(_relative_path(file_path, root))
            except ValueError:
                manual_review = True

    for document in documents:
        if document.file_path:
            try:
                relative = _relative_path(document.file_path, root)
                if relative in other_paths:
                    manual_review = True
                else:
                    paths.add(relative)
            except ValueError:
                manual_review = True
        paths.add(f'images_{document.id}')
        legacy = 'images_' + Path(document.file_name).stem
        if Path(document.file_name).stem.casefold() not in other_stems:
            paths.add(legacy)
        elif (root / legacy).exists() or (root / legacy).is_symlink():
            manual_review = True
    job = FileCleanupJob(paths=sorted(paths), status='pending', attempts=0,
                         error_code='MANUAL_REVIEW_REQUIRED' if manual_review else None,
                         manual_review=manual_review,
                         available_at=datetime.now(UTC).replace(tzinfo=None))
    db.add(job)
    return job


def run_cleanup(db, *, limit=50, now=None):
    now = now or datetime.now(UTC).replace(tzinfo=None)
    stale = now - timedelta(minutes=10)
    jobs = db.query(FileCleanupJob).filter(or_(
        (FileCleanupJob.status.in_(['pending', 'retry'])) & (FileCleanupJob.available_at <= now),
        (FileCleanupJob.status == 'processing') & (FileCleanupJob.claimed_at < stale),
    )).order_by(FileCleanupJob.id).limit(limit).with_for_update(skip_locked=True).all()
    # Reserve the batch before IO. A crash resumes after the lease expires.
    for job in jobs:
        job.status = 'processing'
        job.claimed_at = now
    db.commit()
    completed = 0
    root = Path(settings.UPLOAD_DIR).resolve()
    for job in jobs:
        try:
            for relative in job.paths:
                path = root / relative
                path = path.parent.resolve() / path.name
                if not path.is_relative_to(root) or path == root:
                    raise ValueError('cleanup path outside upload root')
                if path.is_symlink():
                    path.unlink(missing_ok=True)
                elif path.is_dir():
                    shutil.rmtree(path)
                else:
                    os.remove(path) if path.exists() else None
            job.status = 'needs_review' if job.manual_review else 'completed'
            job.completed_at = now if job.status == 'completed' else None
            job.paths = []
            if job.status == 'completed':
                job.error_code = None
                completed += 1
            else:
                job.error_code = 'MANUAL_REVIEW_REQUIRED'
        except (OSError, ValueError):
            job.attempts += 1
            job.status = 'retry'
            job.error_code = 'FILE_CLEANUP_FAILED'
            job.available_at = now + timedelta(seconds=min(3600, 30 * 2 ** min(job.attempts, 7)))
        db.commit()
    return {'completed': completed, 'examined': len(jobs)}
