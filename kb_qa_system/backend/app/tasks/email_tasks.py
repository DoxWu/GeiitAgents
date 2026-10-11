"""
邮件发送 Celery 异步任务

作用：
    在 Celery Worker 中异步执行邮件发送，避免阻塞 API 响应。
    对明确被限流的邮件可自动重试；投递结果不明时进入 unknown，禁止自动重发。

实现方式：
    1. @celery_app.task 装饰器声明任务
    2. 从 email_logs 表读取渲染后的 HTML 内容
    3. 调用 email_service.send_email_sync 发送
    4. 更新 email_logs 状态和发送时间
    5. 失败时脱敏记录错误信息，触发 Celery 重试

重试策略：
    - 明确的 429：Celery 指数退避，最多重试 3 次
    - 超时、连接中断、响应缺少邮件 ID 或 worker 发送中断：unknown，不自动重发
    - 明确的 4xx：failed，并记录安全状态码
"""

import logging
from datetime import datetime, timezone

from app.core.celery_app import celery_app
from app.core.database import SessionLocal
from app.core.config import settings
from app.models.email_log import EmailLog
from app.services.email_service import (
    EmailDeliveryOutcomeUnknown,
    EmailDeliveryRejected,
    send_email_sync,
)

logger = logging.getLogger(__name__)


@celery_app.task(
    name="app.tasks.email_tasks.send_email",
    bind=True,
    autoretry_for=(Exception,),
    dont_autoretry_for=(EmailDeliveryOutcomeUnknown,),
    retry_kwargs={"max_retries": 3},
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
    time_limit=120,
    soft_time_limit=90,
    acks_late=True,
    queue="email",
)
def send_email_task(self, email_log_id: int) -> dict:
    """
    异步邮件发送任务

    作用：
        从 email_logs 表读取邮件信息，调用 SMTP 发送，更新发送状态。

    幂等性：
        如果 email_logs.status 已为 "sent"，直接返回，不重复发送。
        防止 Celery 重试导致重复发送。

    参数：
        self: Task - Celery 任务实例（bind=True 时可用）
        email_log_id: int - email_logs 表记录 ID

    返回:
        dict - 发送结果
            {"email_log_id": 1, "status": "sent"}  # 成功
            {"email_log_id": 1, "status": "already_sent"}  # 幂等跳过
    """
    # Reminder retries use the durable outbox, not generic Celery autoretry.
    with SessionLocal() as lookup:
        reminder_log = lookup.query(EmailLog).filter(EmailLog.id == email_log_id, EmailLog.reminder_id.isnot(None)).first()
    if reminder_log is not None:
        from app.services.personal_reminders import deliver
        return deliver(SessionLocal, email_log_id, send_email_sync,
                       lambda: settings.EMAIL_ENABLED and settings.REMINDERS_ENABLED)
    if not settings.EMAIL_ENABLED:
        logger.info("邮件未发送：邮件功能已停用（email_log_id=%s）", email_log_id)
        return {"email_log_id": email_log_id, "status": "disabled"}
    db = SessionLocal()
    send_started = False
    try:
        # 查询邮件日志记录
        log = db.query(EmailLog).filter(EmailLog.id == email_log_id).first()
        if log is None:
            logger.error(f"邮件日志记录不存在（email_log_id={email_log_id}）")
            raise ValueError(f"EmailLog {email_log_id} 不存在")

        # 幂等检查：已发送的邮件不重复发送
        # 作用：Celery 重试时避免重复发送
        if log.status == EmailLog.STATUS_SENT:
            logger.info(f"邮件已发送，跳过（email_log_id={email_log_id}）")
            return {"email_log_id": email_log_id, "status": "already_sent"}
        if log.status == EmailLog.STATUS_UNKNOWN:
            return {"email_log_id": email_log_id, "status": "delivery_outcome_unknown"}

        if log.status == "cancelled" or not log.html_body:
            return {"email_log_id": email_log_id, "status": "cancelled"}

        # Compare-and-set prevents duplicate queue messages from sending concurrently.
        claimed = (
            db.query(EmailLog)
            .filter(
                EmailLog.id == email_log_id,
                EmailLog.status == EmailLog.STATUS_PENDING,
            )
            .update(
                {
                    EmailLog.status: EmailLog.STATUS_SENDING,
                    EmailLog.celery_task_id: self.request.id,
                },
                synchronize_session=False,
            )
        )
        if claimed != 1:
            db.rollback()
            current = db.query(EmailLog).filter(EmailLog.id == email_log_id).first()
            if current is None:
                return {"email_log_id": email_log_id, "status": "missing"}
            if current.status == EmailLog.STATUS_SENDING:
                if current.celery_task_id == self.request.id:
                    current.status = EmailLog.STATUS_UNKNOWN
                    current.error_message = "delivery_outcome_unknown"
                    db.commit()
                    logger.error(
                        "邮件任务在发送中断开（email_log_id=%s），标记结果不确定",
                        email_log_id,
                    )
                    return {"email_log_id": email_log_id, "status": "delivery_outcome_unknown"}
                return {"email_log_id": email_log_id, "status": "delivery_in_progress"}
            if current.status == EmailLog.STATUS_SENT:
                return {"email_log_id": email_log_id, "status": "already_sent"}
            if current.status == EmailLog.STATUS_UNKNOWN:
                return {"email_log_id": email_log_id, "status": "delivery_outcome_unknown"}
            return {"email_log_id": email_log_id, "status": current.status}

        db.commit()
        log.status = EmailLog.STATUS_SENDING
        log.celery_task_id = self.request.id
        send_started = True

        # 调用邮件发送服务（双通道：HTTP API 主 / SMTP 备用，由 EMAIL_PROVIDER 配置决定）
        # send_email_sync 内部根据配置自动选择通道
        send_email_sync(
            to=log.recipient,
            subject=log.subject,
            html_body=log.html_body,
        )

        # 发送成功：更新状态
        log.status = EmailLog.STATUS_SENT
        log.sent_at = datetime.now(timezone.utc)
        log.error_message = None
        db.commit()

        logger.info("邮件发送成功（email_log_id=%s）", email_log_id)
        return {"email_log_id": email_log_id, "status": "sent"}

    except EmailDeliveryRejected as e:
        db.rollback()
        log = db.query(EmailLog).filter(EmailLog.id == email_log_id).first()
        if log:
            log.retry_count = (log.retry_count or 0) + 1
            log.error_message = e.error_code
            log.status = EmailLog.STATUS_PENDING if e.status_code == 429 else EmailLog.STATUS_FAILED
            db.commit()
        if e.status_code == 429:
            raise
        logger.error(
            "邮件发送被供应商拒绝（email_log_id=%s, status=%s）",
            email_log_id,
            e.status_code,
        )
        return {"email_log_id": email_log_id, "status": "failed"}
    except EmailDeliveryOutcomeUnknown:
        db.rollback()
        log = db.query(EmailLog).filter(EmailLog.id == email_log_id).first()
        if log:
            log.status = EmailLog.STATUS_UNKNOWN
            log.error_message = "delivery_outcome_unknown"
            db.commit()
        logger.error("邮件投递结果不确定（email_log_id=%s）；需在供应商控制台核对后再决定是否重发", email_log_id)
        return {"email_log_id": email_log_id, "status": "delivery_outcome_unknown"}
    except Exception as e:
        db.rollback()
        log = db.query(EmailLog).filter(EmailLog.id == email_log_id).first()
        if send_started or (log and log.status == EmailLog.STATUS_SENDING):
            if log:
                log.retry_count = (log.retry_count or 0) + 1
                log.status = EmailLog.STATUS_UNKNOWN
                log.error_message = "delivery_outcome_unknown"
                db.commit()
            logger.error(
                "邮件发送结果不确定（email_log_id=%s, error_type=%s）",
                email_log_id,
                type(e).__name__,
            )
            return {"email_log_id": email_log_id, "status": "delivery_outcome_unknown"}
        if log:
            log.retry_count = (log.retry_count or 0) + 1
            log.error_message = type(e).__name__
            log.status = EmailLog.STATUS_PENDING
            db.commit()

        logger.error(
            "邮件发送失败（email_log_id=%s, retry_count=%s）: %s",
            email_log_id,
            log.retry_count if log else "?",
            type(e).__name__,
        )
        # Pre-send database/configuration errors can be retried without duplicate delivery.
        raise
    finally:
        db.close()
