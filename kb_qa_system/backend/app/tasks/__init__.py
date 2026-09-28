"""
Celery 异步任务模块

作用：
    定义耗时的后台任务，由 Celery worker 异步执行。

子模块：
    - document_tasks: 文档处理任务（解析+清洗+表格+图片+分块+向量化）
    - email_tasks: 邮件发送任务（注册通知、密码设置、审批结果等）
"""

from app.tasks.document_tasks import (
    process_document_task,
    reprocess_document_task,
)
from app.tasks.email_tasks import send_email_task
from app.tasks.reminder_tasks import dispatch_due_reminders

__all__ = [
    "process_document_task",
    "reprocess_document_task",
    "send_email_task",
    "dispatch_due_reminders",
]
