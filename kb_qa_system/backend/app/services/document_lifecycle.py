"""Switch an indexed replacement inside the final document transaction."""
from datetime import datetime

from app.models import Document, DocumentChunk


def activate_replacement(db, document):
    source_id = document.supersedes_document_id
    if source_id is None:
        return
    if document.is_deleted or document.status not in ('completed', 'low_quality') or document.chunk_count < 1:
        raise ValueError('replacement is not ready')
    source = db.query(Document).filter(Document.id == source_id).with_for_update().first()
    if not source or source.is_deleted or source.user_id != document.user_id:
        raise ValueError('replacement source changed')
    source.is_deleted = True
    source.deleted_at = datetime.now()
    source.status = 'deleted'
    db.query(DocumentChunk).filter(DocumentChunk.document_id == source.id).delete(synchronize_session=False)
    document.supersedes_document_id = None
    document.metadata_ = {**(document.metadata_ or {}), 'replaced_document_id': source_id}
