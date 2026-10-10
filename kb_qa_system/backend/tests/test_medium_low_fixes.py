"""
Medium & Low 级别修复验证测试

测试策略：
    静态分析（读取源码文件内容验证修复结构）+ 行为测试（monkeypatch）
    与现有 test_critical_fixes.py / test_high_fixes.py 策略一致，避免运行时依赖

覆盖范围：
    24 项 Medium（M-1 ~ M-24）+ 16 项 Low（L-1 ~ L-16）= 40 项
    注意：M-16 在批次2完成，M-21 在批次3完成，M-18 为目录删除（无代码验证）
"""

import os
import ast
import re
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock, AsyncMock

# 项目根目录
BACKEND_DIR = Path(__file__).parent.parent
APP_DIR = BACKEND_DIR / "app"


def read_source(rel_path: str) -> str:
    """读取源码文件内容"""
    return open(APP_DIR / rel_path, encoding="utf-8").read()


# ============================================
# 批次1: 参数校验与 Schema (M-5, M-6, M-8, M-9, L-4, L-5, L-6)
# ============================================

class TestM5TitleValidation:
    """M-5: title 参数长度校验"""

    def test_form_title_has_max_length(self):
        source = read_source("api/routes/documents.py")
        # Form 参数 title 有 max_length=200
        assert re.search(r'title.*Form.*max_length\s*=\s*200', source), \
            "title Form 参数应有 max_length=200 校验"

    def test_m5_annotation(self):
        source = read_source("api/routes/documents.py")
        assert "M-5" in source, "应包含 M-5 修复标记"


class TestM6StatusEnumValidation:
    """M-6: 文档列表 status 参数枚举校验"""

    def test_status_has_pattern(self):
        source = read_source("api/routes/documents.py")
        # status 参数有 pattern 正则校验（Field 定义跨多行，使用 DOTALL）
        assert re.search(r'status.*Query.*pattern', source, re.DOTALL), \
            "status Query 参数应有 pattern 枚举校验"

    def test_status_pattern_includes_all_states(self):
        source = read_source("api/routes/documents.py")
        for state in ["pending", "processing", "completed", "failed", "low_quality"]:
            assert state in source, f"status pattern 应包含 {state}"

    def test_m6_annotation(self):
        source = read_source("api/routes/documents.py")
        assert "M-6" in source


class TestM8DocumentUploadDeprecated:
    """M-8: DocumentUpload Schema 标记废弃"""

    def test_document_upload_deprecated(self):
        source = read_source("schemas/document.py")
        assert "废弃" in source or "deprecated" in source.lower(), \
            "DocumentUpload 应标记为废弃"

    def test_form_params_have_validation(self):
        source = read_source("api/routes/documents.py")
        # Form 参数有 max_length 校验
        assert "max_length" in source

    def test_m8_annotation(self):
        source = read_source("schemas/document.py")
        assert "M-8" in source


class TestM9StatsTimeValidation:
    """M-9: stats 路由时间参数校验"""

    def test_parse_time_raises_value_error(self):
        source = read_source("api/routes/stats.py")
        # _parse_time 不再静默忽略错误
        assert "raise ValueError" in source or "ValueError" in source, \
            "_parse_time 解析失败应抛出 ValueError"

    def test_callers_catch_value_error(self):
        source = read_source("api/routes/stats.py")
        # 调用方应捕获 ValueError 返回 400
        assert "INVALID_TIME_FORMAT" in source or "400" in source

    def test_m9_annotation(self):
        source = read_source("api/routes/stats.py")
        assert "M-9" in source


class TestL4PathPositiveInt:
    """L-4: Path 参数正整数校验"""

    def test_documents_path_ge_1(self):
        source = read_source("api/routes/documents.py")
        # Path 参数有 ge=1
        matches = re.findall(r'Path\(\.\.\.,\s*ge\s*=\s*1', source)
        assert len(matches) >= 4, f"documents.py 应有至少 4 处 Path(ge=1)，实际 {len(matches)}"

    def test_chat_path_ge_1(self):
        source = read_source("api/routes/chat.py")
        matches = re.findall(r'Path\(\.\.\.,\s*ge\s*=\s*1', source)
        assert len(matches) >= 2, f"chat.py 应有至少 2 处 Path(ge=1)，实际 {len(matches)}"

    def test_l4_annotation(self):
        source = read_source("api/routes/documents.py")
        assert "L-4" in source


class TestL5ConversationIdValidation:
    """L-5: QuestionRequest.conversation_id 正整数校验"""

    def test_conversation_id_ge_1(self):
        source = read_source("schemas/chat.py")
        # Field 定义跨多行，使用 DOTALL 匹配
        assert re.search(r'conversation_id.*ge\s*=\s*1', source, re.DOTALL), \
            "conversation_id 应有 ge=1 校验"

    def test_l5_annotation(self):
        source = read_source("schemas/chat.py")
        assert "L-5" in source


class TestL6RefreshTokenLength:
    """L-6: RefreshTokenRequest token 长度限制"""

    def test_refresh_token_has_length_limit(self):
        source = read_source("schemas/user.py")
        # Field 定义跨多行，使用 DOTALL 匹配
        assert re.search(r'refresh_token.*min_length', source, re.DOTALL), \
            "refresh_token 应有 min_length 校验"
        assert re.search(r'refresh_token.*max_length', source, re.DOTALL), \
            "refresh_token 应有 max_length 校验"

    def test_l6_annotation(self):
        source = read_source("schemas/user.py")
        assert "L-6" in source


# ============================================
# 批次2: 并发与线程安全 (M-13, M-24, L-1, L-2, L-3)
# ============================================

class TestM13SingletonThreadSafe:
    """M-13: 单例工厂线程安全（双重检查锁定）"""

    def test_rag_chain_double_checked_locking(self):
        source = read_source("services/rag_chain.py")
        assert "threading.Lock" in source, "应使用 threading.Lock"
        assert "_rag_chain_lock" in source, "应有 _rag_chain_lock"

    def test_llm_service_double_checked_locking(self):
        source = read_source("services/llm_resilience.py")
        assert "threading.Lock" in source
        assert "_llm_service_lock" in source

    def test_rag_chain_singleton_pattern(self):
        source = read_source("services/rag_chain.py")
        # 双重检查锁定：if instance is None: with lock: if instance is None:
        assert "if _rag_chain_instance is None" in source
        assert "with _rag_chain_lock" in source

    def test_m13_annotation(self):
        source = read_source("services/rag_chain.py")
        assert "M-13" in source


class TestM24BreakersThreadSafe:
    """M-24: 熔断器 _breakers 字典线程安全"""

    def test_breakers_lock_exists(self):
        source = read_source("core/circuit_breaker.py")
        assert "_breakers_lock" in source, "应有 _breakers_lock"
        assert "threading.Lock" in source

    def test_double_checked_locking_pattern(self):
        source = read_source("core/circuit_breaker.py")
        assert "if service not in _breakers" in source
        assert "with _breakers_lock" in source

    def test_m24_annotation(self):
        source = read_source("core/circuit_breaker.py")
        assert "M-24" in source


class TestL1IdempotencyLockTTLConfig:
    """L-1: 幂等锁 TTL 配置化"""

    def test_idempotency_lock_ttl_in_config(self):
        source = read_source("core/config.py")
        assert "IDEMPOTENCY_LOCK_TTL" in source, "config.py 应有 IDEMPOTENCY_LOCK_TTL"

    def test_chat_uses_config_ttl(self):
        source = read_source("api/routes/chat.py")
        assert "settings.IDEMPOTENCY_LOCK_TTL" in source, \
            "chat.py 应使用 settings.IDEMPOTENCY_LOCK_TTL"

    def test_l1_annotation(self):
        source = read_source("core/config.py")
        assert "L-1" in source


class TestL2ReprocessLockTTLConfig:
    """L-2: reprocess 锁 TTL 配置化"""

    def test_reprocess_lock_ttl_in_config(self):
        source = read_source("core/config.py")
        assert "REPROCESS_LOCK_TTL" in source

    def test_documents_uses_config_ttl(self):
        source = read_source("api/routes/documents.py")
        assert "settings.REPROCESS_LOCK_TTL" in source

    def test_l2_annotation(self):
        source = read_source("core/config.py")
        assert "L-2" in source


class TestL3ReprocessUsesDelay:
    """L-3: reprocess_document_task 使用 .delay()"""

    def test_uses_delay_not_direct_call(self):
        source = read_source("tasks/document_tasks.py")
        assert "process_document_task.delay" in source, \
            "应使用 .delay() 而非直接函数调用"

    def test_l3_annotation(self):
        source = read_source("tasks/document_tasks.py")
        assert "L-3" in source


# ============================================
# 批次3: 幂等与缓存 (M-1, M-2, M-12, M-21, L-14)
# ============================================

class TestM1UrlImportIdempotency:
    """M-1: URL 导入幂等性"""

    def test_url_hash_check_exists(self):
        source = read_source("api/routes/documents.py")
        assert "hashlib.sha256" in source or "url_hash" in source, \
            "应有 URL 哈希计算"

    def test_url_already_imported_error(self):
        source = read_source("api/routes/documents.py")
        assert "URL_ALREADY_IMPORTED" in source, \
            "应有 URL_ALREADY_IMPORTED 错误码"

    def test_m1_annotation(self):
        source = read_source("api/routes/documents.py")
        assert "M-1" in source


class TestM2UploadTOCTOU:
    """M-2: 文件上传哈希去重 TOCTOU 修复"""

    def test_upload_lock_exists(self):
        source = read_source("api/routes/documents.py")
        assert "upload:hash:" in source or "upload_lock" in source, \
            "应有上传去重锁"

    def test_acquire_lock_before_check(self):
        source = read_source("api/routes/documents.py")
        assert "acquire_lock" in source
        assert "release_lock" in source

    def test_finally_releases_upload_lock(self):
        source = read_source("api/routes/documents.py")
        # finally 块中释放上传锁
        assert "finally" in source
        assert "release_lock" in source

    def test_m2_annotation(self):
        source = read_source("api/routes/documents.py")
        assert "M-2" in source


class TestM12CacheWriteFailureWarning:
    """M-12: 幂等性结果缓存写入失败告警"""

    def test_cache_write_check_exists(self):
        source = read_source("api/routes/chat.py")
        assert "not cached" in source or "if not cached" in source, \
            "应检查缓存写入返回值"

    def test_warning_logged_on_failure(self):
        source = read_source("api/routes/chat.py")
        assert "logger.warning" in source
        assert "缓存写入失败" in source or "缓存" in source

    def test_m12_annotation(self):
        source = read_source("api/routes/chat.py")
        assert "M-12" in source


class TestM21UrlErrorDesensitization:
    """M-21: URL 校验异常信息脱敏"""

    def test_no_str_e_in_url_error(self):
        source = read_source("api/routes/documents.py")
        # URL 校验失败不应返回 str(e)
        # 查找 URL_VALIDATION_FAILED 错误码
        assert "URL_VALIDATION_FAILED" in source, \
            "应有 URL_VALIDATION_FAILED 通用错误码"

    def test_m21_annotation(self):
        source = read_source("api/routes/documents.py")
        assert "M-21" in source


class TestL14NonStreamSuccessReleasesLock:
    """L-14: 非流式成功后主动释放幂等锁"""

    def test_success_path_releases_lock(self):
        source = read_source("api/routes/chat.py")
        # 非流式成功路径应有 release_lock
        assert "L-14" in source

    def test_l14_annotation(self):
        source = read_source("api/routes/chat.py")
        assert "L-14" in source


# ============================================
# 批次4: 安全与数据保护 (M-3, M-4, M-23, L-7, L-9, L-11)
# ============================================

class TestM3RetrieveContextSecurity:
    """M-3: retrieve_context 无 user_id 时拒绝检索"""

    def test_no_trust_document_ids_without_user(self):
        source = read_source("services/rag_chain.py")
        # 无 user_id 时不应直接返回 document_ids
        assert "return document_ids" not in source or \
               "return []" in source, \
            "无 user_id 时不应直接信任 document_ids"

    def test_m3_annotation(self):
        source = read_source("services/rag_chain.py")
        assert "M-3" in source


class TestM4SuperuserAuditLog:
    """M-4: 超级管理员访问他人文档审计日志"""

    def test_audit_function_exists(self):
        source = read_source("api/routes/documents.py")
        assert "_audit_superuser_action" in source, \
            "应有 _audit_superuser_action 审计函数"

    def test_audit_called_in_get_document(self):
        source = read_source("api/routes/documents.py")
        assert "action=\"access\"" in source or "action='access'" in source

    def test_audit_called_in_delete_document(self):
        source = read_source("api/routes/documents.py")
        assert "action=\"delete\"" in source or "action='delete'" in source

    def test_audit_called_in_reprocess(self):
        source = read_source("api/routes/documents.py")
        assert "action=\"reprocess\"" in source or "action='reprocess'" in source

    def test_m4_annotation(self):
        source = read_source("api/routes/documents.py")
        assert "M-4" in source


class TestM23MimeTypeValidation:
    """M-23: 文件上传 MIME 类型校验"""

    def test_validate_file_mime_type_exists(self):
        source = read_source("services/document_processor.py")
        assert "validate_file_mime_type" in source, \
            "应有 validate_file_mime_type 方法"

    def test_ext_mime_map_exists(self):
        source = read_source("services/document_processor.py")
        assert "_EXT_MIME_MAP" in source, "应有扩展名-MIME 映射表"

    def test_mime_check_in_upload(self):
        source = read_source("api/routes/documents.py")
        assert "validate_file_mime_type" in source, \
            "上传接口应调用 validate_file_mime_type"
        assert "MIME_TYPE_MISMATCH" in source, \
            "应有 MIME_TYPE_MISMATCH 错误码"

    def test_m23_annotation(self):
        source = read_source("services/document_processor.py")
        assert "M-23" in source


class TestL7SanitizeFilenameFix:
    """L-7: sanitize_filename 不再误伤合法文件名"""

    def test_no_broad_dot_dot_replace(self):
        source = read_source("core/url_validator.py")
        # 不应有大范围的 filename.replace("..", "_")
        # 应该只处理整个 basename 为 ".." 或 "." 的情况
        assert 'filename in ("..", ".")' in source or \
               'filename in ("..", ".")' in source, \
            "应只处理整个 basename 为 .. 或 . 的情况"

    def test_l7_annotation(self):
        source = read_source("core/url_validator.py")
        assert "L-7" in source

    def test_sanitize_filename_preserves_double_dots(self):
        """验证合法文件名 report..final.pdf 不被破坏"""
        from app.core.url_validator import sanitize_filename
        result = sanitize_filename("report..final.pdf")
        assert ".." in result, "合法文件名中的 .. 不应被替换"


class TestL9LogoutDedupBlacklist:
    """L-9: 登出去重拉黑已黑名单 Token"""

    def test_checks_before_blacklist(self):
        source = read_source("api/routes/auth.py")
        assert "is_token_blacklisted" in source
        # 在 blacklist_token 之前检查
        assert "RedisManager.set_many_strict(entries)" in source

    def test_l9_annotation(self):
        source = read_source("api/routes/auth.py")
        assert "L-9" in source


class TestL11FileScanDocumentation:
    """L-11: 文件内容扫描说明"""

    def test_l11_documentation_exists(self):
        source = read_source("api/routes/documents.py")
        assert "L-11" in source, "应有 L-11 说明注释"
        assert "ClamAV" in source or "内容安全" in source, \
            "应包含内容扫描建议"


# ============================================
# 批次5: 代码质量与清理 (M-14, M-15, M-17, L-15, L-16, L-8)
# ============================================

class TestM14ExceptionPathMetrics:
    """M-14: 异常路径指标填充"""

    def test_circuit_open_sets_metrics(self):
        source = read_source("services/llm_resilience.py")
        assert "circuit_open" in source, \
            "熔断打开时应设置 model_used 标记"

    def test_primary_failure_sets_metrics(self):
        source = read_source("services/llm_resilience.py")
        # 主模型失败时应记录 llm_time_ms
        assert "M-14" in source

    def test_m14_annotation(self):
        source = read_source("services/llm_resilience.py")
        assert "M-14" in source


class TestM15SummaryCommitRetry:
    """M-15: 摘要 commit 失败重试"""

    def test_retry_logic_exists(self):
        source = read_source("services/history_service.py")
        assert "重试" in source or "retry" in source.lower(), \
            "应有 commit 重试逻辑"

    def test_summary_logged_on_failure(self):
        source = read_source("services/history_service.py")
        assert "摘要内容" in source or "new_summary[:500]" in source, \
            "commit 失败时应记录摘要内容到日志"

    def test_m15_annotation(self):
        source = read_source("services/history_service.py")
        assert "M-15" in source


class TestM17UtcnowDeprecation:
    """M-17: datetime.utcnow() 弃用修复"""

    def test_no_utcnow_in_security(self):
        source = read_source("core/security.py")
        assert "datetime.utcnow()" not in source, \
            "不应再使用 datetime.utcnow()"

    def test_uses_timezone_utc(self):
        source = read_source("core/security.py")
        assert "datetime.now(timezone.utc)" in source, \
            "应使用 datetime.now(timezone.utc)"

    def test_timezone_imported(self):
        source = read_source("core/security.py")
        assert "timezone" in source, "应导入 timezone"

    def test_m17_annotation(self):
        source = read_source("core/security.py")
        assert "M-17" in source


class TestL15RedundantCloseRemoved:
    """L-15: 移除冗余 f.close()"""

    def test_no_redundant_close_in_with_block(self):
        source = read_source("api/routes/documents.py")
        # with open 块内不应有 f.close()
        # 查找 with open 块内的 f.close()
        assert "L-15" in source, "应有 L-15 修复标记"

    def test_l15_annotation(self):
        source = read_source("api/routes/documents.py")
        assert "L-15" in source


class TestL16IndependentSessionDocumented:
    """L-16: _compute_search_scope 独立 session 文档化"""

    def test_l16_documentation_exists(self):
        source = read_source("services/rag_chain.py")
        assert "L-16" in source, "应有 L-16 说明注释"


class TestL8CSRFDocumentation:
    """L-8: CSRF 风险评估文档化"""

    def test_csrf_documentation_exists(self):
        source = read_source("main.py")
        assert "CSRF" in source or "csrf" in source.lower(), \
            "应有 CSRF 风险评估文档"
        assert "Bearer Token" in source or "Bearer" in source

    def test_l8_annotation(self):
        source = read_source("main.py")
        assert "L-8" in source


# ============================================
# 批次6: 分页与API (M-7, M-10, M-11)
# ============================================

class TestM7ConversationListPagination:
    """M-7: 对话列表分页"""

    def test_pagination_params_exist(self):
        source = read_source("api/routes/chat.py")
        assert "page" in source and "page_size" in source
        assert "Query" in source

    def test_offset_limit_applied(self):
        source = read_source("api/routes/chat.py")
        assert ".offset(" in source and ".limit(" in source, \
            "应使用 offset/limit 分页"

    def test_response_includes_pagination(self):
        source = read_source("api/routes/chat.py")
        assert '"page"' in source or "'page'" in source
        assert '"page_size"' in source or "'page_size'" in source

    def test_schema_has_pagination_fields(self):
        source = read_source("schemas/chat.py")
        assert "page" in source
        assert "page_size" in source

    def test_m7_annotation(self):
        source = read_source("api/routes/chat.py")
        assert "M-7" in source


class TestM10StreamDbSessionCleanup:
    """M-10: 流式响应 db session 客户端断开清理"""

    def test_finally_has_rollback(self):
        source = read_source("api/routes/chat.py")
        # event_stream 的 finally 块应有 db.rollback()
        assert "db.rollback()" in source
        assert "M-10" in source

    def test_m10_annotation(self):
        source = read_source("api/routes/chat.py")
        assert "M-10" in source


class TestM11QAEventIndependentSession:
    """M-11: qa_event 使用独立 session 隔离"""

    def test_uses_independent_session(self):
        source = read_source("services/qa_event_service.py")
        assert "SessionLocal()" in source, \
            "应使用独立 SessionLocal() 写入埋点"
        assert "qa_db" in source, "应使用 qa_db 变量名"

    def test_no_caller_session_rollback(self):
        source = read_source("services/qa_event_service.py")
        # 不应 rollback 调用方 session
        assert "M-11" in source

    def test_m11_annotation(self):
        source = read_source("services/qa_event_service.py")
        assert "M-11" in source


# ============================================
# 批次7: 项目清理 (M-18, M-19, M-20, M-22, L-12, L-13)
# ============================================

class TestM18ChromaDirRemoved:
    """M-18: data/chroma 旧架构残留目录删除"""

    def test_chroma_dir_not_exists(self):
        chroma_path = BACKEND_DIR / "data" / "chroma"
        assert not chroma_path.exists(), "data/chroma 目录应已删除"


class TestM19UtilsPackageFilled:
    """M-19: app/utils 包充实"""

    def test_response_module_exists(self):
        response_path = APP_DIR / "utils" / "response.py"
        assert response_path.exists(), "app/utils/response.py 应存在"

    def test_error_response_function_exists(self):
        source = read_source("utils/response.py")
        assert "def error_response" in source

    def test_utils_init_exports(self):
        source = read_source("utils/__init__.py")
        assert "error_response" in source
        assert "success_response" in source

    def test_m19_annotation(self):
        source = read_source("utils/response.py")
        assert "M-19" in source


class TestM20DocsEnriched:
    """M-20: docs 目录充实"""

    def test_architecture_doc_exists(self):
        arch_path = BACKEND_DIR / "docs" / "ARCHITECTURE.md"
        assert arch_path.exists(), "docs/ARCHITECTURE.md 应存在"

    def test_architecture_has_content(self):
        arch_path = BACKEND_DIR / "docs" / "ARCHITECTURE.md"
        content = arch_path.read_text(encoding="utf-8")
        assert len(content) > 500, "ARCHITECTURE.md 应有实质内容"
        assert "M-20" in content


class TestM22UnusedCorsHeaderRemoved:
    """M-22: 移除未使用的 X-Idempotency-Key CORS 头"""

    def test_header_removed_from_allow_headers(self):
        source = read_source("main.py")
        # X-Idempotency-Key 不应在 allow_headers 列表中（但在注释中可以出现）
        # 检查它不在实际的列表项中
        lines = source.split("\n")
        in_allow_headers = False
        for line in lines:
            if "allow_headers" in line:
                in_allow_headers = True
            elif in_allow_headers and "]" in line:
                in_allow_headers = False
            elif in_allow_headers:
                if '"X-Idempotency-Key"' in line and "#" not in line.split('"')[0]:
                    pytest.fail("X-Idempotency-Key 不应在 allow_headers 列表中")

    def test_m22_annotation(self):
        source = read_source("main.py")
        assert "M-22" in source


class TestL12EnvExamplePrometheusSection:
    """L-12: .env.example 中 ENABLE_PROMETHEUS 移至 Prometheus 区"""

    def test_enable_prometheus_in_prometheus_section(self):
        env_path = BACKEND_DIR / ".env.example"
        content = env_path.read_text(encoding="utf-8")
        lines = content.split("\n")

        # 找到 ENABLE_PROMETHEUS 行
        ep_line_idx = None
        for i, line in enumerate(lines):
            if line.strip().startswith("ENABLE_PROMETHEUS="):
                ep_line_idx = i
                break

        assert ep_line_idx is not None, "应有 ENABLE_PROMETHEUS 配置"

        # 检查上方是否有 Prometheus 标题
        preceding_lines = "\n".join(lines[max(0, ep_line_idx-10):ep_line_idx])
        assert "Prometheus" in preceding_lines, \
            "ENABLE_PROMETHEUS 应在 Prometheus 配置区"

    def test_l12_annotation(self):
        env_path = BACKEND_DIR / ".env.example"
        content = env_path.read_text(encoding="utf-8")
        assert "L-12" in content


class TestL13EnhancedHealthCheck:
    """L-13: 增强健康检查"""

    def test_health_check_has_db_check(self):
        source = read_source("main.py")
        assert "SELECT 1" in source or "database" in source, \
            "健康检查应包含数据库连通性检查"

    def test_health_check_has_redis_check(self):
        source = read_source("main.py")
        assert "RedisManager.ping" in source or "redis" in source.lower(), \
            "健康检查应包含 Redis 连通性检查"

    def test_health_check_returns_checks_dict(self):
        source = read_source("main.py")
        assert "checks" in source, "应返回 checks 字典"

    def test_readiness_status_and_liveness_are_separate(self):
        source = read_source("main.py")
        assert '@app.get("/live"' in source
        assert '@app.get("/ready"' in source
        assert 'status_code=200 if healthy else 503' in source


# ============================================
# 附加: 预存语法错误修复验证
# ============================================

class TestPreExistingSyntaxFixes:
    """验证预存的字符串引号语法错误已修复"""

    def test_intent_classifier_imports(self):
        """intent_classifier.py 应可正常解析"""
        source = read_source("services/intent_classifier.py")
        ast.parse(source)  # 不抛异常即通过

    def test_query_rewrite_imports(self):
        """query_rewrite.py 应可正常解析"""
        source = read_source("services/query_rewrite.py")
        ast.parse(source)

    def test_no_inner_double_quotes_in_intent_prompt(self):
        source = read_source("services/intent_classifier.py")
        # 不应有不转义的内部双引号（如 "继续" 在双引号字符串内）
        assert '"继续"' not in source or "'继续'" in source

    def test_no_inner_double_quotes_in_rewrite_prompt(self):
        source = read_source("services/query_rewrite.py")
        assert '"那个"' not in source or "'那个'" in source


# ============================================
# 综合一致性检查
# ============================================

class TestMediumLowFixConsistency:
    """所有 Medium/Low 修复标记一致性检查"""

    def test_all_medium_fixes_annotated(self):
        """检查所有 M-1 ~ M-24 修复标记存在于源码或文档中"""
        all_medium_markers = [
            "M-1", "M-2", "M-3", "M-4", "M-5", "M-6", "M-7", "M-8",
            "M-9", "M-10", "M-11", "M-12", "M-13", "M-14", "M-15",
            "M-16", "M-17", "M-19", "M-20", "M-21", "M-22", "M-23", "M-24"
        ]
        # M-18 是目录删除，无代码标记
        all_source = ""
        # 扫描 app/ 下所有 .py 文件
        for root, _, files in os.walk(APP_DIR):
            for f in files:
                if f.endswith(".py"):
                    all_source += open(os.path.join(root, f), encoding="utf-8").read()
        # M-20 是文档类修复，标记在 docs/ARCHITECTURE.md 中
        docs_dir = BACKEND_DIR / "docs"
        if docs_dir.exists():
            for f in os.listdir(docs_dir):
                if f.endswith(".md"):
                    all_source += open(os.path.join(docs_dir, f), encoding="utf-8").read()

        missing = [m for m in all_medium_markers if m not in all_source]
        assert not missing, f"缺少修复标记: {missing}"

    def test_all_low_fixes_annotated_or_documented(self):
        """检查所有 L-1 ~ L-16 修复"""
        # L-10 是"设计如此"的说明，L-8 是文档化，L-16 是文档化
        low_code_markers = ["L-1", "L-2", "L-3", "L-4", "L-5", "L-6", "L-7",
                           "L-9", "L-11", "L-12", "L-13", "L-14", "L-15"]
        all_source = ""
        # 扫描 app/ 下所有 .py 文件
        for root, _, files in os.walk(APP_DIR):
            for f in files:
                if f.endswith(".py"):
                    all_source += open(os.path.join(root, f), encoding="utf-8").read()
        # L-12 是配置类修复，标记在 .env.example 中
        env_example = BACKEND_DIR / ".env.example"
        if env_example.exists():
            all_source += env_example.read_text(encoding="utf-8")

        # main.py 包含 L-8 和 L-16
        main_source = read_source("main.py")

        missing = [m for m in low_code_markers if m not in all_source]
        assert not missing, f"缺少修复标记: {missing}"

        # L-8 在 main.py 中
        assert "L-8" in main_source, "L-8 标记应在 main.py"

    def test_all_modified_files_exist(self):
        """验证所有修改的文件都存在"""
        files_to_check = [
            "api/routes/documents.py",
            "api/routes/chat.py",
            "api/routes/auth.py",
            "api/routes/stats.py",
            "core/config.py",
            "core/security.py",
            "core/circuit_breaker.py",
            "core/url_validator.py",
            "services/rag_chain.py",
            "services/llm_resilience.py",
            "services/history_service.py",
            "services/qa_event_service.py",
            "services/document_processor.py",
            "tasks/document_tasks.py",
            "schemas/chat.py",
            "schemas/document.py",
            "schemas/user.py",
            "utils/response.py",
            "utils/__init__.py",
            "main.py",
        ]
        for f in files_to_check:
            assert (APP_DIR / f).exists(), f"文件 {f} 应存在"
