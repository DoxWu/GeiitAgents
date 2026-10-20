"""
邮件系统验证测试（Resend HTTP API 与 SMTP 兼容路径）

作用：
    验证邮件发送服务、Celery 任务、注册审批路由的安全结构和核心逻辑，
    确保邮件系统满足安全合规、用户友好性、功能完整性三大维度要求。

测试策略：
    1. 静态分析测试：直接读取源码文件内容，验证安全结构存在（不导入模块，避免运行时依赖）
    2. behavior 测试：monkeypatch 模拟 SMTP 和 Celery，验证渲染和降级逻辑
    3. 覆盖邮件服务、Celery 任务、注册路由、配置、安全审查六大维度

运行方式：
    cd backend
    python -m pytest tests/test_email_system.py -v
"""

from pathlib import Path
from unittest.mock import patch

import pytest

# ============================================
# 辅助函数：读取源码文件内容（不导入模块，避免依赖问题）
# ============================================

BACKEND_DIR = Path(__file__).parent.parent


def read_source(relative_path: str) -> str:
    """
    读取源码文件内容

    作用：
        直接读取文件内容，不通过 import 导入模块。
        避免因 psycopg/celery/aiosmtplib 等运行时依赖缺失导致测试失败。

    参数：
        relative_path: str - 相对于 backend 目录的路径

    返回：
        str - 文件内容
    """
    file_path = BACKEND_DIR / relative_path
    return file_path.read_text(encoding="utf-8")


# ============================================
# 1. email_service.py 结构验证
# ============================================

class TestEmailServiceStructure:
    """邮件发送服务结构验证"""

    def test_four_template_renderers_exist(self):
        """验证 4 个邮件模板渲染函数存在"""
        source = read_source("app/services/email_service.py")
        assert "def _render_register_notify_admin" in source, "应定义管理员通知模板"
        assert "def _render_password_setup" in source, "应定义密码设置模板"
        assert "def _render_register_rejected" in source, "应定义拒绝通知模板"
        assert "def _render_account_created" in source, "应定义账号创建模板"

    def test_html_escape_for_xss_prevention(self):
        """验证所有模板使用 html.escape 转义用户输入（XSS 防护）"""
        source = read_source("app/services/email_service.py")
        # html.escape 调用次数应 ≥4（每个模板至少一次）
        assert source.count("html.escape(") >= 4, \
            "每个模板至少应调用一次 html.escape 转义用户输入"

    def test_email_message_for_injection_prevention(self):
        """验证使用 EmailMessage 构建邮件（非字符串拼接，防 Header 注入）"""
        source = read_source("app/services/email_service.py")
        assert "from email.message import EmailMessage" in source, \
            "应导入 EmailMessage"
        assert "msg = EmailMessage()" in source, \
            "应使用 EmailMessage() 构建邮件对象，非字符串拼接"

    def test_email_enabled_degradation(self):
        """验证 EMAIL_ENABLED=False 时的开发环境降级逻辑"""
        source = read_source("app/services/email_service.py")
        assert "settings.EMAIL_ENABLED" in source, \
            "应检查 EMAIL_ENABLED 配置"
        assert "[EMAIL DISABLED]" in source, \
            "EMAIL_ENABLED=False 时应记录日志并跳过 SMTP 连接"

    def test_aiosmtplib_send_parameters(self):
        """验证 aiosmtplib.send 调用使用配置参数（非硬编码）"""
        source = read_source("app/services/email_service.py")
        assert "aiosmtplib.send" in source, "应调用 aiosmtplib.send"
        # 关键参数应从 settings 读取，非硬编码
        assert "settings.SMTP_HOST" in source, "SMTP_HOST 应从配置读取"
        assert "settings.SMTP_PORT" in source, "SMTP_PORT 应从配置读取"
        assert "settings.SMTP_PASSWORD" in source, "SMTP_PASSWORD 应从配置读取"
        assert "settings.SMTP_USE_TLS" in source, "SMTP_USE_TLS 应从配置读取"

    def test_subject_map_no_user_input(self):
        """验证邮件主题为固定文案（不含用户输入，防 CRLF 注入）"""
        source = read_source("app/services/email_service.py")
        # _SUBJECT_MAP 中的主题应为固定字符串
        assert '"[GeiIt] 新的注册申请待审核"' in source
        assert '"[GeiIt] 设置您的登录密码"' in source
        assert '"[GeiIt] 注册申请未通过"' in source
        assert '"[GeiIt] 账号创建成功"' in source

    def test_send_email_sync_uses_asyncio_run(self):
        """验证 SMTP 通道用 asyncio.run 包装异步发送"""
        source = read_source("app/services/email_service.py")
        # 双通道重构后：SMTP 通道使用 asyncio.run 包装 _send_via_smtp_async
        assert "asyncio.run(_send_via_smtp_async" in source, \
            "SMTP 通道应使用 asyncio.run 包装异步发送"

    def test_dual_channel_http_api_exists(self):
        """验证 HTTP API 主通道发送函数存在"""
        source = read_source("app/services/email_service.py")
        assert "def _send_via_http_api(" in source, "应定义 _send_via_http_api 函数"
        assert '"https://api.resend.com/emails"' in source
        assert "EmailDeliveryOutcomeUnknown" in source

    def test_dual_channel_smtp_backup_exists(self):
        """验证 SMTP 备用通道发送函数存在"""
        source = read_source("app/services/email_service.py")
        assert "def _send_via_smtp_async(" in source, "应定义 _send_via_smtp_async 函数"
        assert "def _send_via_smtp_sync(" in source, "应定义 _send_via_smtp_sync 同步包装函数"

    def test_send_email_sync_routes_by_provider(self):
        """验证 send_email_sync 根据 EMAIL_PROVIDER 选择通道"""
        source = read_source("app/services/email_service.py")
        assert 'provider == "http"' in source, "应检查 EMAIL_PROVIDER=http"
        assert 'provider == "smtp"' in source, "应检查 EMAIL_PROVIDER=smtp"
        assert "_send_via_http_api(to, subject, html_body)" in source, \
            "http 通道应调用 _send_via_http_api"
        assert "_send_via_smtp_sync(to, subject, html_body)" in source, \
            "smtp 通道应调用 _send_via_smtp_sync"

    def test_http_api_is_single_attempt_and_keeps_credentials_private(self):
        """Resend is called once so an ambiguous timeout cannot trigger a duplicate."""
        source = read_source("app/services/email_service.py")
        assert "httpx.Client(timeout=30, follow_redirects=False)" in source
        assert "import resend" not in source
        # 兼容回退：优先 RESEND_API_KEY，缺失时回退 SMTP_PASSWORD
        assert "settings.RESEND_API_KEY or settings.SMTP_PASSWORD" in source, \
            "应支持 RESEND_API_KEY 回退到 SMTP_PASSWORD"

    def test_http_api_passes_correct_params(self):
        """验证 HTTP API 传递正确的邮件参数"""
        source = read_source("app/services/email_service.py")
        # 应构造包含 from/to/subject/html 的参数字典
        assert '"from": settings.EMAIL_FROM' in source, \
            "应从配置读取 EMAIL_FROM"
        assert '"to": [to]' in source, "收件人应为列表"
        assert '"subject": subject' in source, "应传递主题"
        assert '"html": html_body' in source, "应传递 HTML 内容"

    def test_invalid_provider_raises_error(self):
        """验证非法 EMAIL_PROVIDER 抛出 ValueError"""
        source = read_source("app/services/email_service.py")
        # 应有 else 分支抛出 ValueError
        assert "EMAIL_PROVIDER 配置非法" in source, \
            "非法 EMAIL_PROVIDER 应抛出 ValueError"


# ============================================
# 2. email_tasks.py 结构验证
# ============================================

class TestEmailTasksStructure:
    """Celery 邮件任务结构验证"""

    def test_task_decorator_config(self):
        """验证 Celery task 装饰器配置（重试 + 幂等 + 队列）"""
        source = read_source("app/tasks/email_tasks.py")
        assert '@celery_app.task' in source, "应使用 @celery_app.task 装饰器"
        assert 'autoretry_for=(Exception,)' in source, "应配置自动重试"
        assert '"max_retries": 3' in source, "最大重试次数应为 3"
        assert "retry_backoff=True" in source, "应启用指数退避"
        assert "STATUS_SENDING" in source and "STATUS_UNKNOWN" in source
        assert "delivery_outcome_unknown" in source
        assert "acks_late=True" in source, "应配置 acks_late（消息确认延迟）"
        assert 'queue="email"' in source, "应路由到 email 队列"

    def test_idempotency_check(self):
        """验证幂等检查逻辑（已发送的邮件不重复发送）"""
        source = read_source("app/tasks/email_tasks.py")
        assert "STATUS_SENT" in source, "应检查 STATUS_SENT 状态"
        assert "already_sent" in source, "幂等跳过时应返回 already_sent"

    def test_error_desensitization(self):
        """验证错误信息脱敏（error_message 仅存异常类型名，不含原始堆栈）"""
        source = read_source("app/tasks/email_tasks.py")
        # 错误信息应使用 type(e).__name__，而非 str(e)
        assert "type(e).__name__" in source, \
            "error_message 应仅存异常类型名，不含原始堆栈"
        assert "邮件发送失败" in source

    def test_celery_task_id_recorded(self):
        """验证记录 Celery 任务 ID 到 EmailLog"""
        source = read_source("app/tasks/email_tasks.py")
        assert "celery_task_id" in source, "应记录 celery_task_id"
        assert "self.request.id" in source, "应从 self.request.id 获取任务 ID"


# ============================================
# 3. registration.py 路由结构验证
# ============================================

class TestRegistrationRoutesStructure:
    """注册审批路由结构验证"""

    def test_six_endpoints_exist(self):
        """验证 6 个端点路由路径和函数定义存在"""
        source = read_source("app/api/routes/registration.py")
        # 端点 1: POST /register/apply
        assert '"/register/apply"' in source
        assert "def submit_registration_application" in source
        # 端点 2: GET /register/status
        assert '"/register/status"' in source
        assert "def get_application_status" in source
        # 端点 3: GET /register/applications
        assert '"/register/applications"' in source
        assert "def list_applications" in source
        # 端点 4: POST /register/approve
        assert '"/register/approve"' in source
        assert "def approve_application" in source
        # 端点 5: POST /register/reject
        assert '"/register/reject"' in source
        assert "def reject_application" in source
        # 端点 6: POST /set-password
        assert '"/set-password"' in source
        assert "def set_password" in source

    def test_public_endpoints_rate_limited(self):
        """验证公开端点配置限流"""
        source = read_source("app/api/routes/registration.py")
        assert 'rate_limit("register_apply", per_hour=3)' in source, \
            "申请接口应限流每小时 3 次"
        assert 'rate_limit("register_status", per_minute=10)' in source, \
            "状态查询应限流每分钟 10 次"
        assert 'rate_limit("set_password", per_hour=5)' in source, \
            "设置密码应限流每小时 5 次"

    def test_admin_endpoints_require_superuser(self):
        """验证管理员端点依赖 get_current_superuser"""
        source = read_source("app/api/routes/registration.py")
        # get_current_superuser 应在管理员端点中使用
        assert "get_current_superuser" in source, \
            "管理员端点应依赖 get_current_superuser"

    def test_token_generation_secrets(self):
        """验证 Token 生成使用 secrets.token_urlsafe（安全随机）"""
        source = read_source("app/api/routes/registration.py")
        assert "import secrets" in source, "应导入 secrets 模块"
        assert "secrets.token_urlsafe(32)" in source, \
            "应使用 secrets.token_urlsafe(32) 生成 Token"

    def test_token_hashed_storage(self):
        """验证 Token 使用 SHA-256 哈希存储"""
        source = read_source("app/api/routes/registration.py")
        assert "hashlib.sha256" in source, "应使用 SHA-256 哈希 Token"
        assert "password_token_hash" in source, "应存储到 password_token_hash 字段"

    def test_token_one_time_use_check(self):
        """验证 Token 一次性使用检查"""
        source = read_source("app/api/routes/registration.py")
        assert "password_token_used_at" in source, \
            "应检查 password_token_used_at 标记一次性使用"
        assert "TOKEN_ALREADY_USED" in source, \
            "已使用的 Token 应返回 TOKEN_ALREADY_USED 错误"

    def test_token_expiry_check(self):
        """验证 Token 过期校验"""
        source = read_source("app/api/routes/registration.py")
        assert "password_token_expires_at" in source, \
            "应检查 password_token_expires_at 过期时间"
        assert "TOKEN_EXPIRED" in source, "过期应返回 TOKEN_EXPIRED 错误"

    def test_email_injection_prevention_in_apply(self):
        """验证申请接口的邮箱级 Redis 锁（防重复提交）"""
        source = read_source("app/api/routes/registration.py")
        assert "register:apply:lock:" in source, \
            "应使用 Redis 锁防止同一邮箱重复提交"
        assert "nx=True" in source, "应使用 NX 原子性获取锁"

    def test_integrity_error_handling(self):
        """验证 set-password 捕获 IntegrityError（并发保护）"""
        source = read_source("app/api/routes/registration.py")
        assert "IntegrityError" in source, "应捕获 IntegrityError 处理竞态"
        assert "USERNAME_OR_EMAIL_EXISTS" in source


# ============================================
# 4. behavior 测试（monkeypatch 模拟）
# ============================================

class TestEmailServiceBehavior:
    """邮件服务行为测试（monkeypatch 模拟依赖）"""

    def test_render_email_register_notify_admin(self):
        """验证 register_notify_admin 模板渲染含转义内容"""
        # 通过 sys.path 动态导入（避免全局 import 失败）
        import sys
        sys.path.insert(0, str(BACKEND_DIR))

        # monkeypatch settings 避免 import 失败
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.EMAIL_ENABLED = False
            mock_settings.SMTP_HOST = "smtp.resend.com"
            mock_settings.SMTP_PORT = 465
            mock_settings.SMTP_USER = "resend"
            mock_settings.SMTP_PASSWORD = "test"
            mock_settings.SMTP_USE_TLS = True
            mock_settings.SMTP_START_TLS = False
            mock_settings.SMTP_TIMEOUT = 30
            mock_settings.EMAIL_FROM = "test@test.com"

            from app.services.email_service import render_email

            html = render_email(
                "register_notify_admin",
                applicant_username="<script>alert('xss')</script>",
                applicant_email="user@test.com",
                app_id=42,
                submitted_at="2026-07-10 10:00:00",
            )
            # XSS 内容应被转义
            assert "&lt;script&gt;" in html, "用户名应被 HTML 转义"
            assert "<script>alert" not in html, "不应包含原始 script 标签"
            assert "#42" in html, "应显示申请编号"

    def test_render_email_password_setup(self):
        """验证 password_setup 模板渲染含设置链接"""
        import sys
        sys.path.insert(0, str(BACKEND_DIR))

        with patch("app.core.config.settings") as mock_settings:
            mock_settings.EMAIL_ENABLED = False
            mock_settings.SMTP_HOST = "smtp.resend.com"
            mock_settings.SMTP_PORT = 465
            mock_settings.SMTP_USER = "resend"
            mock_settings.SMTP_PASSWORD = "test"
            mock_settings.SMTP_USE_TLS = True
            mock_settings.SMTP_START_TLS = False
            mock_settings.SMTP_TIMEOUT = 30
            mock_settings.EMAIL_FROM = "test@test.com"

            from app.services.email_service import render_email

            html = render_email(
                "password_setup",
                username="alice",
                setup_url="https://example.com/set-password?token=abc123",
                expires_hours=24,
            )
            assert "设置密码" in html, "应包含设置密码文案"
            assert "https://example.com/set-password?token=abc123" in html
            assert "24 小时" in html, "应显示有效期"

    def test_get_email_subject_fixed(self):
        """验证 get_email_subject 返回固定主题"""
        import sys
        sys.path.insert(0, str(BACKEND_DIR))

        with patch("app.core.config.settings") as mock_settings:
            mock_settings.EMAIL_ENABLED = False
            mock_settings.SMTP_HOST = "smtp.resend.com"
            mock_settings.SMTP_PORT = 465
            mock_settings.SMTP_USER = "resend"
            mock_settings.SMTP_PASSWORD = "test"
            mock_settings.SMTP_USE_TLS = True
            mock_settings.SMTP_START_TLS = False
            mock_settings.SMTP_TIMEOUT = 30
            mock_settings.EMAIL_FROM = "test@test.com"

            from app.services.email_service import get_email_subject

            assert get_email_subject("register_notify_admin") == "[GeiIt] 新的注册申请待审核"
            assert get_email_subject("password_setup") == "[GeiIt] 设置您的登录密码"
            assert get_email_subject("register_rejected") == "[GeiIt] 注册申请未通过"
            assert get_email_subject("account_created") == "[GeiIt] 账号创建成功"

    def test_get_email_subject_unknown_type_raises(self):
        """验证未知邮件类型抛出 ValueError"""
        import sys
        sys.path.insert(0, str(BACKEND_DIR))

        with patch("app.core.config.settings") as mock_settings:
            mock_settings.EMAIL_ENABLED = False
            mock_settings.SMTP_HOST = "smtp.resend.com"
            mock_settings.SMTP_PORT = 465
            mock_settings.SMTP_USER = "resend"
            mock_settings.SMTP_PASSWORD = "test"
            mock_settings.SMTP_USE_TLS = True
            mock_settings.SMTP_START_TLS = False
            mock_settings.SMTP_TIMEOUT = 30
            mock_settings.EMAIL_FROM = "test@test.com"

            from app.services.email_service import get_email_subject

            with pytest.raises(ValueError):
                get_email_subject("unknown_type")

    def test_send_email_async_disabled_no_smtp(self):
        """验证 EMAIL_ENABLED=False 时不连接任何邮件服务"""
        import sys
        sys.path.insert(0, str(BACKEND_DIR))

        with patch("app.core.config.settings") as mock_settings:
            mock_settings.EMAIL_ENABLED = False  # 关键：邮件禁用
            mock_settings.EMAIL_FROM = "test@test.com"
            mock_settings.EMAIL_PROVIDER = "http"

            from app.services.email_service import send_email_sync

            # 即使未配置 API Key 也不应报错（EMAIL_ENABLED=False 时直接返回）
            send_email_sync("to@test.com", "主题", "<h1>内容</h1>")
            # 到这里说明未抛异常，降级成功


# ============================================
# 5. config.py 邮件配置验证
# ============================================

class TestEmailConfigStructure:
    """邮件配置项验证"""

    def test_email_config_fields_exist(self):
        """验证邮件配置项默认值存在（含双通道新增字段）"""
        source = read_source("app/core/config.py")
        required_fields = [
            "EMAIL_ENABLED",
            "EMAIL_PROVIDER",      # 双通道：http / smtp
            "RESEND_API_KEY",      # 双通道：HTTP API Key
            "SMTP_HOST",
            "SMTP_PORT",
            "SMTP_USER",
            "SMTP_PASSWORD",
            "SMTP_USE_TLS",
            "SMTP_START_TLS",
            "SMTP_TIMEOUT",
            "EMAIL_FROM",
            "ADMIN_NOTIFY_EMAIL",
            "FRONTEND_BASE_URL",
            "PASSWORD_TOKEN_EXPIRE_HOURS",
        ]
        for field in required_fields:
            assert f"{field}:" in source or f"{field} :" in source, \
                f"配置项 {field} 应在 config.py 中定义"

    def test_email_provider_default_is_http(self):
        """验证 EMAIL_PROVIDER 默认值为 http（主通道）"""
        source = read_source("app/core/config.py")
        assert 'EMAIL_PROVIDER: str = "http"' in source, \
            "EMAIL_PROVIDER 默认应为 http（推荐生产通道）"

    def test_production_validation_supports_dual_channel(self):
        """验证生产环境校验支持双通道（http/smtp 分别校验 Key，支持回退）"""
        source = read_source("app/core/config.py")
        assert 'EMAIL_PROVIDER == "http"' in source, \
            "应校验 http 通道的 RESEND_API_KEY"
        assert 'EMAIL_PROVIDER == "smtp"' in source, \
            "应校验 smtp 通道的 SMTP_PASSWORD"
        assert "必须为 http 或 smtp" in source, \
            "应校验 EMAIL_PROVIDER 取值范围"
        # 兼容回退：http 通道允许 SMTP_PASSWORD 作为回退
        assert "SMTP_PASSWORD 作为回退" in source, \
            "应支持 SMTP_PASSWORD 作为 http 通道的回退"

    def test_resend_default_values(self):
        """验证 Resend SMTP 默认值正确"""
        source = read_source("app/core/config.py")
        assert 'smtp.resend.com' in source, "SMTP_HOST 默认应为 smtp.resend.com"
        assert "SMTP_PORT: int = 465" in source, "SMTP_PORT 默认应为 465（SSL）"
        assert 'SMTP_USER: str = "resend"' in source, "SMTP_USER 默认应为 resend"
        assert "SMTP_USE_TLS: bool = True" in source, "SMTP_USE_TLS 默认应为 True"

    def test_production_validation_includes_email(self):
        """验证 validate_required_for_production 包含邮件配置校验"""
        source = read_source("app/core/config.py")
        assert "EMAIL_ENABLED" in source, "应校验 EMAIL_ENABLED"
        assert "SMTP_PASSWORD" in source, "应校验 SMTP_PASSWORD"
        assert "ADMIN_NOTIFY_EMAIL" in source, "应校验 ADMIN_NOTIFY_EMAIL"


# ============================================
# 6. 安全审查项验证
# ============================================

class TestSecurityAudit:
    """安全审查项验证"""

    def test_no_hardcoded_api_key(self):
        """验证无硬编码 API Key"""
        source_service = read_source("app/services/email_service.py")
        source_tasks = read_source("app/tasks/email_tasks.py")
        source_config = read_source("app/core/config.py")

        # 不应出现真实的 re_ 开头的 API Key
        for source in [source_service, source_tasks, source_config]:
            # 排除注释和示例值
            lines = [line for line in source.split("\n")
                     if not line.strip().startswith("#") and "re_your" not in line]
            content = "\n".join(lines)
            # 不应出现 re_ 后跟 10+ 字符的疑似真实 Key
            import re
            real_keys = re.findall(r're_[a-zA-Z0-9]{10,}', content)
            assert len(real_keys) == 0, f"不应硬编码真实 API Key，发现: {real_keys}"

    def test_subject_no_user_input(self):
        """验证邮件主题不含用户输入（CRLF 注入防护）"""
        source = read_source("app/services/email_service.py")
        # _SUBJECT_MAP 中的值应为字面量字符串，不含变量插值
        assert '"[GeiIt] 新的注册申请待审核"' in source
        assert '"[GeiIt] 设置您的登录密码"' in source
        # 不应使用 f-string 或 .format 构建主题
        assert 'subject = f"' not in source.split("_SUBJECT_MAP")[0] or \
               "get_email_subject" not in source.split("_SUBJECT_MAP")[0]

    def test_error_message_desensitized(self):
        """验证错误信息脱敏（不含原始异常堆栈）"""
        source = read_source("app/tasks/email_tasks.py")
        # error_message 应使用 type(e).__name__，不使用 str(e)
        assert "type(e).__name__" in source
        # 不应出现 str(e) 或 repr(e) 直接存入 error_message
        assert "log.error_message = str(e)" not in source
        assert "log.error_message = repr(e)" not in source

    def test_password_hashed_not_plaintext(self):
        """验证密码使用 bcrypt 哈希存储，非明文"""
        source = read_source("app/api/routes/registration.py")
        assert "hash_password(body.password)" in source, \
            "应使用 hash_password 加密密码"
        # 不应直接存储明文密码
        assert "password=body.password" not in source.split("hashed_password")[0] \
               if "hashed_password" in source else True

    def test_token_not_logged_plaintext(self):
        """验证明文 Token 不被记录到日志"""
        source = read_source("app/api/routes/registration.py")
        # 日志中不应出现 plain_token 变量
        log_lines = [line for line in source.split("\n") if "logger" in line and "info" in line]
        for line in log_lines:
            assert "plain_token" not in line, \
                "日志中不应记录明文 Token"

    def test_celery_app_email_queue_configured(self):
        """验证 Celery 配置了 email 队列和路由"""
        source = read_source("app/core/celery_app.py")
        assert '"app.tasks.email_tasks"' in source, \
            "include 应包含 email_tasks 模块"
        assert 'Queue("email"' in source, "应配置 email 队列"
        assert '"app.tasks.email_tasks.send_email"' in source, \
            "应配置 email task 路由"

    def test_router_registered_in_main(self):
        """验证 registration_router 已注册到 main.py"""
        source = read_source("app/main.py")
        assert "from app.api.routes.registration import router as registration_router" in source
        assert "app.include_router(registration_router" in source


# ============================================
# 7. migration 验证
# ============================================

class TestMigrationStructure:
    """数据库迁移结构验证"""

    def test_migration_file_exists(self):
        """验证迁移文件存在"""
        migration_path = BACKEND_DIR / "alembic/versions/20260710_0003_add_registration_and_email_logs.py"
        assert migration_path.exists(), "迁移文件应存在"

    def test_migration_creates_two_tables(self):
        """验证迁移创建 registration_applications 和 email_logs 两张表"""
        source = read_source("alembic/versions/20260710_0003_add_registration_and_email_logs.py")
        assert "create_table" in source, "应使用 create_table"
        assert "registration_applications" in source, "应创建 registration_applications 表"
        assert "email_logs" in source, "应创建 email_logs 表"

    def test_migration_down_revision(self):
        """验证迁移的 down_revision 指向上一个版本"""
        source = read_source("alembic/versions/20260710_0003_add_registration_and_email_logs.py")
        # 实际格式为 down_revision: Union[str, None] = "20260708_0002"（带类型注解）
        # 使用 "20260708_0002" 子串匹配，兼容带/不带类型注解两种写法
        assert '"20260708_0002"' in source, \
            "down_revision 应指向 20260708_0002"
