#!/bin/bash
# ============================================
# GeiIt企业知识库 - 容器入口脚本
# ============================================
# 作用：
#     根据 ROLE 环境变量启动不同的服务角色：
#     - ROLE=api:    运行数据库迁移，启动 FastAPI（uvicorn）
#     - ROLE=worker: 启动 Celery Worker（处理异步文档处理任务）
#     - ROLE=flower: 启动 Flower（Celery 任务监控面板）
#
# 使用方式：
#     docker run -e ROLE=api kb-qa-backend
#     docker run -e ROLE=worker kb-qa-backend
#     docker run -e ROLE=flower -p 5555:5555 kb-qa-backend
# ============================================

set -e  # 任何命令失败立即退出

# --------------------------------------------
# 存储卷权限修复（K8s / Sealos 部署）
# --------------------------------------------
# 问题：K8s 存储卷（PVC）挂载到 /app/uploads、/app/data 时，挂载点属主为
#       root:root（0755），非 root 用户 kbapp 无法写入，导致文档上传报
#       [Errno 13] Permission denied。
# 修复：容器以 root 启动时先 chown 这些目录给 kbapp，再降权为 kbapp 重新运行。
#       本地 docker-compose 的命名卷已继承镜像目录权限，此处的 chown 为无害操作。
if [ "$(id -u)" = "0" ]; then
    echo "🔧 修复上传/数据目录权限（/app/uploads、/app/data）..."
    mkdir -p /app/uploads /app/data
    chown -R kbapp:kbapp /app/uploads /app/data
    echo "🔻 降权为 kbapp 用户重新启动..."
    KBAPP_UID="$(id -u kbapp)"
    KBAPP_GID="$(id -g kbapp)"
    exec setpriv --reuid="${KBAPP_UID}" --regid="${KBAPP_GID}" --clear-groups -- "$0"
fi

# 默认角色
ROLE="${ROLE:-api}"

echo "=========================================="
echo "  GeiIt企业知识库 - 启动中"
echo "  角色: ${ROLE}"
echo "  环境: ${ENVIRONMENT:-development}"
echo "=========================================="

# --------------------------------------------
# 数据库迁移函数
# 作用：在启动 API 前应用最新的 Alembic 迁移，保证表结构一致
# 说明：
#   - 所有平台启动时检查数据库，默认自动迁移并重试连接
#   - ROLE=ops 独立运行异地备份与故障告警，无需启动 API
#   - API 迁移使用数据库咨询锁，多个副本安全串行检查
# --------------------------------------------
run_migrations() {
    echo "Checking database availability, backup recovery and migrations..."
    python -m app.ops.cli startup
}

# --------------------------------------------
# 启动 FastAPI API 服务 + Celery Worker（同容器模式）
# 作用：Railway 部署时 API 和 Worker 不共享文件系统，
#       将两者放在同一容器中解决文件路径不一致问题。
#       通过 EMBED_WORKER=true 环境变量启用。
# --------------------------------------------
start_api_with_worker() {
    run_migrations

    WORKERS="${UVICORN_WORKERS:-1}"

    echo "🔧 启动 Celery Worker（后台）..."
    celery -A app.core.celery_app:celery_app worker \
        --loglevel=info \
        --concurrency="${CELERY_WORKER_CONCURRENCY:-2}" \
        --max-tasks-per-child="${CELERY_MAX_TASKS_PER_CHILD:-100}" &
    WORKER_PID=$!

    mkdir -p "$(dirname "${CELERY_BEAT_SCHEDULE_FILE:-/app/data/celerybeat-schedule}")"
    echo "🕒 启动 Celery Beat（持久化调度状态）..."
    celery -A app.core.celery_app:celery_app beat \
        --loglevel=info \
        --schedule="${CELERY_BEAT_SCHEDULE_FILE:-/app/data/celerybeat-schedule}" &
    BEAT_PID=$!

    echo "🚀 启动 FastAPI 服务（${WORKERS} workers）..."
    uvicorn app.main:app \
        --host 0.0.0.0 \
        --port "${PORT:-8000}" \
        --workers "${WORKERS}" \
        --proxy-headers \
        --forwarded-allow-ips="${FORWARDED_ALLOW_IPS:-${TRUSTED_PROXIES:-127.0.0.1}}" &
    API_PID=$!
    supervise_api_worker
}

stop_api_worker_children() {
    trap - INT TERM
    for child_pid in "${WORKER_PID:-}" "${BEAT_PID:-}" "${API_PID:-}"; do
        if [ -n "$child_pid" ]; then kill -TERM "$child_pid" 2>/dev/null || true; fi
    done
    for child_pid in "${WORKER_PID:-}" "${BEAT_PID:-}" "${API_PID:-}"; do
        if [ -n "$child_pid" ]; then wait "$child_pid" 2>/dev/null || true; fi
    done
}

supervise_api_worker() {
    trap 'stop_api_worker_children; exit 143' TERM
    trap 'stop_api_worker_children; exit 130' INT
    set +e
    wait -n "$WORKER_PID" "$BEAT_PID" "$API_PID"
    CHILD_STATUS=$?
    set -e
    echo "A required worker/scheduler process exited; stopping the API container."
    kill -TERM "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
    stop_api_worker_children
    return "$CHILD_STATUS"
}

# --------------------------------------------
# 启动 FastAPI API 服务
# --------------------------------------------
start_api() {
    run_migrations

    # worker 数量：生产环境根据 CPU 核心数，开发环境 1 个
    WORKERS="${UVICORN_WORKERS:-1}"

    echo "🚀 启动 FastAPI 服务（${WORKERS} workers）..."
    exec uvicorn app.main:app \
        --host 0.0.0.0 \
        --port "${PORT:-8000}" \
        --workers "${WORKERS}" \
        --proxy-headers \
        --forwarded-allow-ips="${FORWARDED_ALLOW_IPS:-${TRUSTED_PROXIES:-127.0.0.1}}"
}

# --------------------------------------------
# 启动 Celery Worker
# --------------------------------------------
start_worker() {
    echo "🔧 启动 Celery Worker..."

    # 启动简单的健康检查 HTTP 服务（后台运行）
    # Railway 健康检查需要 HTTP 端点，Worker 本身没有，所以启动一个轻量的 HTTP 服务
    python -c "
import http.server
import socketserver
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{\"status\": \"healthy\", \"role\": \"worker\"}')
    def log_message(self, format, *args):
        pass  # 静默日志
with socketserver.TCPServer(('', 8000), Handler) as httpd:
    httpd.serve_forever()
" &
    HEALTH_PID=$!

    # 启动 Celery Worker
    # 注意：使用显式 :celery_app 语法指定应用对象，避免 Celery 自动查找歧义
    exec celery -A app.core.celery_app:celery_app worker \
        --loglevel=info \
        --concurrency="${CELERY_WORKER_CONCURRENCY:-2}" \
        --max-tasks-per-child="${CELERY_MAX_TASKS_PER_CHILD:-100}"
}

# --------------------------------------------
# 启动 Flower 监控
# --------------------------------------------
start_flower() {
    echo "🌸 启动 Flower 监控面板..."
    exec celery -A app.core.celery_app:celery_app flower \
        --port="${FLOWER_PORT:-5555}" \
        --host=0.0.0.0
}

# 根据角色分发
case "${ROLE}" in
    api)
        start_api
        ;;
    api+worker)
        start_api_with_worker
        ;;
    worker)
        start_worker
        ;;
    beat)
        mkdir -p "$(dirname "${CELERY_BEAT_SCHEDULE_FILE:-/app/data/celerybeat-schedule}")"
        exec celery -A app.core.celery_app:celery_app beat \
            --loglevel=info \
            --schedule="${CELERY_BEAT_SCHEDULE_FILE:-/app/data/celerybeat-schedule}"
        ;;
    flower)
        start_flower
        ;;
    ops)
        exec python -m app.ops.cli monitor
        ;;
    *)
        echo "❌ 未知角色: ${ROLE}，可选值: api / api+worker / worker / beat / flower / ops"
        exit 1
        ;;
esac
