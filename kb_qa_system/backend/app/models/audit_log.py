"""
审计日志数据模型

作用：
    定义审计日志表结构，记录"谁在什么时间做了什么"的敏感操作日志。
    用于追踪文档删除、权限变更、审批操作等关键行为，满足安全审计和合规要求。

实现方式：
    1. 使用 SQLAlchemy 2.0 声明式模型
    2. 与 User 模型建立多对一关系（user_id 外键，ondelete=SET NULL）
    3. action 和 resource_type 建索引，便于按操作类型和资源类型查询
    4. created_at 建索引，便于按时间范围查询
    5. detail 使用 JSON 类型存储附加信息，灵活扩展

设计说明：
    - user_id 可为空（ondelete=SET NULL）：用户删除后审计日志保留，user_id 置空
    - ip_address 支持 IPv4（15字符）和 IPv6（45字符）
    - user_agent 截断至 500 字符，防止超长 UA 导致存储问题
    - 不存储敏感数据（密码、Token 明文等），只记录操作行为
"""

from datetime import datetime
from typing import Optional
from sqlalchemy import String, DateTime, Text, Integer, ForeignKey, JSON, func, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AuditLog(Base):
    """
    审计日志模型

    作用：
        对应数据库 audit_logs 表，记录系统中的敏感操作日志。

    表结构：
        - id: 主键
        - user_id: 操作人用户ID（外键，用户删除后置空）
        - action: 操作动作（如 document.delete / account.delete / application.approve）
        - resource_type: 资源类型（如 document / user / application）
        - resource_id: 资源ID（可为空，适用于无具体资源的操作）
        - detail: 附加信息（JSON 格式，如文档标题、拒绝原因等）
        - ip_address: 操作者 IP 地址
        - user_agent: 操作者 User-Agent
        - created_at: 操作时间

    action 命名规范：
        {resource_type}.{operation}，例如：
        - document.delete — 删除文档
        - document.upload_public — 上传公共文档
        - account.delete — 删除账户
        - application.approve — 批准注册申请
        - application.reject — 拒绝注册申请
        - superuser.cross_user_access — 超管跨用户访问

    使用方式：
        通过 audit_service.log() 统一记录，不直接实例化本模型。
    """

    __tablename__ = "audit_logs"

    # 主键 ID
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # 操作人用户ID（外键，用户删除后置空以保留审计记录）
    user_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # 操作动作（如 document.delete / account.delete / application.approve）
    # 作用：按动作类型查询审计记录
    action: Mapped[str] = mapped_column(String(50), index=True)

    # 资源类型（如 document / user / application）
    resource_type: Mapped[str] = mapped_column(String(50), index=True)

    # 资源ID（可为空，适用于无具体资源的操作）
    resource_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # 附加信息（JSON 格式）
    # 作用：存储与操作相关的上下文信息，如文档标题、拒绝原因、变更前后值等
    # 示例：{"document_title": "Python指南.pdf", "reason": "用户主动删除"}
    detail: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # 操作者 IP 地址（支持 IPv4 和 IPv6）
    # 作用：安全审计时追溯操作来源
    ip_address: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)

    # 操作者 User-Agent（截断至 500 字符）
    # 作用：识别操作者使用的浏览器/客户端，辅助安全分析
    user_agent: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # 操作时间
    created_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime,
        server_default=func.now(),
        index=True,
        nullable=True,
    )

    # ============================================
    # 索引
    # ============================================

    __table_args__ = (
        # 复合索引：按用户和时间查询（查某用户的操作历史）
        Index("ix_audit_logs_user_created", "user_id", "created_at"),
        # 复合索引：按资源和时间查询（查某资源的操作历史）
        Index("ix_audit_logs_resource_created", "resource_type", "resource_id", "created_at"),
    )

    def __repr__(self) -> str:
        return (
            f"<AuditLog(id={self.id}, user_id={self.user_id}, "
            f"action='{self.action}', resource_type='{self.resource_type}', "
            f"resource_id={self.resource_id})>"
        )
