"""
邮件发送 Celery 异步任务

作用：
    在 Celery Worker 中异步执行邮件发送，避免阻塞 API 响应。
    支持自动重试（3 次，指数退避）和幂等性检查。

实现方式：
    1. @celery_app.task 装饰器声明任务
    2. 从 email_logs 表读取渲染后的 HTML 内容
    3. 调用 email_service.send_email_sync 发送
    4. 更新 email_logs 状态和发送时间
    5. 失败时脱敏记录错误信息，触发 Celery 重试

重试策略：
    - max_retries=3
    - 指数退避：1s, 2s, 4s（+ jitter 随机抖动）
    - backoff_max=300s（最大重试间隔）
    - 3 次都失败：记录到 email_logs（status=failed），不再重试
"""

import logging
from datetime import datetime, timezone

from app.core.celery_app import celery_app
from app.core.database import SessionLocal
from app.core.config import settings
from app.models.email_log import EmailLog
from app.services.email_service import send_email_sync

logger = logging.getLogger(__name__)


@celery_app.task(
    name="app.tasks.email_tasks.send_email",
    bind=True,
    autoretry_for=(Exception,),
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
    db = SessionLocal()
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

        if log.status == "cancelled" or not log.html_body:
            return {"email_log_id": email_log_id, "status": "cancelled"}
        # 记录 Celery 任务 ID
        log.celery_task_id = self.request.id
        db.commit()

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

        logger.info(f"邮件发送成功（email_log_id={email_log_id}, to={log.recipient}）")
        return {"email_log_id": email_log_id, "status": "sent"}

    except Exception as e:
        # 发送失败：脱敏记录错误信息，递增重试计数
        # 安全：error_message 仅存异常类型名，不存原始异常（防泄露内部路径/SMTP 凭证）
        db.rollback()
        log = db.query(EmailLog).filter(EmailLog.id == email_log_id).first()
        if log:
            log.retry_count = (log.retry_count or 0) + 1
            log.error_message = f"{type(e).__name__}: 邮件发送失败"
            log.status = EmailLog.STATUS_FAILED
            db.commit()

        logger.error(
            f"邮件发送失败（email_log_id={email_log_id}, retry_count={log.retry_count if log else '?'}）: {type(e).__name__}",
            exc_info=True,
        )
        # 重新抛出异常，触发 Celery 自动重试
        raise
    finally:
        db.close()
