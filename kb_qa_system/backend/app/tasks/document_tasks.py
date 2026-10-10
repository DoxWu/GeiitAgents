"""
文档处理异步任务

作用：
    定义 Celery 任务，异步执行文档处理流水线。
    上传文档后由路由触发任务，worker 在后台执行：
        解析 → 清洗 → 表格提取 → 图片处理 → 分块 → 向量化 → 状态更新

    优势：
        1. 不阻塞 HTTP 请求，上传接口立即返回
        2. 任务失败自动重试（指数退避）
        3. 支持任务状态查询和进度展示
        4. 长文档处理可分时执行，避免超时

实现方式：
    1. @celery_app.task 装饰器声明任务
    2. bind=True 使任务可访问 self（用于重试和状态更新）
    3. autoretry_for + exponential backoff 实现自动重试
    4. 任务内部使用独立的数据库会话（不与 Web 请求共享）
"""

import logging
from typing import Optional

from app.core.celery_app import celery_app
from app.core.database import SessionLocal
from app.core.config import settings
from app.models.document import Document

logger = logging.getLogger(__name__)


# ============================================
# 任务1：处理文档
# ============================================

@celery_app.task(
    name="app.tasks.document_tasks.process_document",
    bind=True,  # 使任务可访问 self
    autoretry_for=(Exception,),
    retry_kwargs={"max_retries": settings.CELERY_TASK_MAX_RETRIES},
    retry_backoff=True,  # 指数退避
    retry_backoff_max=600,  # 最大重试间隔 10 分钟
    retry_jitter=True,  # 随机抖动，避免任务同时重试
    time_limit=settings.CELERY_TASK_TIMEOUT,  # 硬超时
    soft_time_limit=settings.CELERY_TASK_TIMEOUT - 30,  # 软超时（提前 30s 抛异常）
    acks_late=True,  # 任务执行完成后才确认，避免 worker 崩溃丢失任务
)
def process_document_task(self, document_id: int) -> dict:
    """
    处理文档任务（Celery 异步执行）

    作用：
        执行完整的文档处理流水线：
        解析 → 清洗 → 表格提取 → 图片处理 → 分块 → 向量化

        由上传接口触发，worker 在后台执行。
        前端可通过 task_id 查询任务状态和进度。

    实现方式：
        1. 从数据库加载文档记录
        2. 更新状态为 processing
        3. 调用 DocumentPipeline.process 执行流水线
        4. 把 chunks 传给 VectorStoreService.add_chunks 向量化
        5. 更新文档状态、质量分、块数等
        6. 失败时更新状态并抛出异常（触发重试）

    参数：
        self: Task - Celery 任务实例（bind=True 时可用）
        document_id: int - 文档ID

    返回:
        dict - 处理结果摘要
            {
                "document_id": 1,
                "status": "completed",
                "chunk_count": 50,
                "quality_score": 85.5,
                "quality_issues": [],
                "duration_ms": 12000
            }

    异常:
        任务失败会抛出异常，由 Celery 自动重试
        重试次数耗尽后标记文档为 failed
    """
    logger.info(f"开始处理文档（task_id={self.request.id}, document_id={document_id}）")

    # 创建独立的数据库会话
    # 作用：Celery worker 不在 Web 请求上下文中，需要独立会话
    db = SessionLocal()

    try:
        # 1. 加载文档记录
        document = db.query(Document).filter(Document.id == document_id).first()
        if not document:
            logger.error(f"文档不存在: {document_id}")
            raise ValueError(f"文档不存在: {document_id}")
        if document.is_deleted:
            return {"document_id": document_id, "status": "deleted"}

        # 2. 更新状态为处理中
        document.status = "processing"
        document.processing_step = "parsing"
        document.processing_progress = 0
        document.task_id = self.request.id
        document.error_message = None
        db.commit()

        # 3. 执行文档处理流水线
        # 作用：调用 document_pipeline 完成解析、清洗、表格、图片、分块
        from app.services.document_pipeline.pipeline import get_document_pipeline
        pipeline = get_document_pipeline()

        # 计算文件哈希（用于去重）
        file_hash = pipeline.compute_file_hash(document.file_path)
        if file_hash:
            document.file_hash = file_hash

        # 修复 Issue 5：定义进度回调，流水线每步推进时实时写入数据库
        # 作用：此前只在 pipeline.process() 返回后才把 processing_progress 写入 DB，
        #       导致前端轮询任务状态时一直看到 0%，处理完成后又跳到 100%。
        #       修复后：流水线每开始一个步骤/更新进度时，立即 commit 到数据库，
        #       前端轮询 GET /documents/{id}/task-status 即可看到增量进度。
        def on_progress(step: str, progress: int) -> None:
            try:
                # 重新查询避免 detached instance
                doc = db.query(Document).filter(Document.id == document_id).first()
                if doc and doc.status == "processing":
                    doc.processing_step = step
                    doc.processing_progress = progress
                    db.commit()
            except Exception as cb_err:
                logger.warning(f"进度回调写入DB失败（doc_id={document_id}）: {cb_err}")
                db.rollback()

        ctx = pipeline.process(
            file_path=document.file_path,
            file_type=document.file_type,
            file_name=document.file_name,
            document_id=document.id,
            document_title=document.title,
            progress_callback=on_progress,
        )

        # 4. 把处理进度同步到数据库
        # 作用：前端可通过文档详情接口查看处理进度
        document.processing_step = ctx.processing_step
        document.processing_progress = ctx.processing_progress
        document.quality_score = ctx.quality_score
        document.quality_issues = ctx.quality_issues if ctx.quality_issues else None
        db.commit()

        # 5. 检查处理是否成功
        if ctx.processing_step == "failed":
            document.status = "failed"
            # 修复 Issue 3：提供更详细的错误原因
            # 作用：此前只存 "; ".join(ctx.quality_issues)，信息可能不够具体。
            #       修复后：保留具体质量问题列表，便于用户排查。
            error_detail = "; ".join(ctx.quality_issues) if ctx.quality_issues else "处理流水线执行失败（未知原因）"
            document.error_message = error_detail[:500]
            db.commit()
            logger.error(
                f"文档处理失败（document_id={document_id}）: {ctx.quality_issues}"
            )
            # 抛出异常触发重试
            raise RuntimeError(f"文档处理失败: {error_detail}")

        # 6. 向量化并存入 pgvector
        # 作用：把分块交给向量存储服务
        # C-5 修复：入库前先删除旧分块，保证幂等
        # 作用：Celery 重试时若不清理旧分块，add_chunks 会重复插入，导致向量重复
        #       （检索结果重复、存储浪费）。修复后：先 delete_document_chunks（幂等），
        #       再 add_chunks。即使重试 N 次，最终向量数据仍为单份。
        #       首次处理时无旧分块，delete 是 no-op，开销可忽略。
        chunk_count = 0
        if ctx.chunks:
            # 修复 Issue 5：向量化阶段更新进度，避免进度条卡在 85%
            try:
                document.processing_step = "embedding"
                document.processing_progress = 90
                db.commit()
            except Exception:
                db.rollback()

            from app.services.vector_store import get_vector_store
            vector_store = get_vector_store()

            # C-5: 先清理旧分块（处理重试场景）
            # 作用：首次处理时无旧分块，delete 是 no-op；重试时清理上次的部分插入
            #       delete 失败不阻塞 add（降级策略，最坏情况是重复，与原状态一致）
            try:
                vector_store.delete_document_chunks(document.id)
            except Exception as e:
                logger.warning(
                    f"清理旧分块失败（doc_id={document.id}），继续插入: {e}"
                )

            chunk_dicts = ctx.to_chunk_dicts()
            chunk_count = vector_store.add_chunks(chunk_dicts, document_id=document.id)

        # 7. 更新文档为完成状态
        document.status = "completed"
        document.chunk_count = chunk_count
        document.content = ctx.cleaned_text[:100000] if ctx.cleaned_text else None  # 限制长度
        # 计算 total_tokens
        total_tokens = sum(c.token_count for c in ctx.chunks)
        document.total_tokens = total_tokens
        # 8. 标记低质量文档
        if ctx.quality_score < settings.DOCUMENT_QUALITY_THRESHOLD:
            document.status = "low_quality"
            logger.warning(
                f"文档质量分偏低（{ctx.quality_score}），标记为 low_quality"
            )

        # A31: success and old-version retirement share one commit. On failure
        # the old document and vectors remain active; new partial vectors stay hidden.
        from app.services.document_lifecycle import activate_replacement
        activate_replacement(db, document)
        db.commit()

        result = {
            "document_id": document.id,
            "status": document.status,
            "chunk_count": chunk_count,
            "quality_score": ctx.quality_score,
            "quality_issues": ctx.quality_issues,
            "duration_ms": ctx.total_duration_ms,
            "page_count": len(ctx.pages),
            "table_count": len(ctx.tables),
            "image_count": len(ctx.images),
        }

        logger.info(
            f"文档处理完成（document_id={document_id}）: "
            f"status={document.status}, chunks={chunk_count}, "
            f"quality={ctx.quality_score}, duration={ctx.total_duration_ms}ms"
        )

        return result

    except Exception as e:
        # 任务失败，更新状态
        logger.error(f"文档处理任务失败（document_id={document_id}）: {e}", exc_info=True)
        try:
            document = db.query(Document).filter(Document.id == document_id).first()
            if document:
                document.status = "failed"
                # 修复 Issue 3 + H-9：提供更详细的错误原因，同时避免泄露敏感信息
                # 作用：此前只存 f"{type(e).__name__}: 文档处理失败"，信息过于笼统，
                #       用户无法判断失败原因（是文件损坏、格式不支持、还是服务异常）。
                #       修复后：根据异常类型和消息生成更有针对性的错误描述，
                #       详细堆栈已由上方 logger.error(exc_info=True) 记录到日志。
                # H-9: error_message 使用 type(e).__name__ 而非 str(e)，避免泄露内部异常细节
                error_type = type(e).__name__
                error_msg = str(e)
                # 脱敏：移除可能包含的文件路径、内部配置等敏感信息
                import re as _re
                safe_msg = _re.sub(r'/[^\s<>"\']+', '[路径]', error_msg)  # 替换文件路径
                safe_msg = _re.sub(r'(?:password|api_key|token|secret)\s*[:=]\s*\S+', '[凭据]', safe_msg, flags=_re.IGNORECASE)
                # 限制长度并生成最终错误信息
                if safe_msg and safe_msg != "":
                    document.error_message = f"{error_type}: {safe_msg}"[:500]
                else:
                    document.error_message = f"{error_type}: 文档处理失败"[:500]
                document.processing_step = "failed"
                db.commit()
        except Exception as inner_e:
            logger.error(f"更新失败状态时出错: {inner_e}")

        # 重新抛出，触发 Celery 重试
        raise

    finally:
        db.close()


# ============================================
# 任务2：重新处理文档
# ============================================

@celery_app.task(
    name="app.tasks.document_tasks.reprocess_document",
    bind=True,
    autoretry_for=(Exception,),
    retry_kwargs={"max_retries": settings.CELERY_TASK_MAX_RETRIES},
    retry_backoff=True,
    retry_backoff_max=600,
    retry_jitter=True,
    time_limit=settings.CELERY_TASK_TIMEOUT,
    soft_time_limit=settings.CELERY_TASK_TIMEOUT - 30,
    acks_late=True,
)
def reprocess_document_task(self, document_id: int) -> dict:
    """
    重新处理文档任务

    作用：
        删除旧的分块数据，重新执行处理流水线。
        用于文档处理失败后重试、或调整处理参数后重新处理。

    实现方式：
        1. 删除旧的向量数据
        2. 重置文档状态
        3. 调用 process_document_task 重新处理

    参数：
        self: Task - Celery 任务实例
        document_id: int - 文档ID

    返回:
        dict - 处理结果摘要
    """
    logger.info(f"重新处理文档（document_id={document_id}）")

    db = SessionLocal()
    try:
        document = db.query(Document).filter(Document.id == document_id).first()
        if not document:
            raise ValueError(f"文档不存在: {document_id}")

        # 1. 删除旧的向量数据
        # 作用：避免新旧数据共存导致检索重复
        try:
            from app.services.vector_store import get_vector_store
            vector_store = get_vector_store()
            vector_store.delete_document_chunks(document_id)
            logger.info(f"已删除文档 {document_id} 的旧分块数据")
        except Exception as e:
            logger.warning(f"删除旧分块数据失败（可忽略）: {e}")

        # 2. 重置文档状态
        document.status = "pending"
        document.processing_step = "uploaded"
        document.processing_progress = 0
        document.chunk_count = 0
        document.total_tokens = 0
        document.error_message = None
        document.quality_score = None
        document.quality_issues = None
        db.commit()

    finally:
        db.close()

    # 3. 异步触发处理任务（L-3 修复：使用 .delay() 而非直接函数调用）
    # 作用：原实现直接调用 process_document_task(document_id) 绕过了 Celery 的
    #       autoretry_for 重试机制（直接函数调用不经过 Celery 任务执行路径）。
    # 修复：使用 .delay() 异步触发，process_document_task 自身的重试配置生效。
    # 返回值：不再直接返回处理结果，而是返回任务已派发的状态，前端可轮询文档状态。
    task = process_document_task.delay(document_id)
    logger.info(f"已派发文档处理任务（document_id={document_id}, task_id={task.id}）")
    return {
        "document_id": document_id,
        "status": "processing",
        "task_id": task.id,
        "message": "文档重处理已启动，请轮询文档状态获取进度",
    }


# ============================================
# 任务3：批量处理文档
# ============================================

@celery_app.task(
    name="app.tasks.document_tasks.batch_process_documents",
    bind=True,
    time_limit=settings.CELERY_TASK_TIMEOUT * 5,  # 批量任务超时延长
    soft_time_limit=settings.CELERY_TASK_TIMEOUT * 5 - 30,
)
def batch_process_documents_task(self, document_ids: list) -> dict:
    """
    批量处理文档任务

    作用：
        批量处理多个文档，逐个调用 process_document_task。
        用于初始化导入、批量重新处理等场景。

    实现方式：
        1. 遍历 document_ids
        2. 对每个文档调用 process_document_task（同步调用函数，不开子任务）
        3. 统计成功/失败数量

    参数：
        self: Task - Celery 任务实例
        document_ids: list - 文档ID列表

    返回:
        dict - 批量处理结果
            {
                "total": 10,
                "success": 8,
                "failed": 2,
                "failed_ids": [3, 7]
            }
    """
    logger.info(f"批量处理 {len(document_ids)} 个文档")

    success_count = 0
    failed_ids = []

    for doc_id in document_ids:
        try:
            process_document_task(doc_id)
            success_count += 1
        except Exception as e:
            logger.error(f"文档 {doc_id} 处理失败: {e}")
            failed_ids.append(doc_id)

    result = {
        "total": len(document_ids),
        "success": success_count,
        "failed": len(failed_ids),
        "failed_ids": failed_ids,
    }

    logger.info(f"批量处理完成：成功 {success_count}，失败 {len(failed_ids)}")
    return result


# ============================================
# 任务4：清理过期数据
# ============================================

@celery_app.task(
    name="app.tasks.document_tasks.cleanup_expired_data",
    time_limit=3600,  # 1 小时超时
)
def cleanup_expired_data_task() -> dict:
    """
    清理过期数据任务（定时执行）

    作用：
        清理过期数据，释放存储空间：
        1. 清理软删除超过 30 天的文档
        2. 清理孤立的图片文件
        3. 清理过期的任务结果

    实现方式：
        1. 查询 is_deleted=True 且 deleted_at 超过 30 天的文档
        2. 删除文件和数据库记录
        3. 统计清理数量

    返回:
        dict - 清理结果
    """
    from datetime import datetime, timedelta
    import os

    logger.info("开始清理过期数据")

    db = SessionLocal()
    try:
        # 30 天前
        threshold = datetime.now() - timedelta(days=30)

        # 查询软删除超过 30 天的文档
        expired_docs = db.query(Document).filter(
            Document.is_deleted == True,
            Document.deleted_at < threshold,
        ).all()

        cleaned_count = 0
        for doc in expired_docs:
            # 删除文件
            try:
                if os.path.exists(doc.file_path):
                    os.remove(doc.file_path)
            except Exception as e:
                logger.warning(f"删除文件失败（doc_id={doc.id}）: {e}")

            # 删除向量数据
            try:
                from app.services.vector_store import get_vector_store
                get_vector_store().delete_document_chunks(doc.id)
            except Exception as e:
                logger.warning(f"删除向量失败（doc_id={doc.id}）: {e}")

            # 删除数据库记录
            db.delete(doc)
            cleaned_count += 1

        db.commit()

        result = {
            "cleaned_documents": cleaned_count,
            "threshold_days": 30,
        }

        logger.info(f"清理完成：删除 {cleaned_count} 个过期文档")
        return result

    finally:
        db.close()
