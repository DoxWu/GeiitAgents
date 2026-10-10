"""
账号删除功能验证测试（P0-2：GDPR/PIPL 合规）

作用：
    验证 auth.py 中 delete_account 端点的安全结构和合规逻辑，
    确保账号删除功能满足 GDPR"被遗忘权"和 PIPL 个人信息删除权要求。

测试策略：
    1. 静态分析测试：直接读取源码文件内容，验证安全结构存在（不导入模块，避免运行时依赖）
    2. 覆盖端点结构、密码确认、持久文件清理、关联数据清理、Token 吊销、Schema 验证

运行方式：
    cd backend
    python -m pytest tests/test_account_deletion.py -v
"""

from pathlib import Path

# ============================================
# 辅助函数：读取源码文件内容（不导入模块，避免依赖问题）
# ============================================

BACKEND_DIR = Path(__file__).parent.parent


def read_source(relative_path: str) -> str:
    """
    读取源码文件内容

    作用：
        直接读取文件内容，不通过 import 导入模块。
        避免因 psycopg/celery/langchain 等运行时依赖缺失导致测试失败。

    参数：
        relative_path: str - 相对于 backend 目录的路径

    返回：
        str - 文件内容
    """
    file_path = BACKEND_DIR / relative_path
    return file_path.read_text(encoding="utf-8")


# ============================================
# 1. 端点结构验证
# ============================================

class TestAccountDeletionEndpoint:
    """账号删除端点结构验证"""

    def test_delete_route_exists(self):
        """验证 DELETE /account 路由和 delete_account 函数存在"""
        source = read_source("app/api/routes/auth.py")
        # 装饰器跨多行：@router.delete( 独占一行，"/account" 在下一行
        assert "@router.delete(" in source, \
            "应定义 @router.delete 装饰器"
        assert '"/account"' in source, \
            "应定义 /account 路由路径"
        assert "async def delete_account" in source, \
            "应定义 async def delete_account 函数"

    def test_rate_limit_applied(self):
        """验证删除接口配置了限流（防止暴力尝试密码）"""
        source = read_source("app/api/routes/auth.py")
        assert 'rate_limit("account_delete", per_hour=3)' in source, \
            "应配置每小时最多 3 次删除尝试的限流"

    def test_requires_authentication(self):
        """验证删除接口需要登录认证（get_current_active_user 依赖）"""
        source = read_source("app/api/routes/auth.py")
        assert "get_current_active_user" in source, \
            "应依赖 get_current_active_user 确保用户已登录"


# ============================================
# 2. 密码确认验证（防误操作 + 防 CSRF）
# ============================================

class TestPasswordConfirmation:
    """密码确认逻辑验证"""

    def test_verifies_password_before_deletion(self):
        """验证删除前调用 verify_password 确认密码"""
        source = read_source("app/api/routes/auth.py")
        assert "verify_password(body.password, current_user.hashed_password)" in source, \
            "应调用 verify_password 验证用户密码，防止误操作和 CSRF"

    def test_wrong_password_returns_401(self):
        """验证密码错误时返回 401 + INVALID_PASSWORD 错误码"""
        source = read_source("app/api/routes/auth.py")
        assert "HTTP_401_UNAUTHORIZED" in source, \
            "密码错误应返回 401 状态码"
        assert "INVALID_PASSWORD" in source, \
            "密码错误应返回 INVALID_PASSWORD 错误码"


# ============================================
# 3. 持久文件清理验证
# ============================================

class TestDurableFileCleanup:
    """账号删除提交后由持久任务清理文件"""

    def test_queries_user_documents(self):
        """验证账号删除收集用户文档以创建清理任务"""
        source = read_source("app/api/routes/auth.py")
        assert "db.query(Document).filter(Document.user_id == current_user.id)" in source, \
            "应查询用户所有文档记录"

    def test_enqueues_document_cleanup(self):
        """验证账号删除事务内创建持久文件清理任务"""
        source = read_source("app/api/routes/auth.py")
        cleanup_source = read_source("app/services/file_cleanup.py")
        assert "enqueue_document_cleanup(db, user_documents)" in source, \
            "账号删除应在删除用户记录前持久化文件清理任务"
        assert "FileCleanupJob" in cleanup_source and "paths" in cleanup_source, \
            "清理任务应保存待删除路径，供提交后重试"

    def test_cleanup_failure_is_retryable(self):
        """验证文件系统失败由清理服务持久重试"""
        source = read_source("app/services/file_cleanup.py")
        assert "status = 'retry'" in source, \
            "清理失败应保留 retry 状态"
        assert "attempts" in source and "available_at" in source, \
            "清理失败应记录次数和下次尝试时间"


# ============================================
# 4. 级联删除验证
# ============================================

class TestCascadeDeletion:
    """数据库级联删除验证"""

    def test_deletes_user_record(self):
        """验证删除用户数据库记录并提交"""
        source = read_source("app/api/routes/auth.py")
        assert "db.delete(current_user)" in source, \
            "应调用 db.delete 删除用户记录（级联删除关联数据）"
        assert "db.commit()" in source, \
            "应提交事务使删除生效"

    def test_db_failure_returns_500(self):
        """验证数据库删除失败时回滚并返回 500"""
        source = read_source("app/api/routes/auth.py")
        assert "except Exception" in source, \
            "应捕获数据库操作异常"
        assert "db.rollback()" in source, \
            "数据库删除失败应回滚事务"
        assert "HTTPException(500" in source, \
            "数据库删除失败应返回 500 状态码"
        assert "DELETE_FAILED" in source, \
            "数据库删除失败应返回 DELETE_FAILED 错误码"

    def test_qaevent_payload_is_erased(self):
        """验证账号删除清除 QA 正文，不以 SET NULL 保留个人内容"""
        source = read_source("app/api/routes/auth.py")
        privacy_source = read_source("app/services/account_privacy.py")
        assert "erase_account_payloads" in source, \
            "账号删除应调用隐私数据清理服务"
        assert "db.query(QAEvent)" in privacy_source and ".delete(" in privacy_source, \
            "账号关联 QA 正文应在删除事务中清除"


# ============================================
# 5. Token 吊销验证
# ============================================

class TestTokenRevocation:
    """Token 吊销验证（删除后立即使 Token 失效）"""

    def test_extracts_access_token_from_header(self):
        """验证从 Authorization Header 提取 Access Token"""
        source = read_source("app/api/routes/auth.py")
        assert "Authorization" in source, \
            "应从 Authorization Header 提取 Token"
        assert "bearer " in source, \
            "应处理 Bearer 前缀提取 Token"

    def test_blacklists_access_token(self):
        """验证删除账号后将 Access Token 加入黑名单"""
        source = read_source("app/api/routes/auth.py")
        assert "blacklist_token(access_token)" in source, \
            "应调用 blacklist_token 吊销 Access Token"

    def test_blacklists_refresh_token_optional(self):
        """验证可选吊销 Refresh Token（提供时一并加入黑名单）"""
        source = read_source("app/api/routes/auth.py")
        assert "body.refresh_token" in source, \
            "应检查请求体中是否提供 Refresh Token"
        # Refresh Token 黑名单应设置 TTL（与 Refresh Token 有效期一致）
        assert "ttl=settings.REFRESH_TOKEN_EXPIRE_DAYS" in source, \
            "Refresh Token 黑名单应设置 TTL 为其有效期"


# ============================================
# 6. AccountDeleteRequest Schema 验证
# ============================================

class TestAccountDeleteRequestSchema:
    """账号删除请求 Schema 验证（静态分析 Schema 定义）"""

    def test_schema_class_exists(self):
        """验证 AccountDeleteRequest Schema 类存在"""
        source = read_source("app/schemas/user.py")
        assert "class AccountDeleteRequest(BaseModel)" in source, \
            "应定义 AccountDeleteRequest Schema 类"

    def test_password_field_required(self):
        """验证 password 字段为必填（无默认值，用 ... 标记）"""
        source = read_source("app/schemas/user.py")
        assert "password: str = Field(" in source, \
            "password 应为 str 类型 Field"
        assert "min_length=1" in source, \
            "password 应有最小长度限制（至少 1 字符）"
        assert "max_length=100" in source, \
            "password 应有最大长度限制（100 字符）"

    def test_refresh_token_optional(self):
        """验证 refresh_token 字段可选（默认 None）"""
        source = read_source("app/schemas/user.py")
        assert "refresh_token: Optional[str]" in source, \
            "refresh_token 应为 Optional[str] 类型"
        assert "max_length=5000" in source, \
            "refresh_token 应有最大长度限制（5000 字符，JWT 格式）"
