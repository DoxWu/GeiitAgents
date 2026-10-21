# ============================================
# GeiIt企业知识库 - 后端 Dockerfile（生产版）
# ============================================
# 作用：
#     构建后端镜像，包含 FastAPI 应用、Celery Worker、Flower 监控。
#     通过 ROLE 环境变量切换启动角色（api / worker / flower）。
#
# 构建方法：
#     docker build -t kb-qa-backend ./backend
#
# 运行方法：
#     docker run -p 8000:8000 --env-file .env -e ROLE=api kb-qa-backend
#     docker run --env-file .env -e ROLE=worker kb-qa-backend
#
# 设计要点：
#     1. 多阶段构建：builder 编译依赖，runtime 只保留运行时必需文件
#     2. 依赖装到 /opt/venv（独立虚拟环境），源码在 /app
#        → docker-compose 开发环境挂载 ./backend:/app 不会覆盖依赖
#     3. 非 root 用户运行，提升安全性
# ============================================

# --------------------------------------------
# 阶段 1：构建阶段（编译并安装 Python 依赖到虚拟环境）
# --------------------------------------------
FROM python:3.11-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# 安装构建依赖
# 作用：psycopg 编译需要 libpq-dev，部分包需要 build-essential
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

# 创建虚拟环境
# 作用：将所有 Python 依赖隔离在 /opt/venv，便于多阶段整体复制
RUN python -m venv /opt/venv
# 激活虚拟环境（后续 pip 安装都进 venv）
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# 先单独复制依赖文件
# 作用：利用 Docker 层缓存，代码变更不会重新安装依赖
COPY requirements.txt .
COPY requirements-local-ml.txt .

# 可选：本地 ML 依赖开关
# 作用：默认不安装 sentence-transformers（节省 ~800MB torch），
#       需要可选服务端 Embedding provider / CrossEncoder 重排序依赖时启用；
#       本地 provider 仍须单独配置开关并校验向量空间兼容性。
# 启用方式：docker build --build-arg INSTALL_LOCAL_ML=true -t kb-qa-backend .
ARG INSTALL_LOCAL_ML=false

# 升级 pip 并安装依赖到虚拟环境
# 核心依赖始终安装；本地 ML 依赖按 INSTALL_LOCAL_ML 开关条件安装
RUN /opt/venv/bin/python -m pip install --upgrade pip && \
    /opt/venv/bin/python -m pip install -r requirements.txt && \
    if [ "${INSTALL_LOCAL_ML}" = "true" ]; then \
        /opt/venv/bin/python -m pip install -r requirements-local-ml.txt; \
    fi && \
    rm -rf /opt/venv/lib/python3.11/site-packages/pip \
        /opt/venv/lib/python3.11/site-packages/pip-*.dist-info \
        /opt/venv/lib/python3.11/site-packages/pip-*.data \
        /opt/venv/bin/pip /opt/venv/bin/pip3 /opt/venv/bin/pip3.11


# --------------------------------------------
# 阶段 2：运行阶段（最小化镜像）
# --------------------------------------------
FROM python:3.11-slim AS runtime

ARG POSTGRES_CLIENT_MAJOR=16

LABEL maintainer="kb-qa-system"
LABEL description="GeiIt企业知识库后端（FastAPI + Celery）"

# 运行时环境变量
# PATH 包含 venv，使 uvicorn/celery/alembic 命令直接可用
# 任务6：新增 TZ=Asia/Shanghai，使容器内时间与北京时间一致
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PATH="/opt/venv/bin:$PATH" \
    ROLE=api \
    TZ=Asia/Shanghai

# 安装运行时系统依赖并移除最终镜像中不需要的 Python 安装工具
# 作用：
#   - libpq5: psycopg 运行时库
#   - tesseract-ocr + chi-sim + eng: OCR 中英文识别
#   - libglib2.0-0: Pillow 运行时依赖
#   - curl: 健康检查
#   - tzdata: 时区数据（任务6），使 TZ 环境变量生效
# 轻量化优化：移除了 libmagic1（python-magic 已从依赖中删除）、
#             libsm6/libxrender1/libxext6/libgl1（opencv 已从依赖中删除）
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends \
    ca-certificates \
    libpq5 \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
    tesseract-ocr-eng \
    libglib2.0-0 \
    curl \
    tzdata \
    util-linux \
    && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && rm -rf /usr/local/lib/python3.11/site-packages/pip \
        /usr/local/lib/python3.11/site-packages/pip-*.dist-info \
        /usr/local/lib/python3.11/site-packages/pip-*.data \
        /usr/local/lib/python3.11/site-packages/setuptools \
        /usr/local/lib/python3.11/site-packages/setuptools-*.dist-info \
        /usr/local/lib/python3.11/site-packages/wheel \
        /usr/local/lib/python3.11/site-packages/wheel-*.dist-info \
        /usr/local/lib/python3.11/ensurepip \
        /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.11 \
    && rm -rf /var/lib/apt/lists/*

# Use the same client major as the default Compose/CI PostgreSQL server.
# A newer pg_dump can emit settings that older restore targets cannot accept.
# Other deployments can select their server major with POSTGRES_CLIENT_MAJOR.
RUN case "${POSTGRES_CLIENT_MAJOR}" in ''|*[!0-9]*) exit 1 ;; esac && \
    curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 60 \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        --output /usr/share/keyrings/postgresql.asc && \
    . /etc/os-release && \
    echo "deb [signed-by=/usr/share/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
        > /etc/apt/sources.list.d/postgresql.list && \
    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update && \
    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends \
        "postgresql-client-${POSTGRES_CLIENT_MAJOR}" && \
    pg_dump --version && pg_restore --version && \
    rm -rf /var/lib/apt/lists/*

# 创建非 root 用户（在 COPY 之前，以便使用 --chown 直接设置属主）
# 修复 P-05：此前先 COPY 再 chown -R /app /opt/venv，chown 会复制整个 venv 层（~6GB）
#            改为 COPY --chown 在复制时直接设置属主，消除冗余层，镜像瘦身约 6GB
RUN groupadd -r kbapp && useradd -r -g kbapp -d /app -s /sbin/nologin kbapp

# 从构建阶段复制虚拟环境（直接设置属主，避免后续 chown 层）
COPY --chown=kbapp:kbapp --from=builder /opt/venv /opt/venv

WORKDIR /app

# 复制应用源码（直接设置属主）
# 作用：源码独立放在 /app，docker-compose 开发挂载 ./backend:/app 不影响 /opt/venv
COPY --chown=kbapp:kbapp . /app/

# 赋予入口脚本执行权限 + 创建运行时目录
# 注意：Windows 宿主 COPY 不保留执行位，需显式 chmod
# uploads/data 目录权限修复：
#   - .dockerignore 排除了 uploads/ 和 data/，镜像中默认无这些目录
#   - docker-compose 用命名卷挂载时，若镜像中无此目录，
#     Docker 会创建 root:root 755 空目录，导致非 root 用户 kbapp 无法写入（HTTP 500）
#   - 显式创建并 chown 给 kbapp，命名卷首次挂载时继承此权限
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh && \
    mkdir -p /app/uploads /app/data && \
    chown -R kbapp:kbapp /app/uploads /app/data
# 注意：不在此处切换 USER kbapp。
# K8s/Sealos 的存储卷（PVC）在运行时才挂载，会覆盖镜像中的 /app/uploads、/app/data
# 目录权限（变为 root:root）。因此入口脚本 entrypoint.sh 以 root 启动，
# 在运行时 chown 目录后再通过 setpriv 降权为 kbapp 运行应用。


# 暴露端口：FastAPI 8000，Flower 5555
EXPOSE 8000 5555

# 健康检查不在镜像层定义（不同角色探活方式不同）
# 由 docker-compose 或 railway.json 按服务单独配置
# 启动入口：根据 ROLE 执行不同角色（api/worker/flower）
ENTRYPOINT ["/app/entrypoint.sh"]
