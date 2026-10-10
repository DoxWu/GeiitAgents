"""Erase linked payloads in the account deletion transaction."""
from sqlalchemy import and_, or_

from app.models import (
    AuditLog,
    EmailLog,
    QAEvent,
    RegistrationApplication,
    Reminder,
    ReminderDelivery,
)


def erase_account_payloads(db, user, document_ids, conversation_ids):
    # SET NULL removes links, not any names or secrets embedded in payloads.
    db.query(QAEvent).filter(or_(QAEvent.user_id == user.id,
        QAEvent.conversation_id.in_(conversation_ids))).delete(synchronize_session=False)
    logs = db.query(AuditLog).filter(or_(AuditLog.user_id == user.id,
        and_(AuditLog.resource_type == 'user', AuditLog.resource_id == user.id),
        and_(AuditLog.resource_type == 'document', AuditLog.resource_id.in_(document_ids)),
        and_(AuditLog.resource_type == 'conversation', AuditLog.resource_id.in_(conversation_ids))))
    logs.update({AuditLog.user_id: None, AuditLog.resource_id: None, AuditLog.detail: None,
                 AuditLog.ip_address: None, AuditLog.user_agent: None}, synchronize_session=False)
    applications = db.query(RegistrationApplication.id).filter(or_(
        RegistrationApplication.created_user_id == user.id, RegistrationApplication.email == user.email))
    reminder_ids = db.query(Reminder.id).filter(Reminder.user_id == user.id)
    email_ids = db.query(ReminderDelivery.email_log_id).filter(ReminderDelivery.reminder_id.in_(reminder_ids))
    # Keep only minimal delivery status. Workers must never resend erased bodies.
    db.query(EmailLog).filter(or_(EmailLog.recipient == user.email,
        EmailLog.application_id.in_(applications), EmailLog.id.in_(email_ids))).update({
            EmailLog.recipient: 'deleted@example.invalid', EmailLog.subject: '', EmailLog.html_body: '',
            EmailLog.error_message: None, EmailLog.status: 'cancelled', EmailLog.reminder_id: None,
            EmailLog.application_id: None,
        }, synchronize_session=False)
    db.query(RegistrationApplication).filter(RegistrationApplication.id.in_(applications)).delete(synchronize_session=False)
    # Do not call audit_service.log here: it commits the caller's transaction.
    db.add(AuditLog(user_id=None, action='account.delete', resource_type='user', resource_id=None,
                    detail={'result': 'deleted'}, ip_address=None, user_agent=None))
