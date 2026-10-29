"""
注册审批路由模块

作用：
    定义用户注册审批流程相关的 API 接口，包括：
    - 提交注册申请（公开，触发管理员通知邮件）
    - 查询申请状态（公开，不含 Token）
    - 管理员查看申请列表（管理员权限）
    - 管理员批准申请（生成密码设置 Token，发送邮件）
    - 管理员拒绝申请（发送拒绝通知邮件）
    - 用户设置密码（用 Token 创建账号）

实现方式：
    1. 使用 FastAPI 的 APIRouter 组织路由（prefix=/auth，与 auth.py 共享前缀）
    2. 所有邮件通过 Celery task 异步发送，API 响应不阻塞
    3. 密码设置 Token 使用 secrets.token_urlsafe(32) 生成，SHA-256 哈希存储
    4. 公开接口配置限流，管理员接口依赖 get_current_superuser
    5. 邮箱级 Redis 锁防止重复提交申请

业务流程：
    用户申请(pending) → 管理员通知邮件
    管理员批准(approved) → 密码设置邮件（含 Token 链接）
    用户设置密码 → 创建 User 账号 → 账号创建确认邮件
    管理员拒绝(rejected) → 拒绝通知邮件
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query, Request
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import Any, Optional
from datetime import datetime, timezone, timedelta
import hashlib
import secrets
import logging

from app.core.database import get_db
from app.core.config import settings
from app.core.redis import RedisManager
from app.core.rate_limit import rate_limit
from app.core.security import hash_password
from app.api.deps import get_current_superuser
from app.models.user import User
from app.models.registration import RegistrationApplication
from app.models.organization import Organization, OrganizationMembership
from app.models.email_log import EmailLog
from app.schemas.registration import (
    RegisterApplyRequest,
    RegisterApplyResponse,
    ApplicationStatusResponse,
    ApplicationListItem,
    ApplicationListResponse,
    ApproveRequest,
    RejectRequest,
    SetPasswordRequest,
    SetPasswordResponse,
)
from app.services.email_service import render_email, get_email_subject
from app.tasks.email_tasks import send_email_task
from app.services.audit_service import audit_service

# 模块日志器
logger = logging.getLogger(__name__)

# 创建路由器
# prefix: /auth（与 auth.py 共享前缀，避免前端 baseURL 重复拼接）
# tags: Swagger UI 中的分组标签
router = APIRouter(prefix="/auth", tags=["注册审批"])


# ============================================
# 辅助函数
# ============================================

def _hash_token(token: str) -> str:
    """
    对密码设置 Token 做 SHA-256 哈希

    作用：
        数据库存储 Token 的哈希值而非明文，防止数据库泄露后 Token 被复用。

    参数：
        token: str - 明文 Token（secrets.token_urlsafe 生成）

    返回：
        str - 64 字符的 SHA-256 十六进制哈希
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _create_email_log(
    db: Session,
    recipient: str,
    email_type: str,
    application_id: Optional[int],
    **template_kwargs,
) -> EmailLog:
    """
    创建邮件日志记录并触发异步发送

    作用：
        1. 渲染邮件 HTML 内容
        2. 创建 EmailLog 记录（status=pending）
        3. 调用 Celery task 异步发送
        4. 返回 EmailLog 对象

    参数：
        db: Session - 数据库会话
        recipient: str - 收件人邮箱
        email_type: str - 邮件类型（register_notify_admin/password_setup/register_rejected/account_created）
        application_id: Optional[int] - 关联的申请 ID
        **template_kwargs: 模板渲染参数

    返回：
        EmailLog - 创建的邮件日志对象
    """
    # 渲染 HTML 内容（纯函数，不发送）
    html_body = render_email(email_type, **template_kwargs)
    # 获取固定主题（不含用户输入，防 CRLF 注入）
    subject = get_email_subject(email_type)

    # 创建 EmailLog 记录
    email_log = EmailLog(
        recipient=recipient,
        subject=subject,
        email_type=email_type,
        status=EmailLog.STATUS_PENDING,
        html_body=html_body,
        application_id=application_id,
    )
    db.add(email_log)
    db.commit()
    db.refresh(email_log)

    # 触发 Celery 异步发送
    # 作用：API 响应不阻塞，邮件在后台发送
    send_email_task.delay(email_log.id)

    logger.info(
        f"邮件任务已提交（email_log_id={email_log.id}, type={email_type}, recipient={recipient}）"
    )
    return email_log


# ============================================
# 1. 提交注册申请
# ============================================

@router.post(
    "/register/apply",
    response_model=RegisterApplyResponse,
    status_code=status.HTTP_201_CREATED,
    summary="提交注册申请",
    # 限流：每小时最多 3 次申请（按 IP/用户）
    # 作用：防止批量申请机器人
    dependencies=[Depends(rate_limit("register_apply", per_hour=3))],
)
def submit_registration_application(
    data: RegisterApplyRequest,
    db: Session = Depends(get_db),
) -> Any:
    """
    提交注册申请接口

    作用：
        用户提交注册申请，系统创建 pending 状态的申请记录，
        并异步发送邮件通知管理员审核。

    实现流程：
        1. 邮箱级 Redis 锁：同一邮箱 1 小时内只能申请一次（防重复提交）
        2. 检查邮箱和用户名是否已被注册用户占用
        3. 检查是否已有 pending 申请
        4. 创建 RegistrationApplication（status=pending）
        5. 异步发送管理员通知邮件（ADMIN_NOTIFY_EMAIL 未配置时降级跳过）

    请求体：
        {
            "email": "user@example.com",
            "username": "zhangsan"
        }

    响应（201）：
        {
            "application_id": 1,
            "status": "pending",
            "message": "注册申请已提交，请等待管理员审核。"
        }

    错误：
        409: 邮箱或用户名已被占用 / 已有待审批申请 / 重复提交
        429: 请求过于频繁
    """
    # 1. 邮箱级 Redis 锁：防止同一邮箱短时间内重复提交
    # 作用：1 小时内同一邮箱只能提交一次申请，防止刷申请
    # 使用 nx=True 原子性获取锁，TTL 3600 秒
    if data.organization_id is not None and db.query(Organization.id).filter(
        Organization.id == data.organization_id, Organization.is_active.is_(True)
    ).first() is None:
        raise HTTPException(status_code=404, detail="organization_not_found")

    apply_lock_key = f"register:apply:lock:{data.email}"
    lock_acquired = RedisManager.set(apply_lock_key, "1", ttl=3600, nx=True)
    if not lock_acquired:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": {
                    "code": "APPLY_TOO_FREQUENT",
                    "message": "该邮箱近期已提交过申请，请 1 小时后再试",
                }
            },
        )

    # 2. 检查邮箱和用户名是否已被注册用户占用
    # 作用：提前拦截，避免审批通过后创建账号时才发现冲突
    existing_user = db.query(User).filter(
        (User.email == data.email) | (User.username == data.username)
    ).first()
    if existing_user:
        if existing_user.email == data.email:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"error": {"code": "EMAIL_EXISTS", "message": "邮箱已被注册"}},
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"error": {"code": "USERNAME_EXISTS", "message": "用户名已被占用"}},
            )

    # 3. 检查是否已有 pending 申请
    # 作用：避免同一邮箱多条 pending 申请堆积
    existing_pending = db.query(RegistrationApplication).filter(
        RegistrationApplication.email == data.email,
        RegistrationApplication.status == RegistrationApplication.STATUS_PENDING,
    ).first()
    if existing_pending:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": {
                    "code": "APPLICATION_EXISTS",
                    "message": "您已有一个待审批的申请，请等待管理员处理",
                }
            },
        )

    # 4. 创建注册申请记录
    application = RegistrationApplication(
        email=data.email,
        username=data.username,
        organization_id=data.organization_id,
        status=RegistrationApplication.STATUS_PENDING,
    )
    db.add(application)
    db.commit()
    db.refresh(application)

    logger.info(
        f"新注册申请（application_id={application.id}, email={data.email}, username={data.username}）"
    )

    # 5. 异步发送管理员通知邮件
    # 降级：ADMIN_NOTIFY_EMAIL 未配置时跳过邮件，申请仍创建
    if settings.ADMIN_NOTIFY_EMAIL:
        try:
            _create_email_log(
                db=db,
                recipient=settings.ADMIN_NOTIFY_EMAIL,
                email_type=EmailLog.TYPE_REGISTER_NOTIFY_ADMIN,
                application_id=application.id,
                applicant_username=application.username,
                applicant_email=application.email,
                app_id=application.id,
                submitted_at=application.submitted_at.strftime("%Y-%m-%d %H:%M:%S")
                    if application.submitted_at else datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            )
        except Exception as e:
            # 邮件发送失败不阻塞申请创建
            # 作用：邮件是辅助通知，申请记录是核心数据
            logger.error(f"管理员通知邮件发送失败（application_id={application.id}）: {type(e).__name__}")
    else:
        logger.warning(
            f"ADMIN_NOTIFY_EMAIL 未配置，跳过管理员通知邮件（application_id={application.id}）"
        )

    return RegisterApplyResponse(
        application_id=application.id,
        status=RegistrationApplication.STATUS_PENDING,
        message="注册申请已提交，请等待管理员审核。审核通过后，您将收到密码设置邮件。",
    )


# ============================================
# 2. 查询申请状态
# ============================================

@router.get(
    "/register/status",
    response_model=ApplicationStatusResponse,
    summary="查询注册申请状态",
    # 限流：每分钟最多 10 次查询
    # 作用：防止枚举探测
    dependencies=[Depends(rate_limit("register_status", per_minute=10))],
)
def get_application_status(
    email: str = Query(..., description="申请人邮箱"),
    db: Session = Depends(get_db),
) -> Any:
    """
    查询注册申请状态接口

    作用：
        申请人通过邮箱查询自己的申请状态。
        响应不含 Token 相关字段（安全要求）。

    实现方式：
        查询该邮箱最新的 RegistrationApplication 记录。

    查询参数：
        email: str - 申请人邮箱

    响应（200）：
        {
            "status": "pending|approved|rejected",
            "email": "user@example.com",
            "username": "zhangsan",
            "submitted_at": "2026-07-10T10:00:00",
            "reviewed_at": null,
            "reject_reason": null
        }

    错误：
        404: 未找到申请记录
    """
    # 查询该邮箱最新的申请记录（按 submitted_at 降序）
    application = db.query(RegistrationApplication).filter(
        RegistrationApplication.email == email
    ).order_by(RegistrationApplication.submitted_at.desc()).first()

    if application is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": {"code": "APPLICATION_NOT_FOUND", "message": "未找到申请记录"}},
        )

    return ApplicationStatusResponse(
        status=application.status,
        email=application.email,
        username=application.username,
        submitted_at=application.submitted_at,
        reviewed_at=application.reviewed_at,
        reject_reason=application.reject_reason,
    )


# ============================================
# 3. 管理员查看申请列表
# ============================================

@router.get(
    "/register/applications",
    response_model=ApplicationListResponse,
    summary="管理员查看注册申请列表",
)
def list_applications(
    status_filter: Optional[str] = Query(None, alias="status", description="状态筛选（pending/approved/rejected）"),
    page: int = Query(1, ge=1, description="页码，从 1 开始"),
    page_size: int = Query(20, ge=1, le=100, description="每页数量，1-100"),
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_superuser),
) -> Any:
    """
    管理员查看注册申请列表接口

    作用：
        管理员分页查看所有注册申请，支持按状态筛选。

    实现方式：
        1. 依赖 get_current_superuser 确保只有管理员能访问
        2. 支持按 status 筛选（pending/approved/rejected）
        3. 按 submitted_at 降序排列（最新申请在前）
        4. 返回分页数据和 pending_count（待审批总数）

    查询参数：
        status: Optional[str] - 状态筛选
        page: int - 页码（默认 1）
        page_size: int - 每页数量（默认 20，最大 100）

    响应（200）：
        {
            "items": [...],
            "total": 50,
            "pending_count": 5
        }

    错误：
        401: 未登录
        403: 非管理员
    """
    # 构建基础查询
    query = db.query(RegistrationApplication)

    # 状态筛选
    if status_filter:
        query = query.filter(RegistrationApplication.status == status_filter)

    # 计算总数
    total = query.count()

    # 计算待审批总数（不受状态筛选影响，始终返回全局 pending 数）
    pending_count = db.query(RegistrationApplication).filter(
        RegistrationApplication.status == RegistrationApplication.STATUS_PENDING
    ).count()

    # 分页查询（按 submitted_at 降序）
    offset = (page - 1) * page_size
    applications = query.order_by(
        RegistrationApplication.submitted_at.desc()
    ).offset(offset).limit(page_size).all()

    # 转换为响应模型
    items = [
        ApplicationListItem(
            id=app.id,
            email=app.email,
            username=app.username,
            status=app.status,
            submitted_at=app.submitted_at,
            reviewed_at=app.reviewed_at,
            reviewed_by=app.reviewed_by,
            reject_reason=app.reject_reason,
        )
        for app in applications
    ]

    return ApplicationListResponse(
        items=items,
        total=total,
        pending_count=pending_count,
    )


# ============================================
# 4. 管理员批准申请
# ============================================

@router.post(
    "/register/approve",
    summary="管理员批准注册申请",
    status_code=status.HTTP_200_OK,
)
def approve_application(
    request: Request,
    body: ApproveRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_superuser),
) -> Any:
    """
    管理员批准注册申请接口

    作用：
        管理员批准 pending 状态的申请，生成密码设置 Token，
        异步发送密码设置邮件给申请人。

    实现流程：
        1. 校验申请存在且 status=pending
        2. 生成 Token：secrets.token_urlsafe(32)（明文存内存，SHA-256 哈希存 DB）
        3. 设置 password_token_hash、password_token_expires_at（now + 24h）
        4. 更新 status=approved、reviewed_at、reviewed_by
        5. 拼接 setup_url，异步发送密码设置邮件

    请求体：
        {
            "application_id": 1
        }

    响应（200）：
        {
            "message": "已批准申请，密码设置邮件已发送"
        }

    错误：
        404: 申请不存在
        409: 申请状态非 pending（已审批）
    """
    # 查询申请
    application = db.query(RegistrationApplication).filter(
        RegistrationApplication.id == body.application_id
    ).first()

    if application is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": {"code": "APPLICATION_NOT_FOUND", "message": "申请不存在"}},
        )

    # 校验状态：只能批准 pending 状态的申请
    if application.status != RegistrationApplication.STATUS_PENDING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": {
                    "code": "APPLICATION_ALREADY_PROCESSED",
                    "message": f"申请已处理（当前状态：{application.status}），无法重复审批",
                }
            },
        )

    # 生成密码设置 Token
    # 安全：secrets.token_urlsafe(32) 生成 43 字符的 URL 安全随机串
    if "organization_id" in body.model_fields_set:
        if body.organization_id is not None and db.query(Organization.id).filter(
            Organization.id == body.organization_id, Organization.is_active.is_(True)
        ).first() is None:
            raise HTTPException(status_code=404, detail="organization_not_found")
        application.organization_id = body.organization_id

    plain_token = secrets.token_urlsafe(32)
    token_hash = _hash_token(plain_token)

    # 计算过期时间（now + 24h）
    expires_at = datetime.now(timezone.utc) + timedelta(
        hours=settings.PASSWORD_TOKEN_EXPIRE_HOURS
    )

    # 更新申请记录
    application.status = RegistrationApplication.STATUS_APPROVED
    application.password_token_hash = token_hash
    application.password_token_expires_at = expires_at
    application.reviewed_at = datetime.now(timezone.utc)
    application.reviewed_by = admin.id

    db.commit()
    db.refresh(application)

    logger.info(
        f"注册申请已批准（application_id={application.id}, admin={admin.username}）"
    )

    # D10-01 审计日志：记录审批操作
    audit_service.log(
        db=db,
        user_id=admin.id,
        action="application.approve",
        resource_type="application",
        resource_id=application.id,
        detail={"email": application.email, "username": application.username},
        request=request,
    )

    # 拼接密码设置链接
    # 作用：前端 /set-password 页面读取 query 参数 token
    setup_url = f"{settings.FRONTEND_BASE_URL}/set-password?token={plain_token}"

    # 异步发送密码设置邮件
    try:
        _create_email_log(
            db=db,
            recipient=application.email,
            email_type=EmailLog.TYPE_PASSWORD_SETUP,
            application_id=application.id,
            username=application.username,
            setup_url=setup_url,
            expires_hours=settings.PASSWORD_TOKEN_EXPIRE_HOURS,
        )
    except Exception as e:
        # 邮件发送失败不回滚审批状态
        # 作用：审批是核心操作，邮件可重发；管理员可通过日志排查
        logger.error(
            f"密码设置邮件发送失败（application_id={application.id}）: {type(e).__name__}"
        )

    return {"message": "已批准申请，密码设置邮件已发送"}


# ============================================
# 5. 管理员拒绝申请
# ============================================

@router.post(
    "/register/reject",
    summary="管理员拒绝注册申请",
    status_code=status.HTTP_200_OK,
)
def reject_application(
    request: Request,
    body: RejectRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_superuser),
) -> Any:
    """
    管理员拒绝注册申请接口

    作用：
        管理员拒绝 pending 状态的申请，异步发送拒绝通知邮件给申请人。

    实现流程：
        1. 校验申请存在且 status=pending
        2. 更新 status=rejected、reviewed_at、reviewed_by、reject_reason
        3. 异步发送拒绝通知邮件（含拒绝原因）

    请求体：
        {
            "application_id": 1,
            "reject_reason": "用户名不符合规范"
        }

    响应（200）：
        {
            "message": "已拒绝申请，通知邮件已发送"
        }

    错误：
        404: 申请不存在
        409: 申请状态非 pending（已审批）
    """
    # 查询申请
    application = db.query(RegistrationApplication).filter(
        RegistrationApplication.id == body.application_id
    ).first()

    if application is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": {"code": "APPLICATION_NOT_FOUND", "message": "申请不存在"}},
        )

    # 校验状态：只能拒绝 pending 状态的申请
    if application.status != RegistrationApplication.STATUS_PENDING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": {
                    "code": "APPLICATION_ALREADY_PROCESSED",
                    "message": f"申请已处理（当前状态：{application.status}），无法重复审批",
                }
            },
        )

    # 更新申请记录
    application.status = RegistrationApplication.STATUS_REJECTED
    application.reviewed_at = datetime.now(timezone.utc)
    application.reviewed_by = admin.id
    application.reject_reason = body.reject_reason

    db.commit()
    db.refresh(application)

    logger.info(
        f"注册申请已拒绝（application_id={application.id}, admin={admin.username}, reason={body.reject_reason}）"
    )

    # D10-01 审计日志：记录拒绝操作
    audit_service.log(
        db=db,
        user_id=admin.id,
        action="application.reject",
        resource_type="application",
        resource_id=application.id,
        detail={
            "email": application.email,
            "username": application.username,
            "reject_reason": body.reject_reason,
        },
        request=request,
    )

    # 异步发送拒绝通知邮件
    try:
        _create_email_log(
            db=db,
            recipient=application.email,
            email_type=EmailLog.TYPE_REGISTER_REJECTED,
            application_id=application.id,
            username=application.username,
            reject_reason=body.reject_reason,
        )
    except Exception as e:
        logger.error(
            f"拒绝通知邮件发送失败（application_id={application.id}）: {type(e).__name__}"
        )

    return {"message": "已拒绝申请，通知邮件已发送"}


# ============================================
# 6. 用户设置密码
# ============================================

@router.post(
    "/set-password",
    response_model=SetPasswordResponse,
    summary="设置密码（通过邮件 Token）",
    # 限流：每小时最多 5 次尝试
    # 作用：防止暴力枚举 Token
    dependencies=[Depends(rate_limit("set_password", per_hour=5))],
)
def set_password(
    body: SetPasswordRequest,
    db: Session = Depends(get_db),
) -> Any:
    """
    设置密码接口（通过邮件 Token 创建账号）

    作用：
        用户从邮件链接中获取 Token，设置密码后创建 User 账号。
        Token 一次性使用，使用后不可重复。

    实现流程：
        1. 计算 Token 的 SHA-256 哈希，查询 RegistrationApplication
        2. 校验：申请存在、status=approved、Token 未使用、未过期
        3. 创建 User 账号（username, email, hashed_password）
        4. 更新申请：password_token_used_at、created_user_id
        5. 异步发送账号创建确认邮件

    安全特性：
        - Token 哈希存储：数据库不存明文 Token
        - 一次性使用：password_token_used_at 标记，使用后不可重复
        - 过期校验：password_token_expires_at 超时拒绝
        - 并发保护：捕获 IntegrityError（用户名/邮箱竞态）

    请求体：
        {
            "token": "xxxxxxxxxxxxxxxx",
            "password": "Secure123"
        }

    响应（200）：
        {
            "success": true,
            "message": "密码设置成功，您现在可以使用邮箱登录了。"
        }

    错误：
        400: Token 无效/已使用/已过期
        409: 用户名或邮箱已被占用（竞态）
    """
    # 1. 计算 Token 哈希并查询申请
    token_hash = _hash_token(body.token)
    application = db.query(RegistrationApplication).filter(
        RegistrationApplication.password_token_hash == token_hash
    ).first()

    # Token 无效
    if application is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": {"code": "INVALID_TOKEN", "message": "无效的设置链接"}},
        )

    # 2. 校验申请状态
    if application.status != RegistrationApplication.STATUS_APPROVED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": {"code": "APPLICATION_NOT_APPROVED", "message": "申请尚未通过审批"}},
        )

    # 3. 校验 Token 是否已使用（一次性）
    if application.password_token_used_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": {"code": "TOKEN_ALREADY_USED", "message": "此设置链接已被使用，请勿重复使用"}},
        )

    # 4. 校验 Token 是否过期
    if application.password_token_expires_at is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": {"code": "INVALID_TOKEN", "message": "无效的设置链接"}},
        )
    # 统一为带时区的 UTC 进行比较
    now = datetime.now(timezone.utc)
    expires_at = application.password_token_expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if now > expires_at:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": {"code": "TOKEN_EXPIRED", "message": "设置链接已过期，请联系管理员重新发送"}},
        )

    if application.organization_id is not None and db.query(Organization.id).filter(
        Organization.id == application.organization_id, Organization.is_active.is_(True)
    ).first() is None:
        raise HTTPException(status_code=409, detail="application_organization_unavailable")

    # 5. 创建 User 账号
    # 安全：密码经 hash_password（bcrypt）加密存储
    new_user = User(
        username=application.username,
        email=application.email,
        hashed_password=hash_password(body.password),
    )
    try:
        db.add(new_user)
        db.flush()
        if application.organization_id is not None:
            db.add(OrganizationMembership(
                organization_id=application.organization_id,
                user_id=new_user.id,
                role="member",
                status="active",
                reviewed_by=application.reviewed_by,
                reviewed_at=datetime.now(timezone.utc).replace(tzinfo=None),
            ))
        db.commit()
        db.refresh(new_user)
    except IntegrityError:
        # 并发保护：审批后到设置密码期间，可能有其他用户注册了相同用户名/邮箱
        # 作用：数据库唯一约束兜底，返回友好错误
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": {"code": "USERNAME_OR_EMAIL_EXISTS", "message": "用户名或邮箱已被占用，请联系管理员"}},
        )

    # 6. 更新申请：标记 Token 已使用，关联创建的用户
    application.password_token_used_at = datetime.now(timezone.utc)
    application.created_user_id = new_user.id
    db.commit()

    logger.info(
        f"账号创建成功（application_id={application.id}, user_id={new_user.id}, username={new_user.username}）"
    )

    # 7. 异步发送账号创建确认邮件
    try:
        _create_email_log(
            db=db,
            recipient=application.email,
            email_type=EmailLog.TYPE_ACCOUNT_CREATED,
            application_id=application.id,
            username=application.username,
        )
    except Exception as e:
        logger.error(
            f"账号创建确认邮件发送失败（application_id={application.id}）: {type(e).__name__}"
        )

    return SetPasswordResponse(
        success=True,
        message="密码设置成功，您现在可以使用邮箱登录了。",
    )
