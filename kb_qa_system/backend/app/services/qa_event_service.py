"""
问答事件服务（质量埋点）

作用：
    封装 QAEvent 的创建逻辑，在每次问答完成后记录全链路质量指标。
    这些数据用于后续的质量分析、优化决策和告警。

    典型指标：
    - 回答成功率/失败率/降级率
    - 检索耗时、LLM 耗时、总耗时分布
    - 重试次数分布、超时率
    - Token 消耗和成本
    - 模型使用分布
    - 用户反馈（点赞/点踩）准确率

实现方式：
    1. 提供 record_event 方法，从 RAG 返回的 metrics 中提取指标
    2. 根据降级状态和异常信息设置 status 字段
    3. 关联 message_id / conversation_id / user_id
    4. 埋点失败不影响主流程（catch all）

使用方式：
    from app.services.qa_event_service import qa_event_service

    # 在问答完成后记录
    qa_event_service.record_event(
        db=db,
        message_id=msg.id,
        conversation_id=conv.id,
        user_id=user.id,
        question=question,
        answer=answer,
        metrics=result["metrics"],
        degraded=result["degraded"],
        degrade_reason=result["degrade_reason"],
        total_time_ms=total_ms,
    )
"""

import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List

from sqlalchemy import func, cast, Date, case
from sqlalchemy.orm import Session

from app.models.qa_event import QAEvent

logger = logging.getLogger(__name__)


class QAEventService:
    """
    问答事件服务

    作用：
        封装 QAEvent 的创建和查询逻辑。
        所有埋点操作都是"尽力而为"——失败只记日志，不影响主业务流程。
    """

    def record_event(
        self,
        db: Session,
        message_id: Optional[int],
        conversation_id: Optional[int],
        user_id: Optional[int],
        question: str,
        answer: Optional[str],
        metrics: Dict[str, Any],
        degraded: bool = False,
        degrade_reason: Optional[str] = None,
        total_time_ms: int = 0,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> Optional[QAEvent]:
        """
        记录一次问答事件

        作用：
            在 RAG 问答完成后，将全链路指标持久化到 qa_events 表。
            埋点失败不抛异常，只记日志（避免影响主业务）。

        实现方式：
            1. 从 metrics 字典提取各分项指标
            2. 根据 degraded 和 error 信息推导 status
            3. 创建 QAEvent 记录并提交
            4. 异常时回滚并记日志

        参数：
            db: Session - 数据库会话
            message_id: Optional[int] - 关联的消息 ID
            conversation_id: Optional[int] - 对话 ID
            user_id: Optional[int] - 用户 ID
            question: str - 用户问题
            answer: Optional[str] - AI 回答（失败时可能为空）
            metrics: Dict[str, Any] - RAG 返回的质量指标
                包含：retrieval_count, retrieval_top_score, retrieval_time_ms,
                      llm_time_ms, retry_count, token_input, token_output, model_used
            degraded: bool - 是否降级兜底
            degrade_reason: Optional[str] - 降级原因
            total_time_ms: int - 总耗时（毫秒）
            error_code: Optional[str] - 错误码
            error_message: Optional[str] - 错误详情

        返回:
            Optional[QAEvent] - 创建的事件记录，失败返回 None
        """
        try:
            # 推导事件状态
            # 规则：degraded → "degraded"；有 error → "failed"；否则 → "success"
            status = self._derive_status(degraded, error_code)

            # 限制 answer 字段长度（避免超长回答撑爆数据库）
            # 作用：Text 类型虽然能存长文本，但埋点无需完整回答，截断到 2000 字
            # A03: telemetry contains metrics, never copied conversation payloads.

            event = QAEvent(
                message_id=message_id,
                conversation_id=conversation_id,
                user_id=user_id,
                question="",
                answer=None,
                status=status,
                degraded=degraded,
                degrade_reason=degrade_reason,
                # 检索指标
                retrieval_count=metrics.get("retrieval_count", 0),
                retrieval_top_score=metrics.get("retrieval_top_score", 0.0),
                retrieval_time_ms=metrics.get("retrieval_time_ms", 0),
                # LLM 指标
                llm_time_ms=metrics.get("llm_time_ms", 0),
                retry_count=metrics.get("retry_count", 0),
                token_input=metrics.get("token_input", 0),
                token_output=metrics.get("token_output", 0),
                model_used=metrics.get("model_used", ""),
                # 总体指标
                total_time_ms=total_time_ms,
                # 错误信息
                error_code=error_code,
                error_message=None,
            )

            # M-11 修复：使用独立 session 隔离埋点写入，避免 rollback 影响 caller session
            # 作用：原实现复用调用方 db session，commit/rollback 失败后 session 中
            #       conversation 等对象被 expire，后续 maybe_generate_summary 访问
            #       turn_count 等属性触发懒加载可能失败。
            #       修复后：使用独立 SessionLocal 写入埋点，失败时 close 释放连接，
            #       调用方 session 完全不受影响（对象保持有效）。
            # 代价：额外占用一个连接池连接（仅 INSERT 期间，毫秒级），可接受。
            from app.core.database import SessionLocal
            qa_db = SessionLocal()
            try:
                qa_db.add(event)
                qa_db.commit()
                qa_db.refresh(event)

                logger.info(
                    f"QA 事件已记录: status={status}, retrieval={metrics.get('retrieval_count', 0)}条, "
                    f"llm_time={metrics.get('llm_time_ms', 0)}ms, total={total_time_ms}ms, "
                    f"degraded={degraded}"
                )
                return event
            finally:
                qa_db.close()

        except Exception as e:
            # 埋点失败不影响主业务，只记日志
            # 作用：质量埋点是辅助功能，绝不能因埋点异常导致用户问答失败
            logger.error(f"QA 事件记录失败（不影响主流程）: {e}", exc_info=True)
            # M-11 修复：不再 rollback 调用方 session，独立 session 已在 finally 中 close
            return None

    def _derive_status(
        self,
        degraded: bool,
        error_code: Optional[str],
    ) -> str:
        """
        推导事件状态

        作用：
            根据 degraded 标记和 error_code 推导 QAEvent 的 status 字段。

        推导规则：
            - 有 error_code 且非降级 → "failed"（彻底失败）
            - degraded=True → "degraded"（降级兜底，用户仍收到回复）
            - 其他 → "success"（正常成功）

        参数：
            degraded: bool - 是否降级
            error_code: Optional[str] - 错误码

        返回:
            str - 状态值（success / degraded / failed）
        """
        if error_code and not degraded:
            return "failed"
        if degraded:
            return "degraded"
        return "success"

    def record_feedback(
        self,
        db: Session,
        message_id: int,
        feedback: str,
        feedback_text: Optional[str] = None,
    ) -> bool:
        """
        记录用户反馈（点赞/点踩）

        作用：
            用户对回答点赞或点踩时，更新对应的 QAEvent 记录。
            用于计算回答准确率。

        参数：
            db: Session - 数据库会话
            message_id: int - 消息 ID（关联 qa_events.message_id）
            feedback: str - 反馈类型（positive / negative）
            feedback_text: Optional[str] - 用户附加说明

        返回:
            bool - 是否更新成功
        """
        try:
            event = db.query(QAEvent).filter(
                QAEvent.message_id == message_id
            ).first()

            if event is None:
                logger.warning(f"未找到 message_id={message_id} 对应的 QA 事件，无法记录反馈")
                return False

            event.user_feedback = feedback
            if feedback_text:
                event.feedback_text = feedback_text[:1000]

            db.commit()
            logger.info(f"用户反馈已记录: message_id={message_id}, feedback={feedback}")
            return True

        except Exception as e:
            logger.error(f"记录用户反馈失败: {e}", exc_info=True)
            db.rollback()
            return False

    # ============================================
    # 质量看板聚合查询
    # ============================================

    def get_overview(
        self,
        db: Session,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        获取质量总体概览

        作用：
            统计指定时间范围内的问答质量总览数据，用于看板首屏展示。
            包含成功率、降级率、平均耗时、Token 消耗、用户反馈等核心指标。

        实现方式：
            1. 构建时间范围过滤条件
            2. 用 SQLAlchemy 聚合函数一次性查询各统计值
            3. 分别统计 success/degraded/failed 的数量
            4. 统计用户反馈（点赞/点踩）数量
            5. 计算比率（成功率、降级率、反馈率、准确率）

        参数：
            db: Session - 数据库会话
            start_time: Optional[datetime] - 开始时间（None 表示不限制）
            end_time: Optional[datetime] - 结束时间（None 表示到现在）

        返回:
            Dict[str, Any] - 概览数据
            包含：total, success_count, degraded_count, failed_count,
                  success_rate, degraded_rate, failed_rate,
                  avg_total_time_ms, avg_retrieval_time_ms, avg_llm_time_ms,
                  avg_retry_count, total_token_input, total_token_output,
                  positive_count, negative_count, feedback_rate, accuracy_rate
        """
        try:
            # 构建基础查询（带时间范围过滤）
            # 作用：所有统计都基于同一时间范围
            base_query = db.query(QAEvent)
            if start_time:
                base_query = base_query.filter(QAEvent.created_at >= start_time)
            if end_time:
                base_query = base_query.filter(QAEvent.created_at <= end_time)

            # 总数
            total = base_query.count()
            if total == 0:
                return self._empty_overview()

            # 各状态计数
            # 作用：计算成功率、降级率、失败率
            success_count = base_query.filter(QAEvent.status == "success").count()
            degraded_count = base_query.filter(QAEvent.status == "degraded").count()
            failed_count = base_query.filter(QAEvent.status == "failed").count()

            # 耗时和 Token 聚合
            # 作用：用 avg/sum 一次查询多个聚合值，减少 DB 往返
            agg = base_query.with_entities(
                func.coalesce(func.avg(QAEvent.total_time_ms), 0).label("avg_total"),
                func.coalesce(func.avg(QAEvent.retrieval_time_ms), 0).label("avg_retrieval"),
                func.coalesce(func.avg(QAEvent.llm_time_ms), 0).label("avg_llm"),
                func.coalesce(func.avg(QAEvent.retry_count), 0).label("avg_retry"),
                func.coalesce(func.sum(QAEvent.token_input), 0).label("total_in"),
                func.coalesce(func.sum(QAEvent.token_output), 0).label("total_out"),
            ).first()

            # 用户反馈统计
            # 作用：计算反馈率和准确率（点赞占比）
            positive_count = base_query.filter(
                QAEvent.user_feedback == "positive"
            ).count()
            negative_count = base_query.filter(
                QAEvent.user_feedback == "negative"
            ).count()

            feedback_total = positive_count + negative_count

            return {
                "total": total,
                "success_count": success_count,
                "degraded_count": degraded_count,
                "failed_count": failed_count,
                # 比率（保留 4 位小数）
                "success_rate": round(success_count / total, 4),
                "degraded_rate": round(degraded_count / total, 4),
                "failed_rate": round(failed_count / total, 4),
                # 平均耗时（毫秒，四舍五入）
                "avg_total_time_ms": round(float(agg.avg_total)),
                "avg_retrieval_time_ms": round(float(agg.avg_retrieval)),
                "avg_llm_time_ms": round(float(agg.avg_llm)),
                "avg_retry_count": round(float(agg.avg_retry), 2),
                # Token 消耗总量
                "total_token_input": int(agg.total_in),
                "total_token_output": int(agg.total_out),
                # 用户反馈
                "positive_count": positive_count,
                "negative_count": negative_count,
                "feedback_rate": round(feedback_total / total, 4) if total else 0,
                "accuracy_rate": round(positive_count / feedback_total, 4) if feedback_total else None,
            }

        except Exception as e:
            logger.error(f"获取质量概览失败: {e}", exc_info=True)
            return self._empty_overview()

    def _empty_overview(self) -> Dict[str, Any]:
        """
        返回空的概览数据

        作用：
            当无数据或查询失败时返回零值概览，保证前端渲染不报错。

        返回:
            Dict[str, Any] - 全部为零值的概览数据
        """
        return {
            "total": 0,
            "success_count": 0,
            "degraded_count": 0,
            "failed_count": 0,
            "success_rate": 0,
            "degraded_rate": 0,
            "failed_rate": 0,
            "avg_total_time_ms": 0,
            "avg_retrieval_time_ms": 0,
            "avg_llm_time_ms": 0,
            "avg_retry_count": 0,
            "total_token_input": 0,
            "total_token_output": 0,
            "positive_count": 0,
            "negative_count": 0,
            "feedback_rate": 0,
            "accuracy_rate": None,
        }

    def get_timeline(
        self,
        db: Session,
        days: int = 7,
    ) -> List[Dict[str, Any]]:
        """
        获取质量时间趋势（按天分组）

        作用：
            统计最近 N 天每天的问答量、成功/降级/失败数、平均耗时，
            用于看板的时间趋势图。

        实现方式：
            1. 计算起始日期（今天 - days + 1）
            2. 按日期分组聚合统计
            3. 补全无数据的日期（填零），保证趋势图连续

        参数：
            db: Session - 数据库会话
            days: int - 统计天数（默认 7 天）

        返回:
            List[Dict[str, Any]] - 按日期升序排列的趋势数据
            每条：{date, total, success, degraded, failed,
                   avg_total_time_ms, avg_retrieval_time_ms, avg_llm_time_ms}
        """
        try:
            # 计算时间范围
            # 作用：days=7 表示最近 7 天（含今天）
            end_date = datetime.now().date()
            start_date = end_date - timedelta(days=days - 1)
            start_datetime = datetime.combine(start_date, datetime.min.time())

            # 按日期分组聚合
            # 作用：cast(created_at, Date) 截取日期部分用于分组
            #       case 表达式实现条件计数（统计各状态的数量）
            daily_stats = db.query(
                cast(QAEvent.created_at, Date).label("date"),
                func.count(QAEvent.id).label("total"),
                func.sum(case((QAEvent.status == "success", 1), else_=0)).label("success"),
                func.sum(case((QAEvent.degraded == True, 1), else_=0)).label("degraded"),
                func.sum(case((QAEvent.status == "failed", 1), else_=0)).label("failed"),
                func.coalesce(func.avg(QAEvent.total_time_ms), 0).label("avg_total"),
                func.coalesce(func.avg(QAEvent.retrieval_time_ms), 0).label("avg_retrieval"),
                func.coalesce(func.avg(QAEvent.llm_time_ms), 0).label("avg_llm"),
            ).filter(
                QAEvent.created_at >= start_datetime
            ).group_by(
                cast(QAEvent.created_at, Date)
            ).order_by(
                cast(QAEvent.created_at, Date)
            ).all()

            # 转为字典并补全无数据日期
            # 作用：保证趋势图 X 轴连续，无数据日显示为零
            stats_map = {
                row.date: {
                    "date": row.date.isoformat(),
                    "total": row.total,
                    "success": row.success,
                    "degraded": int(row.degraded or 0),
                    "failed": row.failed,
                    "avg_total_time_ms": round(float(row.avg_total)),
                    "avg_retrieval_time_ms": round(float(row.avg_retrieval)),
                    "avg_llm_time_ms": round(float(row.avg_llm)),
                }
                for row in daily_stats
            }

            # 按天补全
            timeline = []
            for i in range(days):
                current_date = start_date + timedelta(days=i)
                if current_date in stats_map:
                    timeline.append(stats_map[current_date])
                else:
                    timeline.append({
                        "date": current_date.isoformat(),
                        "total": 0,
                        "success": 0,
                        "degraded": 0,
                        "failed": 0,
                        "avg_total_time_ms": 0,
                        "avg_retrieval_time_ms": 0,
                        "avg_llm_time_ms": 0,
                    })

            return timeline

        except Exception as e:
            logger.error(f"获取质量时间趋势失败: {e}", exc_info=True)
            return []

    def get_model_stats(
        self,
        db: Session,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """
        获取模型使用分布统计

        作用：
            按 model_used 分组统计各模型的使用次数、平均耗时、Token 消耗，
            用于分析各模型的性能和成本。

        实现方式：
            1. 构建时间范围过滤
            2. 按 model_used 分组聚合
            3. 排除空模型名（降级兜底可能无模型名）

        参数：
            db: Session - 数据库会话
            start_time: Optional[datetime] - 开始时间
            end_time: Optional[datetime] - 结束时间

        返回:
            List[Dict[str, Any]] - 按使用次数降序排列的模型统计
            每条：{model, count, avg_llm_time_ms, avg_retry_count,
                   total_token_input, total_token_output}
        """
        try:
            query = db.query(
                QAEvent.model_used,
                func.count(QAEvent.id).label("count"),
                func.coalesce(func.avg(QAEvent.llm_time_ms), 0).label("avg_llm"),
                func.coalesce(func.avg(QAEvent.retry_count), 0).label("avg_retry"),
                func.coalesce(func.sum(QAEvent.token_input), 0).label("total_in"),
                func.coalesce(func.sum(QAEvent.token_output), 0).label("total_out"),
            ).filter(
                QAEvent.model_used.isnot(None),
                QAEvent.model_used != "",
            )

            if start_time:
                query = query.filter(QAEvent.created_at >= start_time)
            if end_time:
                query = query.filter(QAEvent.created_at <= end_time)

            results = query.group_by(QAEvent.model_used).order_by(
                func.count(QAEvent.id).desc()
            ).all()

            return [
                {
                    "model": row.model_used,
                    "count": row.count,
                    "avg_llm_time_ms": round(float(row.avg_llm)),
                    "avg_retry_count": round(float(row.avg_retry), 2),
                    "total_token_input": int(row.total_in),
                    "total_token_output": int(row.total_out),
                }
                for row in results
            ]

        except Exception as e:
            logger.error(f"获取模型使用统计失败: {e}", exc_info=True)
            return []

    def get_degradation_stats(
        self,
        db: Session,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """
        获取降级原因分布统计

        作用：
            按 degrade_reason 分组统计各降级原因的次数和占比，
            用于定位系统瓶颈（如 LLM 超时 vs 熔断 vs Embedding 失败）。

        实现方式：
            1. 构建时间范围过滤
            2. 仅统计 degraded=True 的事件
            3. 按 degrade_reason 分组计数
            4. 计算各原因占比

        参数：
            db: Session - 数据库会话
            start_time: Optional[datetime] - 开始时间
            end_time: Optional[datetime] - 结束时间

        返回:
            List[Dict[str, Any]] - 按次数降序排列的降级原因统计
            每条：{reason, count, percentage}
        """
        try:
            query = db.query(
                QAEvent.degrade_reason,
                func.count(QAEvent.id).label("count"),
            ).filter(
                QAEvent.degraded == True,
            )

            if start_time:
                query = query.filter(QAEvent.created_at >= start_time)
            if end_time:
                query = query.filter(QAEvent.created_at <= end_time)

            results = query.group_by(QAEvent.degrade_reason).order_by(
                func.count(QAEvent.id).desc()
            ).all()

            # 计算总数用于百分比
            total = sum(row.count for row in results)

            return [
                {
                    "reason": row.degrade_reason or "unknown",
                    "count": row.count,
                    "percentage": round(row.count / total, 4) if total else 0,
                }
                for row in results
            ]

        except Exception as e:
            logger.error(f"获取降级分析失败: {e}", exc_info=True)
            return []


# ============================================
# 全局实例
# ============================================

qa_event_service = QAEventService()
