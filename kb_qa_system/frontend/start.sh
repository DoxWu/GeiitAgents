#!/bin/sh
# ============================================
# GeiIt企业知识库 - 前端启动脚本
# ============================================
# 作用：
#   1. 用 envsubst 将 BACKEND_URL 替换到 nginx 配置模板
#   2. 动态设置 nginx 监听端口（兼容 Railway 的 $PORT）
#   3. 启动 nginx
# ============================================

PORT=${PORT:-80}
BACKEND_URL=${BACKEND_URL:-https://localhost:8000}

# Only public, non-secret deployment details may be exposed to browser clients.
{
    printf 'window.__KB_PUBLIC_CONFIG__ = '
    jq -c -n \
      --arg contactEmail "${PUBLIC_CONTACT_EMAIL:-}" \
      --arg operatorName "${PUBLIC_OPERATOR_NAME:-}" \
      --arg operatorLocation "${PUBLIC_OPERATOR_LOCATION:-}" \
      --arg processingRegion "${PUBLIC_DATA_PROCESSING_REGION:-}" \
      --arg retentionNotice "${PUBLIC_DATA_RETENTION_NOTICE:-}" \
      --arg crossBorderNotice "${PUBLIC_CROSS_BORDER_NOTICE:-}" \
      --arg thirdPartyNotice "${PUBLIC_THIRD_PARTY_PROCESSING_NOTICE:-}" \
      '{contactEmail:$contactEmail,operatorName:$operatorName,operatorLocation:$operatorLocation,processingRegion:$processingRegion,retentionNotice:$retentionNotice,crossBorderNotice:$crossBorderNotice,thirdPartyNotice:$thirdPartyNotice}'
    printf ';\n'
} > /usr/share/nginx/html/runtime-config.js

# 1. envsubst 替换 nginx 模板中的 ${BACKEND_URL}
# 白名单参数避免误替换 nginx 内置变量（如 $host, $remote_addr）
envsubst '${BACKEND_URL}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

# 2. 替换监听端口
sed -i "s/listen 80;/listen $PORT;/" /etc/nginx/conf.d/default.conf

echo "nginx listening on port $PORT, backend proxy configured"

# 3. 启动 nginx
exec nginx -g 'daemon off;'
