# ============================================
# GeiIt企业知识库 - 前端 Dockerfile（生产版）
# ============================================
# 反代模式：
#   前端通过同源 /api/v1/... 访问后端，nginx 反向代理转发。
#   部署时需在 Railway 添加环境变量 BACKEND_URL。
# ============================================

# 阶段 1：构建
FROM node:20-slim AS builder

ENV NPM_CONFIG_LOGLEVEL=warn

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --legacy-peer-deps --no-cache || npm install --legacy-peer-deps --no-cache

COPY . .

# VITE_API_BASE_URL 默认 /api/v1（同源，由 nginx 转发）
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ARG VITE_APP_TITLE=GeiIt企业知识库
ENV VITE_APP_TITLE=${VITE_APP_TITLE}

RUN npm run build

# 阶段 2：运行
FROM nginx:1.30-alpine3.24 AS runtime

LABEL maintainer="kb-qa-system"

# curl（健康检查）+ gettext（envsubst 变量替换）
RUN apk upgrade --no-cache && apk add --no-cache curl gettext jq

# nginx 配置复制为模板（启动时由 start.sh 通过 envsubst 替换变量）
COPY nginx.conf /etc/nginx/conf.d/default.conf.template
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY start.sh /app/start.sh

RUN chmod +x /app/start.sh && \
    sed -i 's/worker_processes.*;/worker_processes 1;/' /etc/nginx/nginx.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost/ || exit 1

# 通过 start.sh 启动（处理 PORT 替换和 BACKEND_URL 注入）
CMD ["/app/start.sh"]
