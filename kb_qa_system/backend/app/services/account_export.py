"""Bounded, consistent server-account export. Never claims local data coverage."""
import json
from datetime import UTC, datetime

from fastapi import HTTPException, Response
from sqlalchemy.orm import Session

from app.models import Conversation, Document, Message, Note, Reminder, ReminderDelivery, Todo, User

MAX_ROWS = 5000
MAX_MESSAGES = 20000
MAX_BYTES = 16 * 1024 * 1024


def serialize(item, fields):
    return {field: value.isoformat() if isinstance(value, datetime) else value
            for field in fields for value in [getattr(item, field)]}


def bounded(query, cap=MAX_ROWS):
    rows = query.limit(cap + 1).all()
    if len(rows) > cap:
        raise HTTPException(413, detail={"error": {"code": "ACCOUNT_EXPORT_LIMIT",
            "message": "账号数据超出单次导出上限，请使用个人记录分模块导出或联系管理员分批导出。"}})
    return rows


def export_account(db, user_id):
    # Auth has already started a transaction. Use a separate read snapshot.
    isolation = 'REPEATABLE READ' if db.bind.dialect.name == 'postgresql' else 'SERIALIZABLE'
    with db.bind.connect().execution_options(isolation_level=isolation) as connection:
        with Session(bind=connection) as snapshot:
            user = snapshot.get(User, user_id)
            if not user or not user.is_active:
                raise HTTPException(401, detail="账号已失效")
            payload = {
                'format': 'geiit-server-account-v2',
                'account': serialize(user, ['id', 'username', 'email', 'is_active', 'created_at', 'updated_at']),
                'coverage': {
                    'included': ['account', 'document_metadata_including_deleted', 'conversations_including_inactive',
                                 'messages', 'notes', 'todos', 'reminders_including_archived', 'reminder_deliveries'],
                    'excluded': ['original_files', 'vectors', 'server_credentials', 'audit_and_mail_bodies',
                                 'client_workbench', 'client_local_knowledge', 'external_files'],
                    'snapshot': 'one_database_read_transaction', 'max_rows_per_module': MAX_ROWS,
                    'max_messages': MAX_MESSAGES, 'max_bytes': MAX_BYTES,
                },
                'exported_at': datetime.now(UTC).isoformat(),
            }
            docs = bounded(snapshot.query(Document).filter(Document.user_id == user_id).order_by(Document.id))
            payload['documents'] = [serialize(d, ['id', 'title', 'file_name', 'file_type', 'file_size', 'status',
                'visibility', 'is_deleted', 'deleted_at', 'quality_score', 'chunk_count', 'total_tokens', 'created_at', 'updated_at']) for d in docs]
            convs = bounded(snapshot.query(Conversation).filter(Conversation.user_id == user_id).order_by(Conversation.id))
            messages = bounded(snapshot.query(Message).join(Conversation).filter(Conversation.user_id == user_id)
                               .order_by(Message.id), MAX_MESSAGES)
            by_conversation = {}
            for message in messages:
                by_conversation.setdefault(message.conversation_id, []).append(serialize(message,
                    ['id', 'role', 'content', 'token_count', 'model_used', 'response_time_ms', 'feedback',
                     'feedback_text', 'is_degraded', 'created_at']))
            payload['conversations'] = [{**serialize(c, ['id', 'title', 'turn_count', 'is_pinned', 'is_active',
                'created_at', 'updated_at']), 'messages': by_conversation.get(c.id, [])} for c in convs]
            for key, model, fields in [
                ('notes', Note, ['id', 'title', 'content', 'tags', 'revision', 'created_at', 'updated_at']),
                ('todos', Todo, ['id', 'title', 'content', 'tags', 'status', 'priority', 'due_at', 'completed_at', 'revision', 'created_at', 'updated_at']),
                ('reminders', Reminder, ['id', 'todo_id', 'revision', 'recipient', 'subject', 'body', 'timezone',
                    'recurrence', 'anchor_at', 'next_run_at', 'status', 'last_run_at', 'archived_at', 'created_at', 'updated_at']),
            ]:
                rows = bounded(snapshot.query(model).filter(model.user_id == user_id).order_by(model.id))
                payload[key] = [serialize(r, fields) for r in rows]
            deliveries = bounded(snapshot.query(ReminderDelivery).join(Reminder).filter(Reminder.user_id == user_id)
                                 .order_by(ReminderDelivery.id), MAX_MESSAGES)
            payload['reminder_deliveries'] = [serialize(d, ['id', 'reminder_id', 'revision', 'scheduled_at',
                'status', 'attempts', 'retry_limit', 'next_attempt_at', 'last_attempt_at', 'error_code', 'created_at']) for d in deliveries]
            content = json.dumps(payload, ensure_ascii=False)
            if len(content.encode('utf-8')) > MAX_BYTES:
                raise HTTPException(413, detail={"error": {"code": "ACCOUNT_EXPORT_LIMIT", "message": "导出超过 16 MiB 上限，请分模块导出。"}})
    return Response(content, media_type='application/json', headers={
        'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="geiit-server-account.json"'})
