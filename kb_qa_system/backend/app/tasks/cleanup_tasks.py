"""
数据清理任务（D10-03 数据保留策略）

作用：
    Celery 定时任务，每日凌晨 03:00 执行，清理超过保留期的数据：
    - 已软删除的对话（is_active=False 且超过保留期）
    - 过期的 QA 事件日志
    - 过期的邮件发送日志
    - 过期的审计日志

实现方式：
    1. 由 Celery beat 调度（crontab hour=3, minute=0）
    2. 根据 config.py 中的 *_RETENTION_DAYS 配置计算截止时间
    3. 使用原生 SQL DELETE 直接删除，避免 ORM 加载大量记录到内存
    4. 记录清理统计到日志，便于运维审计

部署说明：
    需单独启动 Celery beat 进程：celery -A app.core.celery_app beat
    beat 进程会按 beat_schedule 配置的时间自动触发任务
"""

from datetime import datetime, timedelta, timezone
from celery import shared_task
from celery.utils.log import get_task_logger
from sqlalchemy import text

from app.core.config import settings
from app.core.database import SessionLocal

logger = get_task_logger(__name__)


@shared_task(name="app.tasks.cleanup_tasks.cleanup_expired_data")
def cleanup_expired_data() -> dict:
    """
    清理过期数据（定时任务）

    作用：
        按保留策略删除过期数据，防止数据库无限膨胀。
        各表保留期由 config.py 中的 *_RETENTION_DAYS 配置项控制。

    实现方式：
        1. 检查 CLEANUP_ENABLED 开关，关闭时直接跳过
        2. 对每张表计算截止时间（now - retention_days）
        3. 执行 DELETE SQL，记录删除行数
        4. 全部成功后统一 commit，任一失败则 rollback

    返回：
        dict - 各表删除统计
        格式：{"conversations": n, "qa_events": n, "email_logs": n, "audit_logs": n}
        若清理已关闭：{"skipped": True, "reason": "CLEANUP_ENABLED=False"}
    """
    # 开关检查：允许环境级关闭清理（如维护窗口期间）
    if not settings.CLEANUP_ENABLED:
        logger.info("数据清理已关闭（CLEANUP_ENABLED=False），跳过执行")
        return {"skipped": True, "reason": "CLEANUP_ENABLED=False"}

    now = datetime.now(timezone.utc)
    stats = {}

    db = SessionLocal()
    try:
        # 1. 清理已软删除的对话
        # 作用：Conversation 使用 is_active=False 表示软删除，仅清理已软删除且超过保留期的记录
        # 注意：is_active=True 的对话（用户正常使用的）不会被删除
        cutoff = now - timedelta(days=settings.CONVERSATION_RETENTION_DAYS)
        result = db.execute(text(
            "DELETE FROM conversations WHERE is_active = false AND updated_at < :cutoff"
        ), {"cutoff": cutoff})
        stats["conversations"] = result.rowcount

        # 2. 清理 QA 事件日志
        # 作用：QAEvent 是问答事件日志，按 created_at 物理删除，无需软删除
        cutoff = now - timedelta(days=settings.QA_EVENT_RETENTION_DAYS)
        result = db.execute(text(
            "DELETE FROM qa_events WHERE created_at < :cutoff"
        ), {"cutoff": cutoff})
        stats["qa_events"] = result.rowcount

        # 3. 清理邮件发送日志
        # 作用：EmailLog 记录邮件发送历史，按 created_at 物理删除
        cutoff = now - timedelta(days=settings.EMAIL_LOG_RETENTION_DAYS)
        result = db.execute(text(
            "DELETE FROM email_logs WHERE created_at < :cutoff "
            "AND NOT EXISTS (SELECT 1 FROM reminder_deliveries WHERE email_log_id = email_logs.id)"
        ), {"cutoff": cutoff})
        stats["email_logs"] = result.rowcount

        # 4. 清理审计日志
        # 作用：AuditLog 记录用户操作审计，按 created_at 物理删除
        # 注意：审计日志保留期最长（默认 365 天），满足合规要求
        cutoff = now - timedelta(days=settings.AUDIT_LOG_RETENTION_DAYS)
        result = db.execute(text(
            "DELETE FROM audit_logs WHERE created_at < :cutoff"
        ), {"cutoff": cutoff})
        stats["audit_logs"] = result.rowcount

        db.commit()
        logger.info(f"数据清理完成: {stats}")
        return stats

    except Exception as e:
        db.rollback()
        logger.error(f"数据清理失败: {e}", exc_info=True)
        raise
    finally:
        db.close()
