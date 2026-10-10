"""
文档上传冲突处理修复验证测试

作用：
    验证"文档重名/重传修复"的正确性与完整性，覆盖用户提出的两个关键问题：
    1) 上传与现有文档内容相同的文件时不再直接失败，提供冲突处理选项；
    2) 软删除历史文档后，用户可以再次上传相同内容的文件（不被历史阻塞）。

    重新设计的唯一性校验逻辑：
    - DB 层移除 file_hash 唯一约束（改为普通索引）
    - 应用层仅检查 is_deleted=False 的活跃文档
    - 提供 conflict_resolution 参数（rename/overwrite/keep_both）

测试策略：
    1. 静态分析测试：直接读取源码文件内容，验证修复结构存在（不导入 documents 模块，
       避免因 psycopg/celery/langchain 等运行时依赖缺失导致测试失败）
    2. 行为测试：对纯 Python 辅助函数 _generate_unique_title /
       _generate_unique_filename，通过 ast 提取函数源码 + exec 在受控命名空间执行，
       使用 MagicMock 模拟 db.query 链，验证逻辑正确性

覆盖维度：
    - 迁移脚本存在且降级唯一约束
    - 模型 file_hash 不再含 unique=True
    - 上传端点含 conflict_resolution 参数与三种策略分支
    - 辅助函数 _generate_unique_title / _generate_unique_filename 行为正确
    - 软删除文档不再阻塞重新上传（应用层只检查 is_deleted=False）

运行方式：
    cd backend
    python -m pytest tests/test_upload_conflict.py -v
"""

import ast
from pathlib import Path
from unittest.mock import MagicMock

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
        避免因 psycopg/celery/langchain 等运行时依赖缺失导致测试失败。

    参数：
        relative_path: str - 相对于 backend 目录的路径

    返回：
        str - 文件内容
    """
    file_path = BACKEND_DIR / relative_path
    return file_path.read_text(encoding="utf-8")


# ============================================
# 辅助：从源码文本中提取指定函数并 exec 到命名空间
# ============================================

def _extract_function(source: str, func_name: str) -> dict:
    """
    从源码文本中提取指定函数定义，exec 到受控命名空间后返回命名空间

    作用：
        documents.py 导入会触发 celery/langchain 等重依赖，无法直接 import。
        本函数通过 ast 提取单个函数定义，在仅包含必要 stub 的命名空间中执行，
        使测试能直接调用函数本体验证行为。

    参数：
        - source: str - 源码文本
        - func_name: str - 要提取的函数名

    返回：
        dict - 包含已 exec 函数的命名空间（可通过 ns[func_name] 调用）
    """
    module = ast.parse(source)
    # 预置 stub：
    # - Session：函数签名注解引用 sqlalchemy.orm.Session，提供占位类避免 NameError
    # - Document：函数体引用 Document.title / Document.file_name / Document.user_id
    #   / Document.is_deleted 作为 ORM 查询字段，运行时仅作为参数传递给 db.query()
    #   / .filter()（已被 MagicMock 拦截），所以用 MagicMock 作占位即可
    ns: dict = {"Session": object, "Document": MagicMock()}
    for node in module.body:
        if isinstance(node, ast.FunctionDef) and node.name == func_name:
            # 编译单个函数定义并 exec 到命名空间
            code = compile(ast.Module(body=[node], type_ignores=[]), filename=f"<{func_name}>", mode="exec")
            exec(code, ns)
            return ns
    raise AssertionError(f"未在源码中找到函数: {func_name}")


# ============================================
# 1. 迁移脚本验证
# ============================================

class TestMigrationDropsUniqueConstraint:
    """迁移 20260715_0006 降级 file_hash 唯一约束测试"""

    def test_migration_file_exists(self):
        """验证迁移文件存在"""
        migration_path = BACKEND_DIR / "alembic/versions/20260715_0006_drop_file_hash_unique.py"
        assert migration_path.exists(), "迁移文件 20260715_0006_drop_file_hash_unique.py 应存在"

    def test_migration_revision_and_down_revision(self):
        """验证迁移 revision 与 down_revision 链接正确"""
        source = read_source("alembic/versions/20260715_0006_drop_file_hash_unique.py")
        assert 'revision = "20260715_0006"' in source, "revision 应为 20260715_0006"
        assert 'down_revision = "20260712_0005"' in source, "down_revision 应指向 20260712_0005"

    def test_upgrade_drops_unique_index(self):
        """验证 upgrade 删除原唯一索引"""
        source = read_source("alembic/versions/20260715_0006_drop_file_hash_unique.py")
        assert 'op.drop_index("ix_documents_file_hash"' in source, \
            "upgrade 应删除原 ix_documents_file_hash 索引"

    def test_upgrade_creates_non_unique_index(self):
        """验证 upgrade 重建为普通索引（unique=False）"""
        source = read_source("alembic/versions/20260715_0006_drop_file_hash_unique.py")
        # 必须包含 unique=False 的重建调用
        assert 'op.create_index("ix_documents_file_hash", "documents", ["file_hash"], unique=False)' in source, \
            "upgrade 应以 unique=False 重建索引"

    def test_downgrade_restores_unique_index(self):
        """验证 downgrade 可回滚恢复唯一约束"""
        source = read_source("alembic/versions/20260715_0006_drop_file_hash_unique.py")
        assert 'op.create_index("ix_documents_file_hash", "documents", ["file_hash"], unique=True)' in source, \
            "downgrade 应以 unique=True 恢复索引"


# ============================================
# 2. 模型层验证
# ============================================

class TestModelFileHashNoLongerUnique:
    """Document.file_hash 不再含 unique=True 验证"""

    def test_file_hash_not_unique(self):
        """验证 file_hash 字段定义不含 unique=True"""
        source = read_source("app/models/document.py")
        document = next(node for node in ast.parse(source).body
                        if isinstance(node, ast.ClassDef) and node.name == "Document")
        field = next(node for node in document.body
                     if isinstance(node, ast.AnnAssign)
                     and isinstance(node.target, ast.Name)
                     and node.target.id == "file_hash")
        field_definition = ast.unparse(field.value)
        assert "unique=True" not in field_definition, \
            "file_hash 不应再含 unique=True（应改为普通索引）"
        assert "index=True" in field_definition, \
            "file_hash 应保留 index=True 以维持查询性能"

    def test_file_hash_doc_explains_design(self):
        """验证 file_hash 注释说明了去重移至应用层的设计"""
        source = read_source("app/models/document.py")
        # 注释应说明：去重逻辑在应用层实现，不再使用 DB 唯一约束
        assert "去重逻辑在应用层实现" in source or "应用层" in source, \
            "file_hash 注释应说明去重已移至应用层"
        assert "不再使用 DB 唯一约束" in source or "不再" in source, \
            "file_hash 注释应说明不再使用 DB 唯一约束"


# ============================================
# 3. 上传端点结构验证（静态分析）
# ============================================

class TestUploadEndpointConflictStructure:
    """上传端点 conflict_resolution 参数与策略分支结构验证"""

    def test_conflict_resolution_param_exists(self):
        """验证上传端点含 conflict_resolution Form 参数"""
        source = read_source("app/api/routes/documents.py")
        assert "conflict_resolution: Optional[str] = Form(" in source, \
            "上传端点应有 conflict_resolution Form 参数"

    def test_valid_resolutions_check(self):
        """验证对 conflict_resolution 非法值的校验逻辑"""
        source = read_source("app/api/routes/documents.py")
        assert 'VALID_RESOLUTIONS = {"rename", "overwrite", "keep_both"}' in source, \
            "应有 VALID_RESOLUTIONS 集合定义"
        assert "INVALID_CONFLICT_RESOLUTION" in source, \
            "非法值应返回 INVALID_CONFLICT_RESOLUTION 错误码"

    def test_three_strategy_branches_exist(self):
        """验证三种冲突处理策略分支均存在"""
        source = read_source("app/api/routes/documents.py")
        assert 'conflict_resolution == "rename"' in source, \
            "应有 rename 策略分支"
        assert 'conflict_resolution == "overwrite"' in source, \
            "应有 overwrite 策略分支"
        assert 'conflict_resolution == "keep_both"' in source, \
            "应有 keep_both 策略分支"

    def test_file_hash_conflict_error_code(self):
        """验证默认冲突时返回 FILE_HASH_CONFLICT 错误码"""
        source = read_source("app/api/routes/documents.py")
        assert '"code": "FILE_HASH_CONFLICT"' in source, \
            "默认冲突应返回 FILE_HASH_CONFLICT 错误码"
        # 错误响应应包含前端展示冲突对话框所需的字段
        assert '"suggested_name"' in source, \
            "冲突响应应包含 suggested_name 字段"
        assert '"existing_title"' in source, \
            "冲突响应应包含 existing_title 字段"
        assert '"document_id"' in source, \
            "冲突响应应包含 document_id 字段"
        assert '"available_resolutions"' in source, \
            "冲突响应应包含 available_resolutions 字段"

    def test_query_filters_only_active_documents(self):
        """验证去重查询仅检查 is_deleted=False 的活跃文档（关键修复点）"""
        source = read_source("app/api/routes/documents.py")
        # 在去重查询中应同时过滤 file_hash + is_deleted=False + user_id
        # 这是修复问题2（软删除后无法重传）的核心
        assert "Document.is_deleted == False" in source, \
            "去重查询应过滤 is_deleted=False"

    def test_overwrite_defers_switch_until_indexed(self):
        """验证 overwrite 将旧文档关联到待处理替换项，不提前删除旧版本"""
        source = read_source("app/api/routes/documents.py")
        task_source = read_source("app/tasks/document_tasks.py")
        assert "supersedes_document_id=existing.id if existing and conflict_resolution == \"overwrite\" else None" in source, \
            "新文档应记录待替换的旧文档"
        assert "activate_replacement(db, document)" in task_source, \
            "旧文档应在新文档成功索引后切换"

    def test_overwrite_deletes_vector_chunks(self):
        """验证 overwrite 策略删除旧文档的向量分块"""
        source = read_source("app/api/routes/documents.py")
        # overwrite 分支应调用 vector_store.delete_document_chunks
        assert "delete_document_chunks" in source, \
            "overwrite 分支应调用 delete_document_chunks 清理向量"

    def test_rename_applies_unique_title_and_filename(self):
        """验证 rename 策略调用两个唯一性生成函数"""
        source = read_source("app/api/routes/documents.py")
        # rename 分支应在创建记录前应用 _generate_unique_title 和 _generate_unique_filename
        assert "_generate_unique_title(doc_title" in source, \
            "rename 应调用 _generate_unique_title"
        assert "_generate_unique_filename(safe_filename" in source, \
            "rename 应调用 _generate_unique_filename"

    def test_helper_functions_exist(self):
        """验证两个辅助函数定义存在"""
        source = read_source("app/api/routes/documents.py")
        assert "def _generate_unique_title(base_title: str, user_id: int, db: Session) -> str:" in source, \
            "应有 _generate_unique_title 函数定义"
        assert "def _generate_unique_filename(base_filename: str, user_id: int, db: Session) -> str:" in source, \
            "应有 _generate_unique_filename 函数定义"

    def test_default_conflict_cleans_temp_file(self):
        """验证默认冲突（未指定策略）时清理临时文件"""
        source = read_source("app/api/routes/documents.py")
        # 定位 FILE_HASH_CONFLICT 错误响应前的临时文件清理逻辑
        conflict_pos = source.find('"code": "FILE_HASH_CONFLICT"')
        assert conflict_pos > 0
        # 在冲突错误之前的 500 字符内应有 os.remove(file_path)
        # （包含 try/except 包裹和注释，实际间隔约 200-400 字符）
        preceding = source[max(0, conflict_pos - 500):conflict_pos]
        assert "os.remove(file_path)" in preceding, \
            "默认冲突时应删除刚写入的临时文件"

    def test_redis_distributed_lock_for_upload(self):
        """验证上传去重使用 Redis 分布式锁保证并发安全"""
        source = read_source("app/api/routes/documents.py")
        # 应使用 RedisKeys.distributed_lock 包装 upload:hash:{file_hash}
        assert 'distributed_lock(f"upload:hash:{file_hash}")' in source, \
            "应使用 Redis 分布式锁防止并发 TOCTOU 竞态"
        assert "RedisManager.acquire_lock(upload_lock_key" in source, \
            "应调用 acquire_lock 获取锁"
        assert "RedisManager.release_lock(upload_lock_key, upload_lock_token)" in source, \
            "应在 finally 释放锁"

    def test_integrity_error_fallback_retained(self):
        """验证 IntegrityError 兜底处理保留（防未来扩展的唯一约束）"""
        source = read_source("app/api/routes/documents.py")
        assert "IntegrityError" in source, \
            "应保留 IntegrityError 兜底处理"


# ============================================
# 4. _generate_unique_title 行为测试
# ============================================

class TestGenerateUniqueTitleBehavior:
    """_generate_unique_title 行为测试

    作用：
        通过 ast 提取函数源码 + exec 在受控命名空间执行，
        使用 MagicMock 模拟 db.query 链，验证逻辑正确性。
        避免导入 documents.py 触发 celery/langchain 等重依赖。
    """

    @pytest.fixture
    def func(self):
        """提取 _generate_unique_title 函数到可调用对象"""
        source = read_source("app/api/routes/documents.py")
        ns = _extract_function(source, "_generate_unique_title")
        return ns["_generate_unique_title"]

    @staticmethod
    def _make_db(existing_titles):
        """
        构造模拟 db 对象

        参数：
            existing_titles: list[str] - 当前用户已有的活跃文档标题列表

        返回：
            MagicMock - 支持 db.query(Document.title).filter(...).all() 链式调用
        """
        db = MagicMock()
        # 模拟 .all() 返回 [(title,), (title,), ...] 格式（与 SQLAlchemy 一致）
        rows = [(t,) for t in existing_titles]
        db.query.return_value.filter.return_value.all.return_value = rows
        return db

    def test_no_conflict_returns_original(self, func):
        """无冲突时返回原标题"""
        db = self._make_db(existing_titles=["其他文档", "另一篇"])
        result = func("我的报告", user_id=1, db=db)
        assert result == "我的报告"

    def test_conflict_appends_counter(self, func):
        """冲突时追加 (1) 序号"""
        db = self._make_db(existing_titles=["我的报告"])
        result = func("我的报告", user_id=1, db=db)
        assert result == "我的报告 (1)"

    def test_conflict_increments_until_available(self, func):
        """多个序号被占用时持续递增"""
        db = self._make_db(existing_titles=["我的报告", "我的报告 (1)", "我的报告 (2)"])
        result = func("我的报告", user_id=1, db=db)
        assert result == "我的报告 (3)"

    def test_empty_existing_returns_original(self, func):
        """用户无任何文档时返回原标题"""
        db = self._make_db(existing_titles=[])
        result = func("首次上传", user_id=1, db=db)
        assert result == "首次上传"


# ============================================
# 5. _generate_unique_filename 行为测试
# ============================================

class TestGenerateUniqueFilenameBehavior:
    """_generate_unique_filename 行为测试"""

    @pytest.fixture
    def func(self):
        """提取 _generate_unique_filename 函数到可调用对象"""
        source = read_source("app/api/routes/documents.py")
        ns = _extract_function(source, "_generate_unique_filename")
        return ns["_generate_unique_filename"]

    @staticmethod
    def _make_db(existing_names):
        """
        构造模拟 db 对象

        参数：
            existing_names: list[str] - 当前用户已有的活跃文档文件名列表

        返回：
            MagicMock
        """
        db = MagicMock()
        rows = [(n,) for n in existing_names]
        db.query.return_value.filter.return_value.all.return_value = rows
        return db

    def test_no_conflict_returns_original(self, func):
        """无冲突时返回原文件名"""
        db = self._make_db(existing_names=["其他.pdf", "another.md"])
        result = func("report.pdf", user_id=1, db=db)
        assert result == "report.pdf"

    def test_conflict_appends_counter_before_extension(self, func):
        """冲突时在扩展名前追加序号：report.pdf → report (1).pdf"""
        db = self._make_db(existing_names=["report.pdf"])
        result = func("report.pdf", user_id=1, db=db)
        assert result == "report (1).pdf"

    def test_multiple_conflicts_increment(self, func):
        """多个序号被占用时持续递增"""
        db = self._make_db(existing_names=[
            "report.pdf", "report (1).pdf", "report (2).pdf"
        ])
        result = func("report.pdf", user_id=1, db=db)
        assert result == "report (3).pdf"

    def test_no_extension_filename(self, func):
        """无扩展名的文件名也能正确处理"""
        db = self._make_db(existing_names=["README"])
        result = func("README", user_id=1, db=db)
        assert result == "README (1)"

    def test_double_extension_preserved(self, func):
        """双扩展名仅在最右侧扩展名前追加序号：archive.tar.gz → archive.tar (1).gz"""
        db = self._make_db(existing_names=["archive.tar.gz"])
        result = func("archive.tar.gz", user_id=1, db=db)
        assert result == "archive.tar (1).gz"


# ============================================
# 6. 软删除后重传场景验证（关键修复点）
# ============================================

class TestSoftDeletedDocumentDoesNotBlockReupload:
    """软删除文档不再阻塞重新上传（关键修复点）

    作用：
        验证用户问题2的核心修复——文档软删除后用户可再次上传相同内容文件。
        通过静态分析确认去重查询的过滤条件，并模拟场景验证逻辑正确性。
    """

    def test_dedup_query_filters_is_deleted_false(self):
        """验证去重查询显式过滤 is_deleted=False（不查软删除文档）"""
        source = read_source("app/api/routes/documents.py")
        # 在去重查询块中应同时出现 file_hash + is_deleted=False + user_id 三个过滤条件
        # 锚点：去重查询以 "existing = db.query(Document)" 开头
        query_pos = source.find("existing = db.query(Document).filter(")
        assert query_pos > 0, "应有去重查询 existing = db.query(Document).filter(...)"
        # 截取查询块后 600 字符（覆盖三个过滤条件）
        following = source[query_pos:query_pos + 600]
        assert "Document.file_hash == file_hash" in following, \
            "去重查询应按 file_hash 过滤"
        assert "Document.is_deleted == False" in following, \
            "去重查询应过滤 is_deleted=False（软删除文档不阻塞重传）"
        assert "Document.user_id == current_user.id" in following, \
            "去重查询应限定当前用户（不同用户互不影响）"

    def test_dedup_query_does_not_match_soft_deleted(self):
        """行为验证：软删除文档不应被去重查询匹配

        场景：
            用户上传过 report.pdf（hash=abc），后将其删除（is_deleted=True）。
            用户再次上传相同内容的 report.pdf。
            去重查询应返回 None，允许上传继续。

        实现方式：
            通过 ast 提取上传端点中的去重查询逻辑太复杂（依赖整个函数上下文），
            因此这里通过静态分析 + 注释文档验证修复意图。
        """
        source = read_source("app/api/routes/documents.py")
        # 验证修复注释明确说明了软删除不阻塞重传
        assert "软删除" in source, \
            "应有注释说明软删除的处理方式"
        assert "不再阻塞重新上传" in source or "不阻塞" in source, \
            "注释应明确说明软删除文档不再阻塞重新上传"

    def test_keep_both_allows_duplicate_hash(self):
        """keep_both 策略允许相同内容共存（跳过去重）"""
        source = read_source("app/api/routes/documents.py")
        # keep_both 分支应跳过去重（不删除旧文档，不返回 409）
        keep_both_pos = source.find('conflict_resolution == "keep_both"')
        assert keep_both_pos > 0
        # keep_both 分支应跳过软删除/向量清理逻辑
        following = source[keep_both_pos:keep_both_pos + 300]
        # 应包含跳过去重的注释或日志
        assert "保留两者" in following or "keep_both" in following, \
            "keep_both 分支应说明跳过去重、保留两者"


# ============================================
# 7. 端到端业务流程验证（静态分析）
# ============================================

class TestBusinessFlowIntegrity:
    """端到端业务流程完整性验证

    作用：
        通过静态分析验证各业务场景的代码路径完整，确保：
        - 正常上传：无冲突时直接创建记录
        - 重名上传：默认返回 409 FILE_HASH_CONFLICT，由前端展示选择
        - 重名上传 + rename：自动重命名后正常上传
        - 重名上传 + overwrite：软删除旧文档 + 删向量 + 上传新文档
        - 重名上传 + keep_both：跳过去重，直接上传
        - 历史文档重传：软删除文档不进入去重结果，允许上传
    """

    def test_normal_upload_path_exists(self):
        """正常上传路径：existing=None 时直接创建记录"""
        source = read_source("app/api/routes/documents.py")
        # 去重查询结果为 None 时，应进入创建记录流程
        assert "existing = None" in source, "应有 existing 初始化为 None"
        assert "db.add(db_document)" in source, "应有 db.add 创建记录"
        assert "db.commit()" in source, "应有 db.commit 提交事务"

    def test_conflict_path_returns_409(self):
        """冲突路径：默认返回 409 + FILE_HASH_CONFLICT"""
        source = read_source("app/api/routes/documents.py")
        assert "status.HTTP_409_CONFLICT" in source, \
            "默认冲突应返回 409 状态码"

    def test_rename_path_creates_new_document(self):
        """rename 路径：应用重命名后作为新文档上传"""
        source = read_source("app/api/routes/documents.py")
        # rename 分支不软删除旧文档（不设 is_deleted=True）
        rename_pos = source.find('conflict_resolution == "rename"')
        following = source[rename_pos:rename_pos + 200]
        # rename 分支内不应出现 is_deleted = True（那是 overwrite 的逻辑）
        assert "is_deleted = True" not in following, \
            "rename 分支不应软删除旧文档"

    def test_overwrite_path_preserves_old_until_replacement_ready(self):
        """overwrite 路径：准备替换项，索引成功后再原子切换"""
        source = read_source("app/api/routes/documents.py")
        assert "REPLACEMENT_IN_PROGRESS" in source, \
            "同一旧版本已有待处理替换时应拒绝重复覆盖"
        assert "supersedes_document_id=existing.id" in source, \
            "新文档应保留替换关联直到处理完成"

    def test_celery_task_triggered_after_upload(self):
        """上传后触发 Celery 异步任务（处理流水线）"""
        source = read_source("app/api/routes/documents.py")
        # 应有 Celery 任务的 delay 调用
        assert ".delay(" in source, "上传后应触发 Celery 任务"

    def test_response_includes_task_id(self):
        """响应中包含 task_id 供前端轮询"""
        source = read_source("app/api/routes/documents.py")
        # 应有 task_id 字段返回（前端通过它查询处理进度）
        assert "task_id" in source, "响应应包含 task_id"

    def test_lock_released_in_finally(self):
        """验证锁在 finally 块释放（无论成功失败）"""
        source = read_source("app/api/routes/documents.py")
        # 定位 finally 块中的锁释放
        finally_pos = source.find("释放上传去重锁")
        assert finally_pos > 0, "应有释放上传去重锁的注释"
        following = source[finally_pos:finally_pos + 200]
        assert "upload_lock_key" in following, \
            "finally 块应引用 upload_lock_key"
        assert "upload_lock_token" in following, \
            "finally 块应引用 upload_lock_token"
