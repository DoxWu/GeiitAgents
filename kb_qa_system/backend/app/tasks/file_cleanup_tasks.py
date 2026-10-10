from app.core.celery_app import celery_app
from app.core.database import SessionLocal
from app.services.file_cleanup import run_cleanup


@celery_app.task(name='app.tasks.file_cleanup_tasks.cleanup_files')
def cleanup_files():
    with SessionLocal() as db:
        return run_cleanup(db)
