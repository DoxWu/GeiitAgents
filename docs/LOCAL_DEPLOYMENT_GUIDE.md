# GeiIt企业知识库 — 本地部署指南

> 本指南详细说明如何在本地环境部署 GeiIt企业知识库，进行开发、测试和功能验证。
>
> **推荐方式**：Docker Compose 一键启动（约 5 分钟）
> **手动方式**：适合开发调试（约 15 分钟）

---

## 目录

1. [环境要求](#1-环境要求)
2. [方式一：Docker Compose 一键启动（推荐）](#2-方式一docker-compose-一键启动推荐)
3. [方式二：手动部署](#3-方式二手动部署)
4. [配置详解](#4-配置详解)
5. [数据库初始化](#5-数据库初始化)
6. [创建超级管理员](#6-创建超级管理员)
7. [启动服务](#7-启动服务)
8. [验证检查](#8-验证检查)
9. [监控栈（可选）](#9-监控栈可选)
10. [性能调优](#10-性能调优)
11. [常见问题排查](#11-常见问题排查)

---

## 1. 环境要求

### 1.1 硬件要求

| 资源 | 最低 | 推荐 |
|------|------|------|
| CPU | 2 核 | 4 核+ |
| 内存 | 4 GB | 8 GB+ |
| 磁盘 | 10 GB | 20 GB+ |

### 1.2 软件要求

#### Docker Compose 方式（推荐）

| 软件 | 版本要求 | 安装方式 |
|------|----------|----------|
| Docker | 24.0+ | [docker.com](https://docs.docker.com/get-docker/) |
| Docker Compose | v2.20+ | Docker Desktop 自带或 `pip install docker-compose` |
| Git | 2.40+ | [git-scm.com](https://git-scm.com/) |

#### 手动部署方式

| 软件 | 版本要求 | 说明 |
|------|----------|------|
| Python | 3.11+ | 推荐 3.11.x（与 Dockerfile 一致） |
| Node.js | 20+ | 推荐 20.x LTS |
| PostgreSQL | 16+ | 需安装 pgvector 扩展 |
| Redis | 7+ | 用于缓存、限流、任务队列 |
| Git | 2.40+ | 代码克隆 |

### 1.3 外部服务

| 服务 | 用途 | 获取方式 |
|------|------|----------|
| LLM API Key | RAG 问答的大模型调用 | OpenAI / 智谱 AI / 通义千问（任选） |
| Resend API Key | 注册审批邮件发送（可选） | [resend.com/api-keys](https://resend.com/api-keys) |

> **提示**：LLM API Key 为必需（问答功能依赖）。Resend API Key 为可选（不配置时邮件功能降级为仅记录日志，不影响核心功能）。

---

## 2. 方式一：Docker Compose 一键启动（推荐）

### 2.1 克隆代码

```bash
git clone <仓库地址>
cd 企业知识库问答系统/kb_qa_system
```

### 2.2 配置环境变量

```bash
# 复制后端环境变量模板
cp backend/.env.example backend/.env

# 复制前端环境变量模板
cp frontend/.env.example frontend/.env.local
```

编辑 `backend/.env`，填入以下必需配置（详见 [配置详解](#4-配置详解)）：

```env
# 必填：JWT 签名密钥（生成方法见 2.3）
SECRET_KEY=你的生成的密钥

# 按部署者选定的阿里云兼容端点/模型填写
ALIYUN_API_KEY=由部署密钥管理器注入
ALIYUN_API_BASE=按地域和账号填写
ALIYUN_LLM_MODEL=按控制台填写
ALIYUN_EMBEDDING_MODEL=按控制台填写
EMBEDDING_DIMENSION=与模型输出和数据库向量列一致
# DeepSeek 仅作为文本 LLM 备用
DEEPSEEK_API_KEY=由部署密钥管理器注入
DEEPSEEK_API_BASE=https://api.deepseek.com/v1
DEEPSEEK_LLM_MODEL=按控制台填写
DEEPSEEK_LLM_ENABLED=true

# 可选：邮件（不填则邮件功能降级）
EMAIL_ENABLED=False
```

### 2.3 生成密钥

```bash
# 生成 SECRET_KEY（JWT 签名密钥）
python -c "import secrets; print(secrets.token_urlsafe(32))"
# 输出示例：dG9wLXNlY3JldC1rZXktZm9yLXByb2R1Y3Rpb24...
# 将输出填入 backend/.env 的 SECRET_KEY
```

### 2.4 启动所有服务

```bash
# 在 kb_qa_system 目录下执行
docker-compose up -d

# 查看启动日志
docker-compose logs -f api

# 等待出现以下日志表示启动成功：
# ✅ 配置校验通过
# ✅ 数据库迁移完成
# 🎉 应用启动成功！环境: development
```

### 2.5 创建超级管理员

首次部署需要创建超级管理员账号（详见 [创建超级管理员](#6-创建超级管理员)）：

```bash
# 进入后端容器执行
docker-compose exec api python -m scripts.create_superuser
# 按提示输入用户名、邮箱、密码
```

### 2.6 访问服务

| 服务 | 地址 | 说明 |
|------|------|------|
| 前端 | http://localhost:5173 | Vite 开发服务器（Docker 方式下前端需单独启动，见 2.7） |
| 后端 API | http://localhost:8000 | FastAPI 服务 |
| API 文档 | http://localhost:8000/docs | Swagger UI（仅开发环境） |
| Flower 监控 | http://localhost:5555 | Celery 任务监控面板 |

> **注意**：Docker Compose 默认启动后端服务栈（PostgreSQL + Redis + API + Worker + Flower），前端需单独启动用于开发调试。

### 2.7 启动前端开发服务器（可选）

如果需要前端页面进行交互测试：

```bash
cd frontend
npm install --legacy-peer-deps
npm run dev
# 前端运行在 http://localhost:5173
```

### 2.8 停止服务

```bash
# 停止所有容器（数据保留）
docker-compose down

# 停止并清空所有数据（慎用！）
docker-compose down -v
```

---

## 3. 方式二：手动部署

适合开发调试场景，可单独重启某个服务。

### 3.1 安装 PostgreSQL + pgvector

#### Windows

```bash
# 1. 安装 PostgreSQL 16（从 https://www.postgresql.org/download/windows/ 下载）
# 2. 安装 pgvector 扩展
#    方法一：从 https://github.com/pgvector/pgvector/releases 下载预编译包
#    方法二：使用 Docker 仅运行数据库：
#           docker run -d --name kb-pg -p 5432:5432 \
#             -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
#             -e POSTGRES_DB=kb_qa \
#             pgvector/pgvector:pg16
```

#### macOS

```bash
brew install postgresql@16
# pgvector
brew install pgvector
# 启动 PostgreSQL
brew services start postgresql@16
# 创建数据库
createdb kb_qa
# 安装扩展
psql -d kb_qa -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 3.2 安装 Redis

#### Windows

```bash
# Windows 无官方 Redis，推荐用 Docker 运行
docker run -d --name kb-redis -p 6379:6379 \
  redis:7-alpine redis-server --appendonly yes
```

#### macOS

```bash
brew install redis
brew services start redis
```

### 3.3 后端部署

```bash
cd kb_qa_system/backend

# 1. 创建虚拟环境
python -m venv venv

# Windows 激活
venv\Scripts\activate
# macOS/Linux 激活
source venv/bin/activate

# 2. 安装依赖
pip install -r requirements.txt

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 SECRET_KEY、OPENAI_API_KEY 等（见配置详解）
# 注意：DATABASE_URL 和 REDIS_URL 改为 localhost
#   DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/kb_qa
#   REDIS_URL=redis://localhost:6379/0
#   CELERY_BROKER_URL=redis://localhost:6379/1
#   CELERY_RESULT_BACKEND=redis://localhost:6379/2

# 4. 执行数据库迁移
alembic upgrade head

# 5. 启动 FastAPI（开发模式，自动重载）
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 3.4 启动 Celery Worker（新终端）

```bash
cd kb_qa_system/backend
# 激活虚拟环境
venv\Scripts\activate  # Windows
source venv/bin/activate  # macOS/Linux

# 启动 Worker（处理文档解析、向量化、邮件发送等异步任务）
celery -A app.core.celery_app:celery_app worker --loglevel=info --concurrency=2
```

### 3.5 前端部署（新终端）

```bash
cd kb_qa_system/frontend

# 1. 安装依赖
npm install --legacy-peer-deps

# 2. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local，确认 API 地址
#   VITE_API_BASE_URL=http://localhost:8000/api/v1

# 3. 启动开发服务器
npm run dev
# 前端运行在 http://localhost:5173
```

---

## 4. 配置详解

### 4.1 后端配置（backend/.env）

#### 必填项

| 变量 | 说明 | 示例 |
|------|------|------|
| `SECRET_KEY` | JWT 签名密钥（≥32字符） | `secrets.token_urlsafe(32)` 生成 |
| `OPENAI_API_KEY` | LLM API 密钥 | `sk-xxxxxxxx` |
| `OPENAI_API_BASE` | LLM API 地址 | `https://api.openai.com/v1` |
| `LLM_MODEL_NAME` | 问答模型 | `gpt-3.5-turbo` |
| `EMBEDDING_MODEL_NAME` | 向量化模型 | `text-embedding-ada-002` |
| `DATABASE_URL` | 数据库连接 | `postgresql+psycopg://postgres:postgres@localhost:5432/kb_qa` |
| `REDIS_URL` | Redis 连接 | `redis://localhost:6379/0` |

#### 邮件配置（可选）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EMAIL_ENABLED` | 是否启用邮件发送 | `False`（开发环境） |
| `SMTP_HOST` | Resend SMTP 主机 | `smtp.resend.com` |
| `SMTP_PORT` | SMTP 端口 | `465`（SSL 隐式 TLS） |
| `SMTP_USER` | SMTP 用户名 | `resend` |
| `SMTP_PASSWORD` | Resend API Key | `re_xxxxxxxxxxxx` |
| `SMTP_USE_TLS` | 使用 SSL TLS | `True` |
| `EMAIL_FROM` | 发件人地址 | `GeiIt企业知识库 <onboarding@resend.dev>` |
| `ADMIN_NOTIFY_EMAIL` | 管理员通知邮箱 | `admin@example.com` |
| `FRONTEND_BASE_URL` | 前端地址（拼接邮件链接） | `http://localhost:5173` |
| `PASSWORD_TOKEN_EXPIRE_HOURS` | 密码设置 Token 有效期 | `24` |

> **Resend 开发提示**：使用 Resend 默认域 `onboarding@resend.dev` 时，邮件只能发送到 `ADMIN_NOTIFY_EMAIL` 指定的邮箱。要发送给任意用户，需在 Resend 验证自己的域名。

#### CORS 配置

| 变量 | 说明 | 开发环境默认值 |
|------|------|----------------|
| `CORS_ORIGINS` | 允许的前端域名 | `["http://localhost:3000","http://localhost:5173"]` |

> **生产环境注意**：必须改为精确的前端域名，禁止使用通配符 `*`。

#### 启动迁移控制（可选）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MIGRATE_ON_STARTUP` | API 容器启动时是否执行 `alembic upgrade head` | `true` |

- **本地开发**：保持默认 `true`，API 启动时自动迁移，无需手动执行 `alembic upgrade head`
- **已手动迁移**：如需跳过启动迁移（如调试启动流程），设为 `false`
- **Railway 生产环境**：因 `railway.json` 已配置 `releaseCommand` 执行迁移，应设为 `false` 避免重复执行

> 📖 详见 [entrypoint.sh](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/kb_qa_system/backend/entrypoint.sh) 中 `run_migrations()` 函数的实现。

#### 多 API 降级配置（可选）

系统支持 LLM 和 Embedding 的多级降级链路，当主 API 不可用时自动切换备用提供者。配置文件位于 [providers.yaml](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/kb_qa_system/backend/app/core/model_provider/providers.yaml)，环境变量优先级高于 YAML 默认值。

**LLM 降级链路**：阿里云 OpenAI 兼容主端点 → DeepSeek OpenAI 兼容文本备用端点。服务端本地 Ollama 默认为关闭。

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek 文本 LLM 备用 Key | 由部署者配置 |
| `DEEPSEEK_API_BASE` | DeepSeek OpenAI 兼容 API 地址 | `https://api.deepseek.com/v1` |
| `DEEPSEEK_LLM_MODEL` | DeepSeek 文本模型名 | 由部署者配置 |
| `DEEPSEEK_LLM_ENABLED` | 是否启用 DeepSeek 文本备用 | `true` |
| `LOCAL_LLM_ENABLED` | 是否启用本地 LLM 兜底（Ollama） | `false` |
| `LOCAL_LLM_MODEL` | 本地 LLM 模型名 | `qwen2.5:7b` |
| `LOCAL_LLM_BASE` | Ollama API 地址 | `http://localhost:11434/v1` |

**Embedding 路径**：阿里云 OpenAI 兼容主端点；云端和服务端本地备用默认关闭。DeepSeek 端点不会用于 Embedding。

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EMBEDDING_FALLBACK_ENABLED` | 显式启用独立且向量空间兼容的 Embedding 备用端点 | `false` |
| `EMBEDDING_FALLBACK_API_KEY` | 独立云端备用 Embedding Key | （空） |
| `EMBEDDING_FALLBACK_API_BASE` | 云端备用 Embedding 的 API 地址 | （空） |
| `EMBEDDING_FALLBACK_MODEL_NAME` | 云端备用 Embedding 模型名 | （复用 `EMBEDDING_MODEL_NAME`） |
| `LOCAL_EMBEDDING_ENABLED` | 是否启用服务器端 HuggingFace Embedding provider（与客户端本地 E5 分开；默认关闭） | `false` |

> 变更 Embedding 模型或维度前，先确认数据库 `pgvector` schema 与既有向量的处理方案；仅仅输出维度相同不表示两个模型的向量可以混用。

### 4.2 前端配置（frontend/.env.local）

| 变量 | 说明 | 开发环境 |
|------|------|----------|
| `VITE_API_BASE_URL` | 后端 API 地址 | `http://localhost:8000/api/v1` |
| `VITE_APP_TITLE` | 应用标题 | `GeiIt企业知识库` |

---

## 5. 数据库初始化

### 5.1 Docker Compose 方式

Docker Compose 启动时自动完成以下操作：
1. PostgreSQL 容器启动，执行 `init-db.sql` 创建 pgvector 扩展
2. API 容器启动，`entrypoint.sh` 执行 `alembic upgrade head` 创建所有表和索引

无需手动操作。

### 5.2 手动方式

```bash
# 1. 创建数据库（如果尚未创建）
createdb kb_qa

# 2. 安装 pgvector 扩展
psql -d kb_qa -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 3. 执行数据库迁移（创建所有表和索引）
cd kb_qa_system/backend
alembic upgrade head

# 验证迁移状态
alembic current
# 应输出: 20260710_0003_add_registration_and_email_logs (head)
```

### 5.3 迁移文件说明

| 迁移 | 内容 |
|------|------|
| `20260705_0001_initial` | 创建所有基础表（users, documents, document_chunks, conversations, messages, qa_events）+ pgvector 扩展 + IVFFlat 向量索引 + GIN 全文索引 |
| `20260708_0002_add_document_visibility` | 添加文档可见性字段（visibility） |
| `20260710_0003_add_registration_and_email_logs` | 创建注册申请表 + 邮件日志表 |

---

## 6. 创建超级管理员

首次部署后，需要创建超级管理员账号用于审批注册申请和管理公共文档库。

### 6.1 交互式创建（推荐）

```bash
# Docker Compose 方式
docker-compose exec api python -m scripts.create_superuser

# 手动方式
cd kb_qa_system/backend
python -m scripts.create_superuser
```

按提示输入：
```
请输入管理员用户名: admin
请输入管理员邮箱: admin@example.com
请输入管理员密码: ********
✅ 超级管理员创建成功！
```

### 6.2 命令行参数创建

```bash
python -m scripts.create_superuser --username admin --email admin@example.com --password Secure123
```

### 6.3 环境变量创建

```bash
# 在 .env 中设置
SUPERUSER_USERNAME=admin
SUPERUSER_EMAIL=admin@example.com
SUPERUSER_PASSWORD=Secure123

# 执行创建
python -m scripts.create_superuser

# 创建后务必删除 SUPERUSER_PASSWORD，避免密码暴露
```

### 6.4 安全要求

- 密码 ≥8 字符，必须包含字母和数字
- 脚本幂等：已存在的管理员会提示跳过或升级
- 密码使用 bcrypt 哈希存储

> 💡 **登录说明**：系统登录端点同时支持**用户名**和**邮箱**登录。前端登录表单虽以邮箱字段呈现，但后端查询条件为 `User.username == input OR User.email == input`，因此创建管理员后既可用 `admin` 也可用 `admin@example.com` 登录。

---

## 7. 启动服务

### 7.1 Docker Compose 方式启动顺序

```bash
# 默认启动（不含 Flower 监控，轻量级）
docker-compose up -d

# 含 Flower 监控面板
docker-compose --profile monitoring up -d
```

自动启动顺序：
1. **PostgreSQL** — 等待健康检查通过
2. **Redis** — 等待健康检查通过
3. **API** — 执行数据库迁移 → 启动 FastAPI
4. **Worker** — 等 API 健康后启动 Celery Worker
5. **Flower**（仅 `--profile monitoring`）— 启动任务监控面板

> 💡 **轻量化优化**：Flower 已改为按需启动（profile），默认不消耗资源。需要监控时加 `--profile monitoring` 参数。

> 💡 **本地 ML 依赖**：默认 Docker 镜像不安装 `sentence-transformers`（节省约 800MB torch），服务器本地 Embedding provider 默认关闭。它与桌面客户端按需下载的 `Xenova/multilingual-e5-small` 是两套独立配置；只有先确认服务端模型输出维度和现有向量列/索引兼容，再显式启用时才安装：
> ```bash
> # 在 kb_qa_system/.env 或环境变量中设置
> INSTALL_LOCAL_ML=true
> LOCAL_EMBEDDING_ENABLED=true
> docker-compose build --no-cache api worker
> ```

### 7.2 手动方式启动顺序

必须按以下顺序启动（需要 3 个终端）：

**终端 1 — 后端 API**：
```bash
cd kb_qa_system/backend
venv\Scripts\activate  # Windows
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**终端 2 — Celery Worker**：
```bash
cd kb_qa_system/backend
venv\Scripts\activate  # Windows
celery -A app.core.celery_app:celery_app worker --loglevel=info --concurrency=2
```

**终端 3 — 前端**：
```bash
cd kb_qa_system/frontend
npm run dev
```

### 7.3 启动 Flower 监控（可选）

```bash
# Docker Compose 方式已自动启动
# 手动方式：
cd kb_qa_system/backend
celery -A app.core.celery_app:celery_app flower --port=5555 --host=0.0.0.0
```

访问 http://localhost:5555 查看任务监控面板。

---

## 8. 验证检查

### 8.1 健康检查

```bash
# 后端健康检查（应返回 status: "healthy"）
curl http://localhost:8000/health
```

预期响应：
```json
{
  "status": "healthy",
  "service": "GeiIt企业知识库",
  "checks": {
    "database": {"status": "healthy", "latency_ms": 2},
    "redis": {"status": "healthy", "latency_ms": 1}
  }
}
```

### 8.2 API 文档

访问 http://localhost:8000/docs 查看 Swagger UI，确认所有 API 端点正常加载。

### 8.3 前端页面

访问 http://localhost:5173，确认：
- ✅ 登录页面正常加载
- ✅ 注册申请页面可访问
- ✅ 输入超级管理员账号可登录

### 8.4 注册流程验证

1. 在前端点击"注册申请"
2. 填写邮箱和用户名，提交申请
3. 超级管理员登录 → 访问 `/admin/applications` → 审批申请
4. 查看后端日志，确认邮件任务被触发（EMAIL_ENABLED=False 时仅记日志）

### 8.5 文档上传验证

1. 登录后进入文档管理页面
2. 上传一个 PDF/Markdown/TXT 文件
3. 在 Flower 面板观察文档处理任务
4. 文档状态变为 `completed` 后，在聊天页面提问验证 RAG 问答

### 8.6 运行测试

```bash
# 后端测试
cd kb_qa_system/backend
pytest
# 预期：约 390+ passed（具体数量随版本更新，截至 2026-07-12 为 396 passed）

# 前端测试
cd kb_qa_system/frontend
npx vitest run
# 预期：约 510+ passed（具体数量随版本更新，截至 2026-07-12 为 515 passed）

# 前端类型检查
npx tsc --noEmit
# 预期：0 errors

# 前端构建
npx vite build
# 预期：构建成功
```

---

## 9. 监控栈（可选）

### 9.1 启动 Prometheus + Grafana

```bash
# 在 kb_qa_system 目录下执行（需主服务已启动）
docker-compose -f docker-compose.yml -f monitoring/docker-compose.monitoring.yml up -d
```

### 9.2 访问监控面板

| 服务 | 地址 | 账号 |
|------|------|------|
| Prometheus | http://localhost:9090 | 无需认证 |
| Grafana | http://localhost:3001 | admin / admin |

### 9.3 启用后端 Prometheus 指标

在 `backend/.env` 中设置：
```env
ENABLE_PROMETHEUS=True
```

访问 http://localhost:8000/metrics 查看指标数据。

---

## 10. 性能调优

### 10.1 PostgreSQL 调优

本项目为 PostgreSQL 提供了调优参数配置，适配 512M 内存容器，通过 [docker-compose.yml](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/kb_qa_system/docker-compose.yml) 中 postgres 服务的 `command` 字段以 `-c` 参数逐项设置，无需手动操作。

> ⚠️ **为何不挂载 postgresql.conf**：使用 `-c config_file=/custom/path` 覆盖会导致 PostgreSQL 在自定义配置文件所在目录寻找 `pg_hba.conf`（认证配置），而非默认的 PGDATA 目录，从而启动失败。`-c` 参数方式保留 Docker 入口点创建的默认配置（含 `listen_addresses='*'` 和正确的 `hba_file` 路径）。参数详解见 [postgresql.conf](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/kb_qa_system/backend/scripts/postgresql.conf)（仅作参考文档，不挂载）。

**调优参数说明**：

| 参数 | PG 默认值 | 调优值 | 作用 |
|------|----------|--------|------|
| `shared_buffers` | 128MB | 128MB | 数据缓冲池（512M 容器维持） |
| `effective_cache_size` | 4GB | 384MB | 规划器预估可用缓存（影响索引选择） |
| `work_mem` | 4MB | 8MB | 排序/哈希内存（提升向量检索性能） |
| `maintenance_work_mem` | 64MB | 64MB | VACUUM/索引构建内存 |
| `random_page_cost` | 4.0 | 1.1 | SSD 随机读代价（关键：倾向索引扫描） |
| `effective_io_concurrency` | 1 | 200 | SSD 并发 IO |
| `max_connections` | 100 | 50 | 连接数上限（匹配 DB_POOL_SIZE） |
| `log_min_duration_statement` | -1 | 1000 | 记录 >1s 慢查询 |

**验证配置生效**：

```bash
docker-compose exec postgres psql -U postgres -d kb_qa -c "SHOW shared_buffers; SHOW random_page_cost; SHOW work_mem;"
# 预期输出：shared_buffers = 128MB, random_page_cost = 1.1, work_mem = 8MB
```

**调整参数**：

如需修改参数（如容器内存调整后），编辑 [docker-compose.yml](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/kb_qa_system/docker-compose.yml) 中 postgres 服务的 `command` 字段对应 `-c` 参数后重启：

```bash
docker-compose up -d postgres  # 重新创建容器以应用新参数
```

> 💡 参数说明参考 [postgresql.conf](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/kb_qa_system/backend/scripts/postgresql.conf)（该文件仅作文档参考，实际生效靠 `command` 中的 `-c` 参数）。

**关闭调优**（使用 PG 默认配置）：

注释 `docker-compose.yml` 中 postgres 服务的 `command` 字段，然后 `docker-compose up -d postgres`。

### 10.2 前端资源加载优化

#### 10.2.1 API 预连接

[index.html](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/kb_qa_system/frontend/index.html) 已通过 `<link rel="preconnect">` 预连接后端 API 域名，减少首屏 API 请求的 DNS + TLS 握手开销（约 100-200ms）。

**配置**：Vite 构建时自动从 `.env` 读取 `VITE_API_BASE_URL` 替换 `index.html` 中的 `%VITE_API_BASE_URL%`。

```bash
# 在 frontend/.env.production 中设置生产后端域名
VITE_API_BASE_URL=https://your-backend.up.railway.app/api/v1
```

> 💡 同源部署（`VITE_API_BASE_URL=/api/v1`）时浏览器自动跳过 preconnect，无副作用。

#### 10.2.2 modulePreload 优化

[vite.config.ts](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/kb_qa_system/frontend/vite.config.ts) 已配置 `modulePreload: { polyfill: false }`，移除了不必要的 polyfill（约 600 bytes），依赖浏览器原生 `modulepreload` 支持（Chrome 61+/Firefox 60+/Safari 10.1+）。

### 10.3 后端冷启动优化

通过 `MODEL_EAGER_HEALTH_CHECK` 环境变量控制模型健康检查的启动行为：

| 值 | 行为 | 适用场景 |
|----|------|----------|
| `False`（默认） | 健康检查后台异步启动，应用立即就绪 | 生产环境、Railway 部署 |
| `True` | 等待健康检查 Task 创建后再就绪 | 调试、要求首批请求前熔断器已更新 |

```bash
# 在 backend/.env 中配置
MODEL_EAGER_HEALTH_CHECK=False  # 生产推荐
```

> 💡 即使设为 `False`，`manager` 内部 `_ensure_initialized()` 懒加载兜底仍生效，首次真实调用时按需初始化。

---

## 11. 常见问题排查

### Q1: pgvector 扩展缺失

**现象**：`alembic upgrade head` 报错 `extension "vector" does not exist`

**解决**：
```bash
# 手动安装扩展
psql -d kb_qa -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 如果报错 "vector control file not found"
# 说明 PostgreSQL 未安装 pgvector，请参考 3.1 安装 pgvector
```

### Q2: 端口冲突

**现象**：`docker-compose up` 报错 `port is already allocated`

**解决**：
```bash
# 查看占用端口的进程
# Windows
netstat -ano | findstr :5432
# macOS
lsof -i :5432

# 停止占用进程，或修改 docker-compose.yml 中的端口映射
# 例如将 PostgreSQL 端口改为 5433：
# ports:
#   - "5433:5432"
```

### Q3: CORS 跨域错误

**现象**：前端控制台报错 `CORS policy: No 'Access-Control-Allow-Origin'`

**解决**：确认 `backend/.env` 中 `CORS_ORIGINS` 包含前端地址：
```env
CORS_ORIGINS=["http://localhost:3000","http://localhost:5173","http://127.0.0.1:5173"]
```

### Q4: aiosmtplib 未安装

**现象**：`ModuleNotFoundError: No module named 'aiosmtplib'`

**解决**：
```bash
cd kb_qa_system/backend
pip install aiosmtplib==3.0.2
# 或重新安装全部依赖
pip install -r requirements.txt
```

> **说明**：aiosmtplib 在 requirements.txt 中已声明，正常 `pip install -r requirements.txt` 会安装。若使用虚拟环境遗漏，单独安装即可。

### Q5: PowerShell 脚本执行策略阻止

**现象**：运行 `npx` 或 `.ps1` 脚本报错 `cannot be loaded because running scripts is disabled`

**解决**：
```bash
# 方式一：使用 .cmd 后缀（推荐）
npx.cmd tsc --noEmit
npm.cmd run dev

# 方式二：临时绕过执行策略
powershell -ExecutionPolicy Bypass -Command "npx tsc --noEmit"

# 方式三：永久修改执行策略（管理员权限）
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Q6: Celery Worker 无法连接 Redis

**现象**：Worker 日志报错 `ConnectionError: Error 111 connecting to localhost:6379`

**解决**：
```bash
# 确认 Redis 已启动
redis-cli ping
# 应返回 PONG

# 如果 Redis 在 Docker 中运行，手动方式需用 localhost
# Docker Compose 方式 Worker 用服务名 redis:6379（自动配置）

# 检查 .env 中的 CELERY_BROKER_URL
# 手动方式：redis://localhost:6379/1
# Docker 方式：redis://redis:6379/1
```

### Q7: 数据库迁移失败

**现象**：`alembic upgrade head` 报错

**解决**：
```bash
# 1. 检查 DATABASE_URL 是否正确
# 2. 确认数据库已创建且 pgvector 扩展已安装

# 查看当前迁移状态
alembic current

# 回滚到上一版本（慎用）
alembic downgrade -1

# 重置所有迁移（清空数据库后重新执行）
alembic downgrade base
alembic upgrade head
```

### Q8: 前端构建内存不足

**现象**：`vite build` 报错 `JavaScript heap out of memory`

**解决**：
```bash
# 增加 Node.js 内存限制
set NODE_OPTIONS=--max-old-space-size=4096  # Windows
export NODE_OPTIONS=--max-old-space-size=4096  # macOS/Linux

npm run build
```

### Q9: 文档上传后状态一直 pending

**现象**：文档上传成功但状态不变，始终为 `pending`

**解决**：
```bash
# 1. 确认 Celery Worker 已启动
# Docker Compose 方式：
docker-compose ps  # 确认 worker 状态为 running

# 2. 查看 Worker 日志
docker-compose logs worker

# 3. 确认 OPENAI_API_KEY 有效（向量化依赖 Embedding API）
# 4. 在 Flower 面板查看任务状态
```

### Q10: 邮件发送失败

**现象**：注册审批后用户未收到邮件

**解决**：
```bash
# 1. 确认 EMAIL_ENABLED=True
# 2. 确认 SMTP_PASSWORD 为有效的 Resend API Key（格式：re_xxxxx）
# 3. 确认 EMAIL_FROM 格式正确
# 4. 查看 Worker 日志中的邮件任务错误
docker-compose logs worker | findstr email

# 5. Resend 默认域 onboarding@resend.dev 只能发送到 ADMIN_NOTIFY_EMAIL
#    发送给其他用户需验证自有域名
```

### Q11: 使用邮箱登录返回 401

**现象**：在前端登录页面使用邮箱登录，返回 `401 Unauthorized`

**原因**：后端登录端点查询条件为 `(User.username == input) OR (User.email == input)`，同时支持用户名和邮箱。如遇 401，请按以下步骤排查：

**排查步骤**：
```bash
# 1. 确认账号存在且邮箱匹配
psql -d kb_qa -c "SELECT id, username, email, is_active FROM users WHERE email = 'your_email@example.com' OR username = 'your_email';"

# 2. 确认账号已激活（is_active=true）
# 3. 确认未触发登录失败锁定（5 次失败锁定 15 分钟）
# 4. 确认密码正确（bcrypt 不可逆，只能重置）
```

**常见原因**：
- 账号未激活：通过 `create_superuser.py` 创建的账号默认 `is_active=true`，但注册用户需管理员审批后激活
- 密码错误：超过 5 次将锁定 15 分钟
- 账号被禁用：管理员可通过数据库设置 `is_active=false`

> 📖 详细排查流程见 [前端认证401调查报告.md](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/docs/前端认证401调查报告.md)

---

## 附录：服务端口对照表

| 服务 | 端口 | 说明 |
|------|------|------|
| 前端（Vite dev） | 5173 | 开发服务器 |
| 前端（nginx） | 80 | Docker 生产模式 |
| 后端 API | 8000 | FastAPI |
| PostgreSQL | 5432 | 数据库 |
| Redis | 6379 | 缓存/队列 |
| Flower | 5555 | Celery 监控 |
| Prometheus | 9090 | 指标采集 |
| Grafana | 3001 | 可视化面板 |

---

## 附录：项目目录结构

```
企业知识库问答系统/
├── docs/                          # 项目文档
│   ├── LOCAL_DEPLOYMENT_GUIDE.md  # 本文件
│   ├── RAILWAY_DEPLOYMENT_GUIDE.md# Railway 部署指南
│   ├── COMPREHENSIVE_REVIEW_10D.md# 十维度审查报告
│   └── ...
├── kb_qa_system/
│   ├── docker-compose.yml         # Docker 编排（开发环境）
│   ├── monitoring/                # 监控栈配置
│   │   ├── docker-compose.monitoring.yml
│   │   ├── prometheus.yml
│   │   ├── alerts.yml
│   │   └── grafana/
│   ├── backend/                   # 后端
│   │   ├── app/
│   │   │   ├── api/routes/        # API 路由
│   │   │   ├── core/              # 核心配置（config, security, redis, database）
│   │   │   ├── models/            # 数据模型
│   │   │   ├── services/          # 业务服务（RAG, 权限, 邮件）
│   │   │   ├── tasks/             # Celery 异步任务
│   │   │   ├── middleware/        # 中间件
│   │   │   └── main.py            # 应用入口
│   │   ├── alembic/versions/      # 数据库迁移
│   │   ├── scripts/               # 运维脚本
│   │   ├── tests/                 # 测试
│   │   ├── Dockerfile
│   │   ├── entrypoint.sh
│   │   ├── railway.json
│   │   ├── requirements.txt
│   │   └── .env.example
│   └── frontend/                  # 前端
│       ├── src/
│       │   ├── api/               # API 调用
│       │   ├── components/        # 组件
│       │   ├── pages/             # 页面
│       │   ├── store/             # Zustand 状态管理
│       │   └── App.tsx            # 路由配置
│       ├── Dockerfile
│       ├── railway.json
│       ├── package.json
│       └── .env.example
```

---

> 如部署中遇到本指南未覆盖的问题，请参考 [Railway 部署指南](RAILWAY_DEPLOYMENT_GUIDE.md) 中的常见问题排查章节，或查看 [十维度审查报告](COMPREHENSIVE_REVIEW_10D.md) 中的已知问题。
