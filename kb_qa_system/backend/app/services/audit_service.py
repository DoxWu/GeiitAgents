"""
审计日志服务

作用：
    提供统一的审计日志记录接口，供各路由模块调用。
    记录"谁在什么时间对什么资源做了什么操作"，满足安全审计和合规要求。

实现方式：
    1. 提供 log() 函数，封装审计日志的创建逻辑
    2. 从 FastAPI Request 对象提取 IP 和 User-Agent
    3. 审计日志写入失败不影响主流程（catch all，仅记日志）
    4. 不存储敏感数据（密码、Token 明文等）

使用方式：
    from app.services.audit_service import audit_service

    audit_service.log(
        db=db,
        user_id=current_user.id,
        action="document.delete",
        resource_type="document",
        resource_id=document_id,
        detail={"title": document.title},
        request=request,
    )
"""

import logging
from typing import Optional, Dict, Any
from sqlalchemy.orm import Session
from fastapi import Request

from app.core.client_ip import get_client_ip
from app.models.audit_log import AuditLog

logger = logging.getLogger(__name__)


class AuditService:
    """
    审计日志服务

    作用：
        统一管理审计日志的创建，确保所有敏感操作都有完整审计记录。
    """

    def log(
        self,
        db: Session,
        user_id: Optional[int],
        action: str,
        resource_type: str,
        resource_id: Optional[int] = None,
        detail: Optional[Dict[str, Any]] = None,
        request: Optional[Request] = None,
    ) -> None:
        """
        记录审计日志

        作用：
            创建一条审计日志记录，捕获操作人、操作内容、来源 IP 等信息。
            写入失败不影响主业务流程（catch all，仅记 warning 日志）。

        参数：
            db: Session - 数据库会话
            user_id: Optional[int] - 操作人用户ID（可为空，如未认证操作）
            action: str - 操作动作（如 "document.delete"）
            resource_type: str - 资源类型（如 "document"）
            resource_id: Optional[int] - 资源ID（可为空）
            detail: Optional[Dict] - 附加信息（JSON 格式）
            request: Optional[Request] - FastAPI 请求对象（用于提取 IP 和 UA）

        使用示例：
            audit_service.log(
                db=db,
                user_id=current_user.id,
                action="document.delete",
                resource_type="document",
                resource_id=doc_id,
                detail={"title": doc.title},
                request=request,
            )
        """
        try:
            # 从请求对象提取 IP 和 User-Agent
            ip_address = self._get_client_ip(request) if request else None
            user_agent = self._get_user_agent(request) if request else None

            audit_entry = AuditLog(
                user_id=user_id,
                action=action,
                resource_type=resource_type,
                resource_id=resource_id,
                detail=detail,
                ip_address=ip_address,
                user_agent=user_agent,
            )
            db.add(audit_entry)
            db.commit()
        except Exception as e:
            # 审计日志写入失败不影响主流程
            # 作用：审计是辅助功能，不能因审计失败导致业务操作回滚
            logger.warning(f"审计日志写入失败（action={action}, resource_id={resource_id}）: {e}")
            try:
                db.rollback()
            except Exception:
                pass

    def _get_client_ip(self, request: Request) -> Optional[str]:
        """
        从请求对象提取客户端真实 IP

        作用：
            识别客户端真实 IP，支持反向代理场景（X-Forwarded-For）。

        实现方式：
            1. 优先从 X-Forwarded-For 头获取（反向代理场景）
            2. 其次从 X-Real-IP 头获取
            3. 最后使用 request.client.host

        参数：
            request: Request - FastAPI 请求对象

        返回：
            Optional[str] - 客户端 IP 地址
        """
        return get_client_ip(request)

    def _get_user_agent(self, request: Request) -> Optional[str]:
        """
        从请求对象提取 User-Agent（截断至 500 字符）

        作用：
            识别操作者使用的浏览器/客户端，辅助安全分析。

        参数：
            request: Request - FastAPI 请求对象

        返回：
            Optional[str] - User-Agent 字符串（截断至 500 字符）
        """
        try:
            ua = request.headers.get("User-Agent", "")
            # 截断至 500 字符，防止超长 UA 导致存储问题
            return ua[:500] if ua else None
        except Exception:
            return None


# 全局审计服务实例
audit_service = AuditService()
