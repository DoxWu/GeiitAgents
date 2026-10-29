"""
文档权限服务（权限隔离核心模块）

作用：
    实现文档可见性和检索范围控制，确保用户只能访问自己权限内的文档：
    - 个人文档库（private）：仅上传者本人和超级管理员可见、可检索
    - 公共文档库（public）：所有登录用户可见、可检索

    本模块是解决"越权访问"和"检索范围泄漏"问题的核心：
    1. 检索时通过 get_accessible_document_ids 限定可检索的文档 ID 范围，
       从源头防止检索到他人私有文档
    2. 文档详情/管理操作通过 can_access_document / can_manage_document 校验
    3. 公共文档库管理通过 can_manage_public 限制为超级管理员

实现方式：
    1. 基于 Document.visibility 字段过滤
    2. 超级管理员拥有全部权限（绕过可见性限制）
    3. 用户身份由 JWT Token 解析得到（不从请求体读取，防篡改）

使用方式：
    from app.services.permission import permission_service

    # 检索前获取可访问范围
    doc_ids = permission_service.get_accessible_document_ids(db, user_id)
    results = vector_store.search(query, document_ids=doc_ids)

    # 文档操作前校验权限
    if not permission_service.can_access_document(db, user_id, doc_id):
        raise HTTPException(404)
"""

import logging
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.document import Document
from app.models.organization import Organization, OrganizationMembership

logger = logging.getLogger(__name__)


# ============================================
# 可见性常量
# ============================================

# 作用：集中管理可见性取值，避免散落的硬编码字符串
VISIBILITY_PRIVATE = "private"  # 个人文档库
VISIBILITY_PUBLIC = "public"    # 公共文档库

# 合法取值集合（用于校验）
VISIBILITY_ORGANIZATION = "organization"
VALID_VISIBILITIES = {VISIBILITY_PRIVATE, VISIBILITY_PUBLIC, VISIBILITY_ORGANIZATION}


class PermissionService:
    """
    权限服务

    作用：
        提供文档权限相关的查询和校验方法。
        所有方法都是无副作用的纯查询/校验。

    使用方式：
        from app.services.permission import permission_service
        doc_ids = permission_service.get_accessible_document_ids(db, user.id)
    """

    # ============================================
    # 检索范围：获取用户可访问的文档 ID 列表
    # ============================================

    def get_accessible_document_ids(
        self,
        db: Session,
        user_id: int,
        include_deleted: bool = False,
        user_type: str = "regular",
    ) -> List[int]:
        """
        获取用户可访问的文档 ID 列表（用于检索范围限定）

        作用：
            返回用户有权检索的全部文档 ID。
            - regular 用户：该用户上传的所有文档（个人文档库） + 所有公共文档
            - guest 用户（任务5）：仅所有公共文档（visibility=public），不可访问任何私人文档
            3. 自动排除已软删除的文档

            这是检索隔离的核心：检索时传入此列表作为 document_ids 过滤，
            确保不会检索到其他用户的私有文档。

        实现方式：
            - regular：单条 SQL 查询 visibility=public OR user_id=:uid
            - guest：单条 SQL 查询 visibility=public（最小权限）

        参数：
            db: Session - 数据库会话
            user_id: int - 当前用户 ID（来自 JWT Token，不可篡改）
            include_deleted: bool - 是否包含已软删除文档（默认 False，检索时不包含）
            user_type: str - 用户类型（regular/guest，任务5），guest 仅可访问公共库

        返回：
            List[int] - 可访问的文档 ID 列表
            若无可访问文档返回空列表（此时检索应返回空结果）

        示例：
            doc_ids = permission_service.get_accessible_document_ids(db, user.id)
            results = vector_store.search(query, document_ids=doc_ids)
        """
        query = db.query(Document.id).filter(Document.is_deleted == False) if not include_deleted else db.query(Document.id)

        # 任务5：guest 用户仅可访问公共文档库（最小权限原则）
        # 作用：临时用户无个人文档库，仅可检索公共知识库内容
        if user_type == "guest":
            query = query.filter(Document.visibility == VISIBILITY_PUBLIC)
        else:
            # 正式用户：个人文档（自己上传的） OR 公共文档
            organization_ids = self.get_active_organization_ids(db, user_id)
            query = query.filter(
                (Document.visibility == VISIBILITY_PUBLIC)
                | ((Document.visibility == VISIBILITY_PRIVATE) & (Document.user_id == user_id))
                | ((Document.visibility == VISIBILITY_ORGANIZATION) & Document.organization_id.in_(organization_ids))
            )

        # 只取已处理完成的文档参与检索（pending/failed 的文档无分块）
        # 作用：避免检索到尚未向量化的文档
        query = query.filter(Document.status == "completed")

        rows = query.all()
        return [row[0] for row in rows]

    def get_active_organization_ids(self, db: Session, user_id: int) -> List[int]:
        rows = db.query(OrganizationMembership.organization_id).join(
            Organization, Organization.id == OrganizationMembership.organization_id
        ).filter(OrganizationMembership.user_id == user_id,
                 OrganizationMembership.status == "active", Organization.is_active.is_(True)).all()
        return [row[0] for row in rows]

    # ============================================
    # 文档访问权限校验
    # ============================================

    def can_access_document(
        self,
        db: Session,
        user_id: int,
        document_id: int,
        is_superuser: bool = False,
    ) -> bool:
        """
        校验用户是否有权访问指定文档

        作用：
            判断用户能否"查看"该文档（读取详情、检索）。
            通过规则：
            - 超级管理员：可访问所有文档
            - 文档上传者：可访问自己的文档
            - 公共文档：所有登录用户可访问
            - 其他情况：无权访问

        参数：
            db: Session - 数据库会话
            user_id: int - 当前用户 ID
            document_id: int - 要访问的文档 ID
            is_superuser: bool - 当前用户是否是超级管理员

        返回：
            bool - 是否有权访问

        使用方式：
            if not permission_service.can_access_document(db, user.id, doc_id, user.is_superuser):
                raise HTTPException(404, "文档不存在")
        """
        # 超级管理员拥有全部访问权限
        if is_superuser:
            return True

        document = db.query(Document).filter(
            Document.id == document_id,
            Document.is_deleted == False,
        ).first()

        if document is None:
            return False

        # 上传者可访问自己的文档
        if document.visibility == VISIBILITY_ORGANIZATION:
            if document.organization_id is None:
                return False
            return db.query(OrganizationMembership.id).join(
                Organization, Organization.id == OrganizationMembership.organization_id
            ).filter(OrganizationMembership.organization_id == document.organization_id,
                     OrganizationMembership.user_id == user_id,
                     OrganizationMembership.status == "active", Organization.is_active.is_(True)).first() is not None

        if document.user_id == user_id and document.visibility == VISIBILITY_PRIVATE:
            return True

        # 公共文档所有登录用户可访问
        if document.visibility == VISIBILITY_PUBLIC:
            return True

        return False

    # ============================================
    # 文档管理权限校验
    # ============================================

    def can_manage_document(
        self,
        db: Session,
        user_id: int,
        document_id: int,
        is_superuser: bool = False,
    ) -> bool:
        """
        校验用户是否有权"管理"指定文档（删除、重新处理等）

        作用：
            管理操作比访问更严格：
            - 超级管理员：可管理所有文档
            - 文档上传者：可管理自己的文档
            - 公共文档：仅上传者和超级管理员可管理（其他用户只能查看/检索）

        参数：
            同 can_access_document

        返回：
            bool - 是否有权管理

        使用方式：
            if not permission_service.can_manage_document(db, user.id, doc_id, user.is_superuser):
                raise HTTPException(403, "无权操作此文档")
        """
        # 超级管理员可管理所有文档
        if is_superuser:
            return True

        document = db.query(Document).filter(
            Document.id == document_id,
            Document.is_deleted == False,
        ).first()

        if document is None:
            return False

        # 只有上传者能管理自己的文档
        if document.visibility == VISIBILITY_ORGANIZATION and document.organization_id is not None:
            member = db.query(OrganizationMembership).join(
                Organization, Organization.id == OrganizationMembership.organization_id
            ).filter(OrganizationMembership.organization_id == document.organization_id,
                     OrganizationMembership.user_id == user_id,
                     OrganizationMembership.status == "active", Organization.is_active.is_(True)).first()
            return bool(member and (document.user_id == user_id or member.role == "org_admin"))
        return document.user_id == user_id

    # ============================================
    # 公共文档库管理权限
    # ============================================

    def can_manage_public(self, user: User) -> bool:
        """
        校验用户是否有权上传/管理公共文档库

        作用：
            公共文档库影响所有用户，只有超级管理员能上传到公共库。
            普通用户只能上传到自己的个人文档库（private）。

        参数：
            user: User - 当前用户对象

        返回：
            bool - 是否有权管理公共文档库

        设计考虑：
            限制公共库写入权限，避免任意用户往公共库灌入内容。
            如需放开，可在此处扩展（如增加"编辑"角色）。
        """
        return bool(user.is_superuser)

    # ============================================
    # 可见性取值校验
    # ============================================

    def validate_visibility(self, visibility: Optional[str], user: User, db: Session | None = None,
                            organization_id: int | None = None) -> str:
        """
        校验并归一化可见性参数

        作用：
            1. 校验 visibility 取值是否合法（private/public）
            2. 普通用户请求 public 时降级为 private（无权上传公共库）
            3. 未传值时默认 private

        参数：
            visibility: Optional[str] - 用户请求的可见性
            user: User - 当前用户对象

        返回:
            str - 最终生效的可见性（private/public）
        """
        if visibility == VISIBILITY_ORGANIZATION:
            if db is None or organization_id is None:
                raise HTTPException(status_code=400, detail="organization_id_required")
            if db.query(Organization.id).filter(Organization.id == organization_id,
                                                Organization.is_active.is_(True)).first() is None:
                raise HTTPException(status_code=404, detail="organization_not_found")
            if user.is_superuser:
                return visibility
            member = db.query(OrganizationMembership.id).join(
                Organization, Organization.id == OrganizationMembership.organization_id
            ).filter(OrganizationMembership.organization_id == organization_id,
                     OrganizationMembership.user_id == user.id,
                     OrganizationMembership.status == "active", Organization.is_active.is_(True)).first()
            if member is None:
                raise HTTPException(status_code=403, detail="organization_membership_required")
            return visibility

        # 默认私有
        if visibility is None or visibility not in VALID_VISIBILITIES:
            return VISIBILITY_PRIVATE

        # 普通用户无权设为 public，降级为 private
        if visibility == VISIBILITY_PUBLIC and not self.can_manage_public(user):
            logger.info(
                f"普通用户 {user.id} 尝试上传公共文档，已降级为 private"
            )
            return VISIBILITY_PRIVATE

        return visibility


# ============================================
# 全局权限服务实例
# ============================================

# 作用：单例，全应用共享。无状态，线程安全。
permission_service = PermissionService()
