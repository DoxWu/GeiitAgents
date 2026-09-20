#!/bin/bash
# ============================================
# GeiIt企业知识库 - 数据库备份验证脚本（E6-03）
# ============================================
# 作用：
#     自动验证最新的数据库备份文件是否可正常恢复。
#     创建临时数据库 → 恢复备份 → 校验关键表 → 清理。
#
# 使用方式：
#     ./verify_backup.sh
#     建议每周通过 cron 调用一次：
#     0 3 * * 0 /path/to/verify_backup.sh >> /var/log/db_backup_verify.log 2>&1
#
# 环境变量：
#     DATABASE_URL          - PostgreSQL 连接字符串（必填，需有 CREATEDB 权限）
#     BACKUP_DIR            - 备份存储目录（可选，默认 ./backups）
#     VERIFY_DB_PREFIX      - 临时数据库名前缀（可选，默认 kb_qa_verify）
# ============================================

set -euo pipefail

# ============================================
# 配置项
# ============================================
BACKUP_DIR="${BACKUP_DIR:-./backups}"
VERIFY_DB_PREFIX="${VERIFY_DB_PREFIX:-kb_qa_verify}"

# 检查 DATABASE_URL
if [ -z "${DATABASE_URL:-}" ]; then
    echo "❌ 错误：DATABASE_URL 环境变量未设置"
    exit 1
fi

# ============================================
# 从 DATABASE_URL 解析连接参数
# ============================================
DB_URL="${DATABASE_URL/postgresql+psycopg/postgresql}"
DB_USERPASS=$(echo "$DB_URL" | sed -n 's#^.*//\([^@]*\)@.*#\1#p')
DB_HOSTPORT=$(echo "$DB_URL" | sed -n 's#^.*@\([^/]*\)/.*#\1#p')
DB_NAME=$(echo "$DB_URL" | sed -n 's#^.*/\([^?]*\).*$#\1#p')

DB_USER=$(echo "$DB_USERPASS" | cut -d: -f1)
DB_PASS=$(echo "$DB_USERPASS" | cut -d: -f2)
DB_HOST=$(echo "$DB_HOSTPORT" | cut -d: -f1)
DB_PORT=$(echo "$DB_HOSTPORT" | cut -d: -f2)
[ -z "$DB_PORT" ] && DB_PORT=5432

export PGPASSWORD="$DB_PASS"

# ============================================
# 查找最新备份文件
# ============================================
LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/kb_qa_backup_*.dump 2>/dev/null | head -1)

if [ -z "$LATEST_BACKUP" ]; then
    echo "❌ 错误：未找到备份文件（$BACKUP_DIR/kb_qa_backup_*.dump）"
    unset PGPASSWORD
    exit 1
fi

echo "📋 备份验证配置："
echo "   最新备份: $LATEST_BACKUP"
echo "   备份大小: $(du -h "$LATEST_BACKUP" | cut -f1)"
echo "   主机: $DB_HOST:$DB_PORT"
echo ""

# ============================================
# 创建临时数据库
# ============================================
VERIFY_DB_NAME="${VERIFY_DB_PREFIX}_$(date +%Y%m%d_%H%M%S)"

echo "🔧 创建临时数据库: $VERIFY_DB_NAME"
createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$VERIFY_DB_NAME"

# 确保清理临时数据库（即使验证失败）
cleanup() {
    echo ""
    echo "🧹 清理临时数据库: $VERIFY_DB_NAME"
    dropdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --if-exists "$VERIFY_DB_NAME" 2>/dev/null || true
    unset PGPASSWORD
}
trap cleanup EXIT

# ============================================
# 恢复备份到临时数据库
# ============================================
echo "🔄 恢复备份到临时数据库..."
pg_restore \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$VERIFY_DB_NAME" \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    --single-transaction \
    "$LATEST_BACKUP"

echo "✅ 恢复完成"

# ============================================
# 校验关键表行数
# ============================================
echo ""
echo "📊 校验关键表行数："

TABLES=("users" "documents" "conversations" "messages" "document_folders" "audit_logs" "qa_events")
VERIFY_FAILED=0

for table in "${TABLES[@]}"; do
    ROW_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$VERIFY_DB_NAME" -t -c "SELECT COUNT(*) FROM \"$table\";" 2>/dev/null || echo "ERROR")
    if [ "$ROW_COUNT" = "ERROR" ]; then
        echo "   ❌ $table: 表不存在或查询失败"
        VERIFY_FAILED=1
    else
        echo "   ✅ $table: $ROW_COUNT 行"
    fi
done

# ============================================
# 校验 pgvector 索引
# ============================================
echo ""
echo "🔍 校验 pgvector 扩展和索引："

HAS_VECTOR=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$VERIFY_DB_NAME" -t -c "SELECT COUNT(*) FROM pg_extension WHERE extname = 'vector';" 2>/dev/null || echo "0")
if [ "$(echo "$HAS_VECTOR" | tr -d ' ')" = "1" ]; then
    echo "   ✅ pgvector 扩展存在"
else
    echo "   ❌ pgvector 扩展缺失"
    VERIFY_FAILED=1
fi

VECTOR_INDEX_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$VERIFY_DB_NAME" -t -c "SELECT COUNT(*) FROM pg_indexes WHERE indexname LIKE '%ivfflat%' OR indexname LIKE '%hnsw%';" 2>/dev/null || echo "0")
if [ "$(echo "$VECTOR_INDEX_COUNT" | tr -d ' ')" -gt 0 ] 2>/dev/null; then
    echo "   ✅ 向量索引存在（$VECTOR_INDEX_COUNT 个）"
else
    echo "   ⚠️  向量索引未找到（可能使用默认索引）"
fi

# ============================================
# 校验 Alembic 版本
# ============================================
echo ""
echo "📋 校验 Alembic 迁移版本："
ALEMBIC_VERSION=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$VERIFY_DB_NAME" -t -c "SELECT version_num FROM alembic_version;" 2>/dev/null || echo "ERROR")
if [ "$ALEMBIC_VERSION" != "ERROR" ]; then
    echo "   ✅ 当前迁移版本: $(echo "$ALEMBIC_VERSION" | tr -d ' ')"
else
    echo "   ❌ alembic_version 表不存在"
    VERIFY_FAILED=1
fi

# ============================================
# 汇总结果
# ============================================
echo ""
echo "=========================================="
if [ "$VERIFY_FAILED" -eq 0 ]; then
    echo "🎉 备份验证通过！备份文件可正常恢复。"
    echo "   备份文件: $LATEST_BACKUP"
    echo "=========================================="
    exit 0
else
    echo "❌ 备份验证失败！请检查上述错误项。"
    echo "   备份文件: $LATEST_BACKUP"
    echo "=========================================="
    exit 1
fi
