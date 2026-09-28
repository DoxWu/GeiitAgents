"""
Celery 配置模块

作用：
    配置 Celery 异步任务队列，用于处理耗时的后台任务：
    - 文档解析与向量化
    - 文档重新处理
    - 定时任务（如清理过期数据）

实现方式：
    1. 使用 Redis 作为 broker 和 result backend
    2. 配置任务序列化、超时、重试
    3. 自动发现 tasks 模块中的任务
"""

import os
from celery import Celery
from celery.schedules import crontab
from kombu import Queue
from typing import Any

from app.core.config import settings

import logging

# 模块日志器
# 作用：记录 Celery 任务状态查询异常等关键事件（H-10 修复配套）
logger = logging.getLogger(__name__)


# ============================================
# 创建 Celery 应用
# ============================================

"""
作用：
    创建 Celery 应用实例，管理异步任务。

参数说明：
    - name: Celery 应用名称
    - broker: 消息代理（Redis）
    - backend: 结果存储（Redis）
"""

celery_app = Celery(
    "kb_qa_system",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=[
        "app.tasks.document_tasks",  # 文档处理任务
        "app.tasks.email_tasks",     # 邮件发送任务
        "app.tasks.cleanup_tasks",   # D10-03 数据清理任务
        "app.tasks.reminder_tasks",
    ],  # 自动发现的任务模块
)

# 修复 P-04：显式启用启动时 broker 连接重试
# 作用：Celery 5.4 中 broker_connection_retry 将在 6.0 弃用，
#       改用 broker_connection_retry_on_startup 显式控制启动时的连接重试行为。
#       设为 True 确保 Redis broker 不可用时 worker 启动会重试而非直接退出。
celery_app.conf.broker_connection_retry_on_startup = True

# ============================================
# Celery 配置
# ============================================

celery_app.conf.update(
    # ============================================
    # 序列化配置
    # ============================================
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Shanghai",  # 时区
    enable_utc=True,

    # ============================================
    # 任务执行配置
    # ============================================
    # 任务超时（秒）
    task_time_limit=settings.CELERY_TASK_TIMEOUT,
    # 软超时（秒），超时前会抛出 SoftTimeLimitExceeded
    task_soft_time_limit=settings.CELERY_TASK_TIMEOUT - 30,
    # 任务最大重试次数
    task_max_retries=settings.CELERY_TASK_MAX_RETRIES,
    # 默认重试延迟（秒）
    task_default_retry_delay=60,

    # ============================================
    # Worker 配置
    # ============================================
    # Worker 并发数（默认 CPU 核心数）
    worker_concurrency=int(os.getenv("CELERY_WORKER_CONCURRENCY", "2")),
    # 每个 Worker 进程最多执行多少个任务后重启（避免内存泄漏）
    worker_max_tasks_per_child=100,
    # Worker 预取任务数（设为 1 避免长任务阻塞短任务）
    worker_prefetch_multiplier=1,

    # ============================================
    # 结果存储配置
    # ============================================
    # 结果过期时间（秒），7 天
    result_expires=7 * 24 * 3600,
    # 不存储任务返回值（节省内存，按需开启）
    task_ignore_result=False,

    # ============================================
    # 任务队列配置
    # ============================================
    task_default_queue="default",
    task_queues=(
        Queue("default", routing_key="default.#"),
        Queue("document", routing_key="document.#"),  # 文档处理队列
        Queue("embedding", routing_key="embedding.#"),  # 向量化队列
        Queue("email", routing_key="email.#"),  # 邮件发送队列
        Queue("dead_letter", routing_key="dead_letter.#"),  # D6-02 死信队列：失败任务最终归宿
    ),
    # D6-02 死信队列配置
    # 作用：Worker 异常退出时拒绝任务（而非直接 ack），允许任务被重新路由或进入死信队列
    task_reject_on_worker_lost=True,
    task_routes={
        "app.tasks.document_tasks.process_document": {
            "queue": "document",
            "routing_key": "document.process",
        },
        "app.tasks.document_tasks.reprocess_document": {
            "queue": "document",
            "routing_key": "document.reprocess",
        },
        "app.tasks.email_tasks.send_email": {
            "queue": "email",
            "routing_key": "email.send",
        },
        "app.tasks.reminder_tasks.dispatch_due_reminders": {
            "queue": "email",
            "routing_key": "email.reminders",
        },
    },

    # ============================================
    # 重试配置
    # ============================================
    # 任务失败自动重试
    task_autoretry_for=(Exception,),
    # 重试间隔（秒），指数退避
    task_retry_backoff=True,
    task_retry_backoff_max=600,  # 最大重试间隔
    task_retry_jitter=True,  # 随机抖动，避免任务同时重试

    # ============================================
    # 监控配置
    # ============================================
    # 发送任务事件（供 Flower 监控）
    worker_send_task_events=True,
    task_send_sent_event=True,

    # ============================================
    # 定时任务配置（D10-03 数据保留策略）
    # ============================================
    # 作用：由 Celery beat 进程调度，按 crontab 定义的时间执行指定任务
    # 部署：需单独启动 beat 进程（celery -A app.core.celery_app beat）
    beat_schedule={
        "cleanup-expired-data": {
            "task": "app.tasks.cleanup_tasks.cleanup_expired_data",
            "schedule": crontab(hour=3, minute=0),  # 每日凌晨 03:00 执行
        },
        "dispatch-due-reminders": {
            "task": "app.tasks.reminder_tasks.dispatch_due_reminders",
            "schedule": 60.0,
        },
    },
)


# ============================================
# 任务状态查询辅助函数
# ============================================

def get_task_status(task_id: str) -> dict:
    """
    查询任务状态

    作用：
        根据 task_id 查询 Celery 任务的状态和结果。
        用于前端轮询文档处理进度。

    参数：
        task_id: str - Celery 任务ID

    返回：
        dict - 任务状态信息
        格式：
        {
            "task_id": "xxx",
            "status": "PENDING|STARTED|SUCCESS|FAILURE|RETRY",
            "result": Any,  # 任务结果（成功时）
            "error": str,   # 错误信息（失败时）
            "progress": int,  # 进度百分比（0-100）
        }
    """
    from celery.result import AsyncResult

    result = AsyncResult(task_id, app=celery_app)

    # 构建状态信息
    status_info = {
        "task_id": task_id,
        "status": result.status,  # PENDING / STARTED / SUCCESS / FAILURE / RETRY
        "result": None,
        "error": None,
        "progress": 0,
    }

    # 根据状态填充信息
    if result.successful():
        status_info["result"] = result.result
        status_info["progress"] = 100
    elif result.failed():
        # 任务失败
        # H-10 修复：不向客户端返回原始异常字符串，避免泄露内部路径/SQL 等敏感信息
        # 作用：原实现 str(exc) 可能暴露文件路径、数据库连接串、堆栈等
        #       修复后：客户端只看到通用错误提示，详细异常记日志供运维排查
        exc = result.result
        logger.error(f"Celery 任务失败（task_id={task_id}）: {exc}", exc_info=True)
        status_info["error"] = "任务执行失败，请联系管理员或查看服务日志"
        status_info["progress"] = 0
    elif result.status == "STARTED":
        status_info["progress"] = 50  # 简化，实际应从任务内部上报进度
    elif result.status == "RETRY":
        status_info["error"] = "任务重试中"
        status_info["progress"] = 0

    return status_info
