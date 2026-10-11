"""
邮件发送服务

作用：
    封装邮件发送逻辑，支持 HTTP API 和 SMTP 双通道，支持 HTML 邮件和异步发送。
    所有邮件发送通过 Celery 异步执行（调用 send_email_sync）。

技术决策：
    1. 双通道设计：
       - 主通道 HTTP API（Resend HTTPS API，不依赖 SMTP 端口）
       - 备用通道 SMTP（aiosmtplib，本地开发或无 SMTP 限制环境）
       - 通过 EMAIL_PROVIDER 配置切换（http / smtp）
    2. SMTP 通道使用 email.message.EmailMessage 构建 MIME 邮件（非字符串拼接，防注入）
    3. HTTP API 通道使用 httpx，关闭重定向并区分明确拒绝和未知投递结果
    4. HTML 模板中所有用户输入经 html.escape() 转义（防 XSS）
    5. EMAIL_ENABLED=False 时仅记录日志不发送（开发环境降级）

使用方式：
    # 在 Celery task 中（同步上下文）
    from app.services.email_service import send_email_sync
    send_email_sync(to="user@example.com", subject="主题", html_body="<h1>内容</h1>")

    # 渲染邮件模板
    from app.services.email_service import render_email
    html = render_email("password_setup", username="alice", setup_url="https://...")
"""

import asyncio
import html
import logging
from datetime import datetime
from typing import Optional

import aiosmtplib
import httpx
from email.message import EmailMessage

from app.core.config import settings

logger = logging.getLogger(__name__)


class EmailDeliveryOutcomeUnknown(RuntimeError):
    """The provider may have accepted a message but did not confirm its outcome."""


class EmailDeliveryRejected(RuntimeError):
    """The provider explicitly rejected a message and returned an HTTP status."""

    def __init__(self, status_code: int):
        self.status_code = status_code
        self.error_code = f"resend_http_{status_code}"
        super().__init__(self.error_code)


# ============================================
# Resend HTTP API configuration
# ============================================

def _resend_api_key() -> str:
    api_key = settings.RESEND_API_KEY or settings.SMTP_PASSWORD
    if not api_key:
        raise ValueError("RESEND_API_KEY 未配置，无法使用 HTTP API 通道")
    return api_key


# ============================================
# 邮件模板渲染
# ============================================

def _render_base(content: str) -> str:
    """
    渲染邮件基础模板

    作用：
        所有邮件共用统一的头部、尾部和样式，确保品牌一致性。

    参数：
        content: str - 邮件正文 HTML

    返回：
        str - 完整的 HTML 邮件
    """
    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 0; background: #f3f4f6; }}
    .container {{ max-width: 600px; margin: 20px auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }}
    .header {{ background: #4f46e5; color: white; padding: 24px 30px; }}
    .header h1 {{ margin: 0; font-size: 20px; font-weight: 600; }}
    .content {{ padding: 30px; color: #1f2937; line-height: 1.6; }}
    .content h2 {{ margin-top: 0; color: #111827; font-size: 18px; }}
    .button {{ display: inline-block; background: #4f46e5; color: white !important; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }}
    .info {{ background: #f9fafb; border-left: 3px solid #4f46e5; padding: 12px 16px; margin: 16px 0; font-size: 14px; color: #4b5563; }}
    .warning {{ background: #fef2f2; border-left: 3px solid #dc2626; padding: 12px 16px; margin: 16px 0; font-size: 14px; color: #991b1b; }}
    .footer {{ text-align: center; color: #6b7280; font-size: 12px; padding: 20px 30px; border-top: 1px solid #e5e7eb; }}
    .footer a {{ color: #6b7280; }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>GeiIt 企业知识库</h1>
    </div>
    <div class="content">
      {content}
    </div>
    <div class="footer">
      <p>此邮件由系统自动发送，请勿直接回复。</p>
      <p>© 2026 GeiIt 企业知识库</p>
    </div>
  </div>
</body>
</html>"""


def _render_register_notify_admin(
    applicant_username: str,
    applicant_email: str,
    app_id: int,
    submitted_at: str,
) -> str:
    """
    渲染管理员新申请通知邮件

    作用：
        当用户提交注册申请时，通知管理员审核。
        所有用户输入经 html.escape() 转义，防止 XSS。

    参数：
        applicant_username: str - 申请人用户名（已转义）
        applicant_email: str - 申请人邮箱（已转义）
        app_id: int - 申请 ID（用于邮件展示编号）
        submitted_at: str - 提交时间字符串（已转义）
    """
    # 安全：html.escape 转义所有用户输入，防 XSS
    safe_username = html.escape(applicant_username)
    safe_email = html.escape(applicant_email)
    safe_time = html.escape(submitted_at)

    content = f"""
      <h2>📋 新的注册申请</h2>
      <p>有一位新用户提交了注册申请，请及时审核：</p>
      <div class="info">
        <p><strong>申请人用户名：</strong>{safe_username}</p>
        <p><strong>申请人邮箱：</strong>{safe_email}</p>
        <p><strong>申请编号：</strong>#{app_id}</p>
        <p><strong>提交时间：</strong>{safe_time}</p>
      </div>
      <p>请登录管理后台查看并审批此申请。</p>
    """
    return _render_base(content)


def _render_password_setup(
    username: str,
    setup_url: str,
    expires_hours: int,
) -> str:
    """
    渲染密码设置邀请邮件

    作用：
        管理员批准申请后，发送给用户的密码设置链接邮件。

    参数：
        username: str - 用户名（已转义）
        setup_url: str - 密码设置链接（后端拼接，Token 是安全随机串）
        expires_hours: int - 链接有效期（小时）
    """
    safe_username = html.escape(username)
    # setup_url 中的 token 是 secrets.token_urlsafe 生成的安全字符，无需额外转义
    # 但 URL 中的 & 等字符需要转义以防 HTML 解析问题
    safe_url = html.escape(setup_url, quote=True)

    content = f"""
      <h2>🎉 欢迎加入 GeiIt 企业知识库！</h2>
      <p>您好，<strong>{safe_username}</strong>：</p>
      <p>您的注册申请已通过管理员审核。请点击下方按钮设置您的登录密码：</p>
      <p style="text-align: center;">
        <a href="{safe_url}" class="button">设置密码</a>
      </p>
      <div class="info">
        <p>⏰ 此链接将在 <strong>{expires_hours} 小时</strong> 后失效。</p>
        <p>如果按钮无法点击，请复制以下链接到浏览器打开：</p>
        <p style="word-break: break-all; font-size: 13px; color: #4f46e5;">{safe_url}</p>
      </div>
      <div class="warning">
        <p>🔒 如果您没有提交过注册申请，请忽略此邮件，无需任何操作。</p>
      </div>
    """
    return _render_base(content)


def _render_register_rejected(
    username: str,
    reject_reason: Optional[str],
) -> str:
    """
    渲染申请被拒绝通知邮件

    作用：
        管理员拒绝申请后，通知申请人。

    参数：
        username: str - 用户名（已转义）
        reject_reason: Optional[str] - 拒绝原因（已转义）
    """
    safe_username = html.escape(username)
    reason_html = ""
    if reject_reason:
        safe_reason = html.escape(reject_reason)
        reason_html = f'<div class="info"><p><strong>原因：</strong>{safe_reason}</p></div>'

    content = f"""
      <h2>📢 注册申请未通过</h2>
      <p>您好，<strong>{safe_username}</strong>：</p>
      <p>很遗憾地通知您，您的 GeiIt 企业知识库注册申请未能通过审核。</p>
      {reason_html}
      <p>如有疑问，请联系管理员。</p>
    """
    return _render_base(content)


def _render_account_created(username: str) -> str:
    """
    渲染账号创建确认邮件

    作用：
        用户成功设置密码后，发送确认通知。

    参数：
        username: str - 用户名（已转义）
    """
    safe_username = html.escape(username)

    content = f"""
      <h2>✅ 账号创建成功</h2>
      <p>您好，<strong>{safe_username}</strong>：</p>
      <p>您的 GeiIt 企业知识库账号已成功创建！您现在可以使用邮箱和密码登录系统。</p>
      <div class="info">
        <p>🚀 开始使用：</p>
        <p>1. 访问系统登录页面</p>
        <p>2. 输入您的邮箱和刚设置的密码</p>
        <p>3. 开始管理您的知识库文档</p>
      </div>
    """
    return _render_base(content)


# 邮件类型 → 渲染函数映射
_TEMPLATE_MAP = {
    "register_notify_admin": _render_register_notify_admin,
    "password_setup": _render_password_setup,
    "register_rejected": _render_register_rejected,
    "account_created": _render_account_created,
}

# 邮件类型 → 主题映射
_SUBJECT_MAP = {
    "register_notify_admin": "[GeiIt] 新的注册申请待审核",
    "password_setup": "[GeiIt] 设置您的登录密码",
    "register_rejected": "[GeiIt] 注册申请未通过",
    "account_created": "[GeiIt] 账号创建成功",
}


def render_email(email_type: str, **kwargs) -> str:
    """
    渲染邮件 HTML 内容

    作用：
        根据邮件类型选择模板函数，渲染 HTML 内容。
        纯函数，不发送邮件，便于测试。

    参数：
        email_type: str - 邮件类型（register_notify_admin/password_setup/register_rejected/account_created）
        **kwargs: 模板参数（username, setup_url, expires_hours 等）

    返回：
        str - 渲染后的 HTML 字符串

    异常：
        ValueError - 未知邮件类型
    """
    renderer = _TEMPLATE_MAP.get(email_type)
    if renderer is None:
        raise ValueError(f"未知邮件类型: {email_type}，支持: {list(_TEMPLATE_MAP.keys())}")
    return renderer(**kwargs)


def get_email_subject(email_type: str) -> str:
    """
    获取邮件主题

    作用：
        根据邮件类型返回固定主题（不含用户输入，防 CRLF 注入）。

    参数：
        email_type: str - 邮件类型

    返回：
        str - 邮件主题
    """
    subject = _SUBJECT_MAP.get(email_type)
    if subject is None:
        raise ValueError(f"未知邮件类型: {email_type}")
    return subject


# ============================================
# 邮件发送（双通道：HTTP API 主 + SMTP 备用）
# ============================================

def _send_via_http_api(
    to: str,
    subject: str,
    html_body: str,
) -> str:
    """
    通过 Resend HTTP API 发送邮件（主通道）

    作用：
        使用 Resend 官方 SDK 通过 HTTPS 443 端口发送邮件，
        绕过 Railway 等云平台对 SMTP 端口（25/465/587）的限制。

    优势：
        - HTTPS 443 端口通常不受云平台限制
        - Resend 官方推荐方式，性能优于 SMTP
        - SDK 内部处理重试和错误分类

    参数：
        to: str - 收件人邮箱
        subject: str - 邮件主题（固定文案，不含用户输入）
        html_body: str - HTML 邮件内容（已渲染，用户输入已转义）

    返回：
        str - Resend 返回的邮件 ID（如 "re_123abc"）

    异常：
        ValueError - RESEND_API_KEY 未配置
        EmailDeliveryRejected - Resend explicitly rejected the request
        EmailDeliveryOutcomeUnknown - provider acceptance could not be confirmed
    """
    # 解析发件人地址：从 "Name <email>" 格式提取纯邮箱
    # Resend HTTP API 的 from 字段支持 "Name <email>" 格式
    params = {
        "from": settings.EMAIL_FROM,
        "to": [to],
        "subject": subject,
        "html": html_body,
    }
    api_key = _resend_api_key()
    try:
        with httpx.Client(timeout=30, follow_redirects=False) as client:
            response = client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": "Bearer " + api_key},
                json=params,
            )
    except httpx.RequestError:
        raise EmailDeliveryOutcomeUnknown("resend_delivery_outcome_unknown") from None
    if 400 <= response.status_code < 500:
        raise EmailDeliveryRejected(response.status_code)
    if response.status_code >= 500:
        raise EmailDeliveryOutcomeUnknown("resend_delivery_outcome_unknown")
    try:
        result = response.json()
        email_id = result.get("id") if isinstance(result, dict) else None
    except ValueError:
        email_id = None
    if not isinstance(email_id, str) or not email_id.strip():
        raise EmailDeliveryOutcomeUnknown("resend_delivery_outcome_unknown")
    logger.info(
        "邮件发送成功（HTTP API）| id=%s",
        email_id
    )
    return email_id


async def _send_via_smtp_async(
    to: str,
    subject: str,
    html_body: str,
) -> None:
    """
    通过 SMTP 异步发送邮件（备用通道）

    作用：
        构建 MIME 邮件并通过 aiosmtplib 发送。
        使用 EmailMessage 构建（非字符串拼接），防止邮件头注入。

    适用场景：
        - 本地开发环境（无 SMTP 限制）
        - EMAIL_PROVIDER=smtp 的部署环境

    参数：
        to: str - 收件人邮箱
        subject: str - 邮件主题（固定文案，不含用户输入）
        html_body: str - HTML 邮件内容（已渲染，用户输入已转义）

    异常：
        aiosmtplib.SMTPException - SMTP 发送失败（由 Celery 重试机制处理）
    """
    # 使用 EmailMessage 构建 MIME 邮件
    # 安全：EmailMessage 自动处理头部编码，防止 CRLF 注入
    msg = EmailMessage()
    msg["From"] = settings.EMAIL_FROM
    msg["To"] = to
    msg["Subject"] = subject

    # 设置纯文本备用部分（不支持 HTML 的客户端显示）
    msg.set_content("此邮件为 HTML 格式，请使用支持 HTML 的客户端查看。")

    # 添加 HTML 内容
    msg.add_alternative(html_body, subtype="html")

    # 通过 aiosmtplib 异步发送
    # Resend SMTP: smtp.resend.com:465，SSL 隐式 TLS
    await aiosmtplib.send(
        msg,
        hostname=settings.SMTP_HOST,
        port=settings.SMTP_PORT,
        username=settings.SMTP_USER,
        password=settings.SMTP_PASSWORD,
        use_tls=settings.SMTP_USE_TLS,
        start_tls=settings.SMTP_START_TLS,
        timeout=settings.SMTP_TIMEOUT,
    )
    logger.info("邮件发送成功（SMTP）")


def _send_via_smtp_sync(
    to: str,
    subject: str,
    html_body: str,
) -> None:
    """
    SMTP 通道同步包装（供 Celery 调用）

    作用：
        用 asyncio.run() 包装异步 _send_via_smtp_async，供 Celery 同步 task 调用。
        Celery prefork 子进程无运行中的事件循环，asyncio.run() 安全可用。
    """
    asyncio.run(_send_via_smtp_async(to, subject, html_body))


def send_email_sync(
    to: str,
    subject: str,
    html_body: str,
) -> None:
    """
    同步发送邮件（Celery task 调用入口，双通道自动选择）

    作用：
        根据 EMAIL_PROVIDER 配置选择发送通道：
        - http（默认）：调用 Resend HTTP API（推荐生产环境，不受 SMTP 限制）
        - smtp：调用 SMTP 发送（本地开发或无限制环境）

    通用逻辑：
        - EMAIL_ENABLED=False 时仅记录日志，不实际发送（开发环境降级）
        - 发送失败抛出异常，由 Celery 重试机制处理

    参数：
        to: str - 收件人邮箱
        subject: str - 邮件主题
        html_body: str - HTML 邮件内容

    异常：
        Exception - 发送失败（由 Celery 重试机制处理）
        ValueError - EMAIL_PROVIDER 配置非法或对应通道的 Key 未配置
    """
    # EMAIL_ENABLED=False 时仅记录日志，不连接任何邮件服务
    # 作用：开发环境降级，邮件不发送但业务流程正常
    if not settings.EMAIL_ENABLED:
        logger.info("[EMAIL DISABLED] 邮件未发送（EMAIL_ENABLED=False）")
        return

    provider = settings.EMAIL_PROVIDER.lower()
    if provider == "http":
        _send_via_http_api(to, subject, html_body)
    elif provider == "smtp":
        try:
            _send_via_smtp_sync(to, subject, html_body)
        except Exception:
            raise EmailDeliveryOutcomeUnknown("smtp_delivery_outcome_unknown") from None
    else:
        raise ValueError(
            f"EMAIL_PROVIDER 配置非法（{settings.EMAIL_PROVIDER}），必须为 http 或 smtp"
        )
