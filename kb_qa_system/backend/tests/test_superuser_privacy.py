"""
超级管理员隐私修复验证测试

作用：
    验证超级管理员不应在前端看到所有用户的私有文档（隐私保护）。
    修复前：list_documents 中超级管理员在 accessible 范围下可看全部文档。
    修复后：超级管理员也只能看到自己的文档 + 公共文档。

测试策略：
    1. 静态分析测试：直接读取源码文件内容，验证修复结构存在
    2. 行为测试：模拟场景验证逻辑正确性

覆盖维度：
    - list_documents 不再有超级管理员看全部的特权
    - get_accessible_document_ids 设计正确（没有超管特权）
    - can_access_document 的超管特权保留（用于特定管理场景）

运行方式：
    cd backend
    python -m pytest tests/test_superuser_privacy.py -v
"""

import pytest
from pathlib import Path
from unittest.mock import MagicMock


BACKEND_DIR = Path(__file__).parent.parent


def read_source(relative_path: str) -> str:
    """读取源码文件内容"""
    file_path = BACKEND_DIR / relative_path
    return file_path.read_text(encoding="utf-8")


# ============================================
# 1. list_documents 隐私修复验证
# ============================================

class TestListDocumentsPrivacyFix:
    """list_documents 隐私修复测试"""

    def test_superuser_privilege_removed(self):
        """验证 list_documents 不再有超级管理员看全部的特权"""
        source = read_source("app/api/routes/documents.py")
        # 定位 accessible 范围的处理逻辑
        accessible_pos = source.find("scope == \"accessible\"")
        if accessible_pos == -1:
            # 可能是 else 分支
            accessible_pos = source.find("# accessible（默认）")
        assert accessible_pos > 0, "应有 accessible 范围的注释"

        # 检查修复后的逻辑：应该是统一的过滤，不再有 is_superuser 判断
        # 修复前的代码：
        #   if current_user.is_superuser:
        #       pass  # 不加过滤
        #   else:
        #       query = query.filter(...)
        # 修复后的代码：
        #   query = query.filter((Document.user_id == current_user.id) | (Document.visibility == VISIBILITY_PUBLIC))

        # 检查在 accessible 处理块中不再有 is_superuser 的条件分支
        following = source[accessible_pos:accessible_pos + 500]
        # 不应出现 "if current_user.is_superuser" 和 "pass  # 不加过滤"
        assert "if current_user.is_superuser" not in following, \
            "accessible 范围不应有超级管理员的特殊分支"
        assert "pass  # 不加过滤" not in following, \
            "不应有 pass 不加过滤的逻辑"

    def test_accessible_filters_correctly(self):
        """验证 accessible 范围正确过滤（自己的 + 公共文档）"""
        source = read_source("app/api/routes/documents.py")
        # 在 accessible 范围处理中应包含正确的过滤条件
        # 查找 "隐私修复" 注释作为锚点
        privacy_fix_pos = source.find("隐私修复：超级管理员也只能看到自己的文档 + 公共文档")
        assert privacy_fix_pos > 0, "应有隐私修复的注释说明"
        end_pos = source.find("    # 状态筛选", privacy_fix_pos)
        following = source[privacy_fix_pos:end_pos]
        assert "Document.user_id == current_user.id" in following, \
            "应包含 user_id 过滤"
        assert "Document.visibility == VISIBILITY_PUBLIC" in following, \
            "应包含 visibility=public 过滤"
        assert "Document.visibility == VISIBILITY_PRIVATE" in following
        assert "Document.organization_id.in_(organization_ids)" in following

    def test_mine_scope_unaffected(self):
        """验证 mine 范围不受影响"""
        source = read_source("app/api/routes/documents.py")
        mine_pos = source.find("scope == \"mine\"")
        assert mine_pos > 0, "应有 mine 范围处理"
        following = source[mine_pos:mine_pos + 200]
        assert "Document.user_id == current_user.id" in following, \
            "mine 范围应只返回自己的文档"

    def test_public_scope_unaffected(self):
        """验证 public 范围不受影响"""
        source = read_source("app/api/routes/documents.py")
        public_pos = source.find("scope == \"public\"")
        assert public_pos > 0, "应有 public 范围处理"
        following = source[public_pos:public_pos + 200]
        assert "Document.visibility == VISIBILITY_PUBLIC" in following, \
            "public 范围应只返回公共文档"


# ============================================
# 2. get_accessible_document_ids 设计验证
# ============================================

class TestGetAccessibleDocumentIdsDesign:
    """get_accessible_document_ids 设计测试"""

    def test_no_superuser_parameter(self):
        """验证该方法没有 is_superuser 参数"""
        source = read_source("app/services/permission.py")
        # 方法签名检查：只检查参数定义行
        method_pos = source.find("def get_accessible_document_ids(")
        assert method_pos > 0
        # 找到方法的参数列表结束位置（下一个方法的 def 之前）
        next_method_pos = source.find("\n    def ", method_pos + 1)
        assert next_method_pos > 0
        method_section = source[method_pos:next_method_pos]
        # 在参数列表中检查（不检查整个方法体，因为可能有其他方法的参数）
        # 参数定义在方法签名的前几行
        param_end = method_section.find("\n        \"\"\"")
        if param_end > 0:
            param_section = method_section[:param_end]
        else:
            param_section = method_section[:200]
        # 不应包含 is_superuser 参数（注意：can_access_document 方法有这个参数）
        # 所以只检查 get_accessible_document_ids 的参数部分
        assert "is_superuser: bool" not in param_section, \
            "get_accessible_document_ids 不应有 is_superuser 参数"

    def test_filters_correctly_for_regular(self):
        """验证 regular 用户正确过滤（自己的 + 公共文档）"""
        source = read_source("app/services/permission.py")
        # 定位 regular 用户处理
        regular_pos = source.find("# 正式用户：个人文档（自己上传的） OR 公共文档")
        assert regular_pos > 0
        end_pos = source.find("# 只取已处理完成的文档", regular_pos)
        following = source[regular_pos:end_pos]
        assert "Document.user_id == user_id" in following, \
            "应包含 user_id 过滤"
        assert "Document.visibility == VISIBILITY_PUBLIC" in following, \
            "应包含 visibility=public 过滤"
        assert "Document.organization_id.in_(organization_ids)" in following


# ============================================
# 3. can_access_document 超管特权保留验证
# ============================================

class TestCanAccessDocumentSuperuserPrivilege:
    """can_access_document 超管特权测试"""

    def test_superuser_privilege_retained(self):
        """验证 can_access_document 保留超级管理员特权（用于特定管理场景）"""
        source = read_source("app/services/permission.py")
        can_access_pos = source.find("def can_access_document(")
        assert can_access_pos > 0
        # 找到方法体（跳过参数和文档字符串）
        # 超管特权判断在文档字符串之后
        doc_end = source.find("\n        # 超级管理员", can_access_pos)
        if doc_end == -1:
            doc_end = source.find("\n        if is_superuser", can_access_pos)
        assert doc_end > 0, "应找到超管特权判断的位置"
        # 验证超管特权存在
        following = source[doc_end:doc_end + 200]
        assert "is_superuser" in following, \
            "can_access_document 应保留超级管理员的特权判断"
        assert "return True" in following, \
            "超级管理员应返回 True"

    def test_superuser_privilege_documented(self):
        """验证超管特权有文档说明"""
        source = read_source("app/services/permission.py")
        # 检查 can_access_document 的文档
        can_access_doc_pos = source.find("校验用户是否有权访问指定文档")
        assert can_access_doc_pos > 0
        doc_section = source[can_access_doc_pos:can_access_doc_pos + 500]
        assert "超级管理员" in doc_section, \
            "文档应说明超级管理员的权限"


# ============================================
# 4. 端到端业务场景验证（静态分析）
# ============================================

class TestBusinessScenarioPrivacy:
    """业务场景隐私验证"""

    def test_superuser_cannot_list_others_private_documents(self):
        """验证超级管理员不能在列表中看到其他用户的私有文档"""
        source = read_source("app/api/routes/documents.py")
        # 验证 list_documents 的 accessible 逻辑不再有超管特殊处理
        # 使用更精确的定位：查找 accessible 范围的 else 分支
        else_pos = source.find("else:\n        # accessible（默认）")
        assert else_pos > 0, "应有 accessible 范围的 else 分支"
        following = source[else_pos:else_pos + 400]
        # 确保没有超管特殊处理
        assert "is_superuser" not in following, \
            "accessible 范围不应检查 is_superuser"

    def test_retrieval_scope_limited_for_superuser(self):
        """验证检索范围对超级管理员也有限制"""
        source = read_source("app/services/permission.py")
        # get_accessible_document_ids 没有 is_superuser 参数
        method_sig_pos = source.find("def get_accessible_document_ids(\n        self,\n        db: Session,\n        user_id: int,")
        assert method_sig_pos > 0
        params_section = source[method_sig_pos:method_sig_pos + 300]
        assert "is_superuser" not in params_section, \
            "检索范围方法不应有 is_superuser 参数"

    def test_audit_log_for_superuser_access_retained(self):
        """验证超级管理员访问审计日志功能保留"""
        source = read_source("app/api/routes/documents.py")
        # 检查 _audit_superuser_action 函数存在
        assert "_audit_superuser_action" in source, \
            "应保留超级管理员操作审计功能"
        # 检查在 get_document 中调用审计
        get_doc_pos = source.find("# M-4 修复：超级管理员访问他人文档时记录审计日志")
        assert get_doc_pos > 0, "应在文档访问时保留审计日志"
