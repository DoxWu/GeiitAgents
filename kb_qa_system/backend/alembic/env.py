"""
Alembic 迁移环境配置

作用：
    配置 Alembic 迁移工具，从应用配置读取数据库 URL，
    并导入所有模型用于自动生成迁移脚本。

实现方式：
    1. 从 app.core.config 读取数据库 URL（覆盖 alembic.ini 中的配置）
    2. 导入所有模型，确保 Alembic 能发现所有表
    3. 配置离线模式（生成 SQL）和在线模式（直接执行）
"""

import os
import sys
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool
from alembic import context

# 将项目根目录加入 sys.path，确保能导入 app 模块
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 导入配置和模型
from app.core.config import settings
from app.core.database import Base

# 导入所有模型，确保 Alembic 能发现它们
from app.models import (
    User, Document, DocumentChunk, Conversation, Message, QAEvent,
    RegistrationApplication, EmailLog, Note, Todo, Reminder, ReminderDelivery,
)

# Alembic 配置
config = context.config

# 从应用配置覆盖数据库 URL
# 作用：统一使用 .env 中的数据库配置，不依赖 alembic.ini
# Railway 兼容：自动转换 postgresql:// → postgresql+psycopg://
database_url = config.attributes.get("database_url", settings.DATABASE_URL)
database_url = database_url.replace("postgres://", "postgresql://", 1)
if database_url.startswith("postgresql://") and "+psycopg" not in database_url:
    database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))

# 日志配置
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# MetaData 对象，用于自动生成迁移
target_metadata = Base.metadata


# ============================================
# 离线模式：生成 SQL 脚本
# ============================================

def run_migrations_offline() -> None:
    """
    离线模式运行迁移

    作用：
        生成 SQL 脚本，不连接数据库。
        适用于：审查迁移脚本、在受限环境执行。

    实现方式：
        - context.configure: 配置迁移
        - context.run_migrations: 生成 SQL
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # 比较时包含类型，确保类型变更被检测
        compare_type=True,
        compare_server_default=True,
    )

    with context.begin_transaction():
        context.run_migrations()


# ============================================
# 在线模式：直接执行迁移
# ============================================

def run_migrations_online() -> None:
    """
    在线模式运行迁移

    作用：
        连接数据库直接执行迁移。
        适用于：开发/生产环境执行迁移。

    实现方式：
        - engine_from_config: 创建数据库引擎
        - context.configure: 配置迁移
        - context.run_migrations: 执行迁移
    """
    # 创建引擎
    from app.ops.config import OpsSettings
    ops_settings = config.attributes.get("ops_settings") or OpsSettings()
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        connect_args={
            "connect_timeout": ops_settings.DB_CONNECT_TIMEOUT_SECONDS,
            "options": f"-c statement_timeout={ops_settings.DB_OPERATION_TIMEOUT_SECONDS * 1000} -c lock_timeout=10000",
        },
    )

    with connectable.connect() as connection:
        # Share the same maintenance lock with startup recovery and backups.
        if not config.attributes.get("maintenance_lock_held"):
            from sqlalchemy import text
            from app.ops.postgres import LOCK_ID
            connection.execute(text("SET lock_timeout = '300s'"))
            connection.execute(text("SELECT pg_advisory_lock(:key)"), {"key": LOCK_ID})
            connection.commit()
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )

        with context.begin_transaction():
            context.run_migrations()


# ============================================
# 执行迁移
# ============================================

if context.is_offline_mode():
    # 离线模式
    run_migrations_offline()
else:
    # 在线模式
    run_migrations_online()
