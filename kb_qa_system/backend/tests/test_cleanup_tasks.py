"""
数据清理任务单元测试（D10-03 数据保留策略）

作用：
    验证 cleanup_expired_data 任务的清理逻辑正确性，覆盖以下场景：
    - CLEANUP_ENABLED=False 时跳过执行
    - CLEANUP_ENABLED=True 时执行 4 表 DELETE 并返回统计
    - 各表使用对应的 *_RETENTION_DAYS 配置计算截止时间
    - Conversation 表使用 is_active=false（非 is_deleted）作为软删除标记
    - 异常时 rollback 并向上抛出

实现方式：
    使用 unittest + mock，通过 importlib 直接加载 cleanup_tasks.py 模块
    （绕过 app/tasks/__init__.py 的导入链，避免 celery/kombu 依赖），
    聚焦验证清理逻辑本身，不依赖真实数据库。
    符合项目"静态分析 + 行为测试，避免运行时依赖"策略。
"""

import importlib.util
import logging
import os
import sys
import types
import unittest
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

# 添加项目根目录到 sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ============================================
# Mock 缺失的运行时依赖（测试环境未安装 celery/kombu/psycopg）
# ============================================

# Mock celery 模块（cleanup_tasks.py 使用 @shared_task(name=...) 装饰器）
_celery = types.ModuleType("celery")


def _shared_task(*args, **kwargs):
    """
    Mock shared_task 装饰器

    作用：
        支持 @shared_task 和 @shared_task(name=...) 两种用法，
        原样返回被装饰函数，使其可在测试中直接调用。
    """
    if args and callable(args[0]):
        # 用法 @shared_task（无括号）
        return args[0]
    # 用法 @shared_task(name=...)（有括号，返回装饰器）
    return lambda f: f


_celery.shared_task = _shared_task

# Mock celery.utils.log（cleanup_tasks.py 使用 get_task_logger）
_celery_utils = types.ModuleType("celery.utils")
_celery_utils_log = types.ModuleType("celery.utils.log")
_celery_utils_log.get_task_logger = lambda name: logging.getLogger(name)

# Mock app.core.database（避免 create_engine 需要 psycopg 驱动）
# 作用：SessionLocal 在测试中会被 patch 替换，此处仅提供占位
_db_module = types.ModuleType("app.core.database")
_db_module.SessionLocal = MagicMock()


# ============================================
# 使用 importlib 直接加载 cleanup_tasks.py（绕过 app/tasks/__init__.py）
# 作用：避免 __init__.py 导入 document_tasks → celery_app → celery 的依赖链
# ============================================

_cleanup_path = os.path.join(BACKEND_DIR, "app", "tasks", "cleanup_tasks.py")
_spec = importlib.util.spec_from_file_location("app.tasks.cleanup_tasks", _cleanup_path)
cleanup_module = importlib.util.module_from_spec(_spec)
sys.modules["app.tasks.cleanup_tasks"] = cleanup_module
_stubbed_modules = {
    "celery": _celery,
    "celery.utils": _celery_utils,
    "celery.utils.log": _celery_utils_log,
    "app.core.database": _db_module,
}
_previous_modules = {name: sys.modules.get(name) for name in _stubbed_modules}
try:
    sys.modules.update(_stubbed_modules)
    _spec.loader.exec_module(cleanup_module)
finally:
    for name, module in _previous_modules.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module


class TestCleanupExpiredData(unittest.TestCase):
    """
    测试 cleanup_expired_data 定时清理任务

    覆盖验证：
        - 清理开关（CLEANUP_ENABLED）行为
        - 4 张表的 DELETE SQL 执行与统计
        - 各表保留期配置的正确应用
        - Conversation 软删除字段 is_active 的使用
        - 异常回滚与错误传播
    """

    def _make_mock_db(self, rowcounts=None):
        """
        创建模拟数据库会话

        作用：
            构建一个 mock db 对象，其 execute 方法按调用顺序返回指定的 rowcount。

        参数：
            rowcounts: list[int] - 每次 execute 调用返回的 rowcount 列表（对应 4 张表）

        返回：
            MagicMock - 模拟的数据库会话对象
        """
        db = MagicMock()
        if rowcounts is None:
            rowcounts = [5, 10, 3, 2]

        results = []
        for count in rowcounts:
            result = MagicMock()
            result.rowcount = count
            results.append(result)

        db.execute.side_effect = results
        return db

    def test_cleanup_disabled_returns_skipped(self):
        """测试 CLEANUP_ENABLED=False 时返回 skipped 且不执行任何 DELETE"""
        with patch.object(cleanup_module, "settings") as mock_settings:
            mock_settings.CLEANUP_ENABLED = False

            with patch.object(cleanup_module, "SessionLocal") as mock_session_local:
                result = cleanup_module.cleanup_expired_data()

                # 验证返回跳过标记
                self.assertEqual(result["skipped"], True)
                self.assertIn("reason", result)
                # 验证未创建数据库会话（跳过时不应访问数据库）
                mock_session_local.assert_not_called()

    def test_cleanup_enabled_executes_delete(self):
        """测试 CLEANUP_ENABLED=True 时执行 4 表 DELETE 并返回统计"""
        with patch.object(cleanup_module, "settings") as mock_settings:
            mock_settings.CLEANUP_ENABLED = True
            mock_settings.CONVERSATION_RETENTION_DAYS = 90
            mock_settings.QA_EVENT_RETENTION_DAYS = 90
            mock_settings.EMAIL_LOG_RETENTION_DAYS = 30
            mock_settings.AUDIT_LOG_RETENTION_DAYS = 365

            mock_db = self._make_mock_db(rowcounts=[5, 10, 3, 2])

            with patch.object(cleanup_module, "SessionLocal", return_value=mock_db):
                result = cleanup_module.cleanup_expired_data()

                # 验证返回各表删除统计
                self.assertEqual(result["conversations"], 5)
                self.assertEqual(result["qa_events"], 10)
                self.assertEqual(result["email_logs"], 3)
                self.assertEqual(result["audit_logs"], 2)

                # 验证执行了 4 次 DELETE（4 张表）
                self.assertEqual(mock_db.execute.call_count, 4)
                # 验证提交了事务
                mock_db.commit.assert_called_once()
                # 验证关闭了会话
                mock_db.close.assert_called_once()

    def test_cleanup_uses_correct_retention_days(self):
        """测试各表使用对应的 *_RETENTION_DAYS 配置计算截止时间"""
        with patch.object(cleanup_module, "settings") as mock_settings:
            mock_settings.CLEANUP_ENABLED = True
            mock_settings.CONVERSATION_RETENTION_DAYS = 90
            mock_settings.QA_EVENT_RETENTION_DAYS = 90
            mock_settings.EMAIL_LOG_RETENTION_DAYS = 30
            mock_settings.AUDIT_LOG_RETENTION_DAYS = 365

            mock_db = self._make_mock_db()

            with patch.object(cleanup_module, "SessionLocal", return_value=mock_db):
                cleanup_module.cleanup_expired_data()

                # 获取 4 次 execute 调用的参数
                calls = mock_db.execute.call_args_list
                self.assertEqual(len(calls), 4)

                # 验证每次调用都传入了 cutoff 参数
                # 注意：db.execute(text(sql), {"cutoff": cutoff}) 中 params 是第二个位置参数
                for call in calls:
                    args, kwargs = call
                    self.assertEqual(len(args), 2)  # text() 结果 + params 字典
                    params = args[1]
                    self.assertIn("cutoff", params)
                    cutoff = params["cutoff"]
                    # cutoff 应为 datetime 类型
                    self.assertIsInstance(cutoff, datetime)

                # 验证截止时间与保留期对应（允许几秒误差）
                now = datetime.now(UTC)
                # 第 1 次：conversations，保留 90 天
                conv_cutoff = calls[0].args[1]["cutoff"]
                delta_days = (now - conv_cutoff).days
                self.assertAlmostEqual(delta_days, 90, delta=1)

                # 第 3 次：email_logs，保留 30 天
                email_cutoff = calls[2].args[1]["cutoff"]
                delta_days = (now - email_cutoff).days
                self.assertAlmostEqual(delta_days, 30, delta=1)

                # 第 4 次：audit_logs，保留 365 天
                audit_cutoff = calls[3].args[1]["cutoff"]
                delta_days = (now - audit_cutoff).days
                self.assertAlmostEqual(delta_days, 365, delta=1)

    def test_cleanup_conversation_uses_is_active(self):
        """测试 Conversation 表使用 is_active=false（非 is_deleted）作为软删除条件"""
        with patch.object(cleanup_module, "settings") as mock_settings:
            mock_settings.CLEANUP_ENABLED = True
            mock_settings.CONVERSATION_RETENTION_DAYS = 90
            mock_settings.QA_EVENT_RETENTION_DAYS = 90
            mock_settings.EMAIL_LOG_RETENTION_DAYS = 30
            mock_settings.AUDIT_LOG_RETENTION_DAYS = 365

            mock_db = self._make_mock_db()

            with patch.object(cleanup_module, "SessionLocal", return_value=mock_db):
                cleanup_module.cleanup_expired_data()

                # 获取第一次 execute 调用（conversations 表）
                first_call = mock_db.execute.call_args_list[0]
                sql_text = str(first_call.args[0])

                # 验证 SQL 使用 is_active = false
                self.assertIn("is_active = false", sql_text)
                # 验证不使用 is_deleted（前序会话纠错的关键点）
                self.assertNotIn("is_deleted", sql_text)
                # 验证表名正确
                self.assertIn("conversations", sql_text)

    def test_cleanup_rollback_on_error(self):
        """测试异常时执行 rollback 并向上抛出异常"""
        with patch.object(cleanup_module, "settings") as mock_settings:
            mock_settings.CLEANUP_ENABLED = True
            mock_settings.CONVERSATION_RETENTION_DAYS = 90
            mock_settings.QA_EVENT_RETENTION_DAYS = 90
            mock_settings.EMAIL_LOG_RETENTION_DAYS = 30
            mock_settings.AUDIT_LOG_RETENTION_DAYS = 365

            mock_db = MagicMock()
            # 模拟第二次 execute 抛出异常
            first_result = MagicMock()
            first_result.rowcount = 5
            mock_db.execute.side_effect = [first_result, RuntimeError("数据库连接断开")]

            with patch.object(cleanup_module, "SessionLocal", return_value=mock_db):
                # 验证异常被向上抛出
                with self.assertRaises(RuntimeError) as ctx:
                    cleanup_module.cleanup_expired_data()

                self.assertIn("数据库连接断开", str(ctx.exception))
                # 验证执行了 rollback
                mock_db.rollback.assert_called_once()
                # 验证未执行 commit
                mock_db.commit.assert_not_called()
                # 验证关闭了会话（finally 块）
                mock_db.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
