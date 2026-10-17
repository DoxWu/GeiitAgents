# GeiIt 企业知识库 — Railway 完整部署指南

> 本指南将带你从零开始，将 GeiIt 企业知识库完整部署到 Railway 平台。
>
> **预计部署时间**：30–60 分钟
> **部署架构**：前端（nginx） + 后端 API（FastAPI） + Worker（Celery） + PostgreSQL(pgvector) + Redis

---

## 目录

1. [部署架构总览](#1-部署架构总览)
2. [前置准备](#2-前置准备)
3. [第 1 步：创建 Railway 项目](#第-1-步创建-railway-项目)
4. [第 2 步：添加 PostgreSQL 数据库](#第-2-步添加-postgresql-数据库)
5. [第 3 步：添加 Redis 缓存](#第-3-步添加-redis-缓存)
6. [第 4 步：部署后端 API 服务](#第-4-步部署后端-api-服务)
7. [第 5 步：部署 Celery Worker 服务](#第-5-步部署-celery-worker-服务)
8. [第 6 步：部署前端服务](#第-6-步部署前端服务)
9. [第 7 步：验证部署](#第-7-步验证部署)
10. [第 8 步：配置自定义域名（可选）](#第-8-步配置自定义域名可选)
11. [环境变量完整参考](#环境变量完整参考)
12. [监控与日志](#监控与日志)
13. [备份策略](#备份策略)
14. [回滚流程](#回滚流程)
15. [部署检查清单](#部署检查清单)
16. [性能调优](#性能调优)
17. [常见问题排查](#常见问题排查)

---

## 1. 部署架构总览

```
┌─────────────────────────────────────────────────────┐
│                    Railway 项目                       │
│                                                       │
│  ┌──────────┐    ┌──────────┐    ┌───────────────┐  │
│  │ 前端      │───▶│ 后端 API  │───▶│ PostgreSQL    │  │
│  │ (nginx)  │    │ (FastAPI)│    │ + pgvector    │  │
│  │ :80      │    │ :8000    │    │               │  │
│  └──────────┘    └────┬─────┘    └───────────────┘  │
│                       │                              │
│                       ▼              ┌─────────────┐ │
│              ┌──────────────┐        │ Redis        │ │
│              │ Celery Worker │───────▶│ (缓存+队列)  │ │
│              │ (异步任务)    │        │             │ │
│              └──────────────┘        └─────────────┘ │
│                                                       │
│  用户 ───HTTPS───▶ 前端 ───CORS───▶ 后端 API         │
│                                       │               │
│                          Worker ◀─────┘               │
│                       (通过 Redis 队列通信)            │
└─────────────────────────────────────────────────────┘
```

### 服务清单

| 服务 | 镜像 | 端口 | 作用 |
|------|------|------|------|
| 前端 | nginx:1.25-alpine | 80 | 静态资源 + SPA 路由 |
| 后端 API | python:3.11-slim | 8000 | FastAPI REST API |
| Worker | python:3.11-slim | — | Celery 异步任务（文档解析/向量化） |
| PostgreSQL | Railway 插件 | 5432 | 主数据库 + pgvector 向量存储 |
| Redis | Railway 插件 | 6379 | 缓存 + 限流 + 任务队列 + Token 黑名单 |

---

## 2. 前置准备

### 2.1 账号准备

- [ ] **Railway 账号**：注册 [railway.app](https://railway.app)
- [ ] **GitHub 账号**：代码将推送到 GitHub 仓库
- [ ] **LLM API Key**：OpenAI / 智谱 AI / 通义千问（任选其一）

### 2.2 代码准备

将项目推送到 GitHub 仓库：

```bash
# 在项目根目录执行
git init
git add .
git commit -m "Initial commit: GeiIt企业知识库"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

> **仓库结构要求**：
> ```
> <仓库根>/
> ├── kb_qa_system/
> │   ├── backend/          # 后端代码
> │   │   ├── app/
> │   │   ├── alembic/
> │   │   ├── Dockerfile
> │   │   ├── railway.json
> │   │   ├── entrypoint.sh
> │   │   └── requirements.txt
> │   └── frontend/         # 前端代码
> │       ├── src/
> │       ├── public/
> │       ├── Dockerfile
> │       ├── railway.json
> │       ├── nginx.conf
> │       └── package.json
> └── docs/
> ```

### 2.3 生成密钥

在部署前，生成以下密钥（保存好，稍后配置环境变量时使用）：

```bash
# 生成 SECRET_KEY（JWT 签名密钥，≥32 字符）
python -c "import secrets; print(secrets.token_urlsafe(32))"
# 输出示例：dG9wLXNlY3JldC1rZXktZm9yLXByb2R1Y3Rpb24...

# 生成 Prometheus 监控密码（如需启用监控）
python -c "import secrets; print(secrets.token_urlsafe(16))"
```

---

## 3. 部署步骤

### 第 1 步：创建 Railway 项目

1. 登录 [Railway Dashboard](https://railway.app/dashboard)
2. 点击 **New Project**
3. 选择 **Deploy from GitHub repo**
4. 授权 Railway 访问你的 GitHub 仓库
5. 选择包含 GeiIt 企业知识库代码的仓库

> ⚠️ **暂不部署任何服务**，先创建空项目，稍后逐个添加服务和数据库。

---

### 第 2 步：添加 PostgreSQL 数据库

GeiIt 企业知识库使用 PostgreSQL + pgvector 扩展存储文档向量和结构化数据。

1. 在 Railway 项目页面，点击 **New → Database → Add PostgreSQL**
2. Railway 会自动创建 PostgreSQL 实例并注入 `DATABASE_URL` 环境变量
3. **启用 pgvector 扩展**：
   - 点击刚创建的 PostgreSQL 服务
   - 进入 **Query** 标签页
   - 执行以下 SQL：
     ```sql
     CREATE EXTENSION IF NOT EXISTS vector;
     ```
   - 确认返回 `CREATE EXTENSION`（表示 pgvector 已启用）

4. **确认数据库连接信息**：
   - 在 PostgreSQL 服务的 **Variables** 标签页，找到 `DATABASE_URL`
   - 格式类似：`postgresql://postgres:password@monorail.proxy.rlwy.net:12345/railway`

> 💡 **如果 Railway 的 PostgreSQL 不支持 pgvector**：
> 
> Railway 的 PostgreSQL 插件已默认支持 pgvector。如果遇到问题，可在 Railway 设置中将 PostgreSQL 版本升级到 15+，或在 Query 中手动执行 `CREATE EXTENSION vector;`。

---

### 第 3 步：添加 Redis 缓存

Redis 用于：缓存、限流、Token 黑名单、Celery 任务队列。

1. 在 Railway 项目页面，点击 **New → Database → Add Redis**
2. Railway 会自动创建 Redis 实例并注入 `REDIS_URL` 环境变量
3. **确认 Redis 连接信息**：
   - 在 Redis 服务的 **Variables** 标签页，找到 `REDIS_URL`
   - 格式类似：`redis://default:password@monorail.proxy.rlwy.net:6379`

> ⚠️ **重要**：Railway Redis 默认关闭了持久化。由于系统采用 fail-closed 策略（Redis 故障时拒绝请求而非放行），建议在 Redis 服务设置中启用持久化（AOF 或 RDB），避免重启后 Token 黑名单丢失。

---

### 第 4 步：部署后端 API 服务

#### 4.1 创建后端服务

1. 在 Railway 项目页面，点击 **New → GitHub Repository**
2. 选择你的代码仓库
3. Railway 会自动检测到仓库中的 `railway.json` 文件
4. **设置根目录**：
   - 点击刚创建的服务
   - 进入 **Settings** 标签页
   - 找到 **Root Directory**，设置为 `kb_qa_system/backend`
   - Railway 会自动使用该目录下的 `Dockerfile` 和 `railway.json`

#### 4.2 配置后端环境变量

在服务的 **Variables** 标签页，添加以下环境变量：

**必须配置的变量**：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `ENVIRONMENT` | `production` | 生产环境标识 |
| `DEBUG` | `False` | 关闭调试模式 |
| `SECRET_KEY` | （第 2.3 步生成的密钥） | JWT 签名密钥（≥32 字符） |
| `OPENAI_API_KEY` | `sk-your-key` | LLM API Key |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | LLM API 地址（智谱用 `https://open.bigmodel.cn/api/paas/v4`） |
| `LLM_MODEL_NAME` | `gpt-3.5-turbo` | 主模型名称（智谱用 `glm-4`） |
| `EMBEDDING_MODEL_NAME` | `text-embedding-ada-002` | Embedding 模型（智谱用 `embedding-2`） |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | 引用 PostgreSQL 服务的变量 |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | 引用 Redis 服务的变量 |
| `CELERY_BROKER_URL` | `${{Redis.REDIS_URL}}` | Celery 消息队列（复用 Redis） |
| `CELERY_RESULT_BACKEND` | `${{Redis.REDIS_URL}}` | Celery 结果存储（复用 Redis） |
| `CORS_ORIGINS` | `["https://你的前端域名.up.railway.app"]` | 允许的前端域名（**先填占位，第 6 步获取前端域名后更新**） |
| `MIGRATE_ON_STARTUP` | `false` | **必须设为 `false`**：`railway.json` 已通过 `releaseCommand` 执行迁移，设为 `false` 避免启动时重复迁移（见 4.3 节） |

**可选配置的变量**：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `UVICORN_WORKERS` | `1` | API 工作进程数（Railway 免费版建议 1–2） |
| `ENABLE_OCR` | `True` | OCR 识别（扫描件支持，关闭可节省资源） |
| `ENABLE_PROMETHEUS` | `False` | Prometheus 监控（如需启用设为 `True`） |
| `ENABLE_SENTRY` | `False` | Sentry 错误监控（如需启用设为 `True`） |
| `SENTRY_DSN` | （空） | Sentry DSN 地址 |

> 💡 **引用其他服务变量的语法**：在 Railway 中，使用 `${{服务名.变量名}}` 引用其他服务的变量。例如 `${{Postgres.DATABASE_URL}}` 会自动替换为 PostgreSQL 服务的 `DATABASE_URL` 值。具体服务名以 Railway 中显示的为准（通常为 `Postgres` 和 `Redis`）。

#### 4.3 确认部署配置

后端 `railway.json` 已配置好以下内容（无需手动修改）：

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": {
    "startCommand": "/app/entrypoint.sh",
    "releaseCommand": "alembic upgrade head",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 60,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

- **启动命令**：`entrypoint.sh` 根据 `ROLE` 环境变量启动不同服务（api/worker/flower）
- **发布命令**：`releaseCommand` 在部署前执行 `alembic upgrade head`（数据库迁移），Railway 会确保迁移成功后才启动新版本
- **健康检查**：访问 `/health` 端点，检查 API + 数据库 + Redis 连通性
- **重启策略**：失败时自动重启（最多 5 次）

> ✅ **D9-01 已实施**：`railway.json` 已配置 `releaseCommand: "alembic upgrade head"`，Railway 在部署前自动执行迁移。配合环境变量 `MIGRATE_ON_STARTUP=false`（见 4.2 节），`entrypoint.sh` 启动时会跳过迁移步骤，避免多副本并发迁移冲突。

> ⚠️ **重要**：如使用 `releaseCommand`，**必须**在后端环境变量中设置 `MIGRATE_ON_STARTUP=false`，否则 `entrypoint.sh` 启动时会再次执行迁移（虽然 Alembic 幂等，但增加启动延迟且多副本仍有冲突风险）。

#### 4.4 部署并验证

1. 添加完所有环境变量后，Railway 会自动触发构建
2. 在 **Deployments** 标签页查看构建日志
3. 构建完成后，在 **Settings** 标签页找到 **Networking** → **Generate Domain**
4. Railway 会分配一个域名，如 `https://geiit-backend-production.up.railway.app`
5. 访问 `https://你的后端域名/health`，确认返回：
   ```json
   {
     "status": "healthy",
     "service": "GeiIt企业知识库",
     "checks": {
       "database": { "status": "healthy", "latency_ms": 2 },
       "redis": { "status": "healthy", "latency_ms": 1 }
     }
   }
   ```

> ✅ **数据库迁移验证**：查看部署日志，确认出现 `✅ 数据库迁移完成` 消息。这表示 Alembic 已成功创建所有表和索引（包括 pgvector 的 IVFFlat 索引）。

#### 4.5 配置邮件服务（Resend）

系统使用 Resend 作为 SMTP 代理服务发送邮件（注册申请通知、密码设置链接、拒绝通知、账号创建确认）。Resend 免费额度为 3000 封/月，足够中小规模使用。

> 💡 **如果暂不需要邮件功能**：可跳过本步，设置 `EMAIL_ENABLED=False`，系统会跳过邮件发送但注册申请记录仍会创建（降级模式）。部署后随时可补配。

**4.5.1 获取 Resend API Key**

1. 访问 [resend.com](https://resend.com) 注册账号
2. 进入 [API Keys 页面](https://resend.com/api-keys) 点击 **Create API Key**
3. 复制生成的 API Key（格式：`re_xxxxxxxxxxxx`），保存好

**4.5.2 验证发件域名（生产环境必需）**

Resend 默认提供 `onboarding@resend.dev` 发件地址，但**仅可发送到你注册 Resend 的邮箱**。生产环境需验证自己的域名：

1. 在 Resend Dashboard → **Domains** → **Add Domain**
2. 输入你的域名（如 `yourdomain.com`）
3. 在你的 DNS 提供商添加 Resend 给出的 MX/TXT/SPF 记录
4. 等待验证通过（通常几分钟到几小时）

**4.5.3 在 Railway 后端服务配置邮件环境变量**

在后端 API 服务的 **Variables** 标签页，添加以下变量：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `EMAIL_ENABLED` | `True` | 启用邮件发送 |
| `SMTP_HOST` | `smtp.resend.com` | Resend SMTP 地址 |
| `SMTP_PORT` | `465` | SSL 端口 |
| `SMTP_USER` | `resend` | 固定值 |
| `SMTP_PASSWORD` | `re_your_resend_api_key` | 替换为你的 Resend API Key |
| `SMTP_USE_TLS` | `True` | 启用 SSL 加密 |
| `SMTP_START_TLS` | `False` | 不使用 STARTTLS（已用 SSL） |
| `SMTP_TIMEOUT` | `30` | SMTP 超时（秒） |
| `EMAIL_FROM` | `GeiIt企业知识库 <noreply@yourdomain.com>` | 发件人地址（需用已验证域名） |
| `ADMIN_NOTIFY_EMAIL` | `admin@yourcompany.com` | 接收注册申请通知的管理员邮箱 |
| `FRONTEND_BASE_URL` | `https://你的前端域名.up.railway.app` | 前端地址（用于拼接密码设置链接，先填占位，第 6 步获取前端域名后更新） |
| `PASSWORD_TOKEN_EXPIRE_HOURS` | `24` | 密码设置 Token 有效期（小时） |

> ⚠️ **EMAIL_FROM 格式要求**：必须为 `显示名 <邮箱地址>` 格式，邮箱域名必须与 Resend 已验证的域名一致。开发阶段可用 `GeiIt企业知识库 <onboarding@resend.dev>`，但只能发到 Resend 注册邮箱。

**4.5.4 Worker 服务也需配置邮件变量**

Celery Worker 负责异步发送邮件，因此 **Worker 服务的环境变量也必须包含上述所有邮件相关变量**（与 API 服务保持一致）。

**4.5.5 验证邮件发送**

1. 确保后端 API 和 Worker 服务都已部署且环境变量已配置
2. 访问前端注册页面，提交一个注册申请
3. 检查 `ADMIN_NOTIFY_EMAIL` 指向的管理员邮箱，应收到"新注册申请通知"邮件
4. 查看后端日志，确认出现 `邮件任务已提交` 日志且无 SMTP 错误

> ⚠️ **10D 审查提醒（D3-02）**：生产环境 `/metrics` 端点默认无认证，请在监控配置中强制设置 `PROMETHEUS_AUTH_ENABLED=True`，避免指标数据暴露。详见 [监控与日志](#监控与日志) 章节。

#### 4.6 创建超级管理员账号

系统没有默认的管理员账号，部署后需要手动创建第一个超级管理员。超级管理员拥有以下权限：
- 访问所有用户文档（包括公共库和私人库）
- 管理公共文档（删除/重新处理）
- 访问 QA 质量统计看板（`/stats/overview`）

**方式 1：通过 Railway Shell 执行（推荐）**

1. 在 Railway Dashboard 中，进入后端 API 服务
2. 点击 **Settings** → 找到 **Service Shell** 或 **Web Terminal**
3. 在 Shell 中执行以下命令：

```bash
# 使用命令行参数（替换为你实际的管理员信息）
python -m scripts.create_superuser \
  --username admin \
  --email admin@yourcompany.com \
  --password "YourSecure123"
```

4. 看到以下输出表示创建成功：
   ```
   ✅ 超级管理员创建成功！
      用户名: admin
      邮箱: admin@yourcompany.com
      ID: 1
      状态: 活跃
      角色: 超级管理员
   ```

**方式 2：通过环境变量执行（适合自动化）**

1. 在后端 API 服务的 **Variables** 标签页，临时添加以下变量：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `SUPERUSER_USERNAME` | `admin` | 管理员用户名 |
| `SUPERUSER_EMAIL` | `admin@yourcompany.com` | 管理员邮箱 |
| `SUPERUSER_PASSWORD` | `YourSecure123` | 管理员密码（≥8 字符，含字母和数字） |

2. 进入 **Settings → Command**，临时修改启动命令为：
   ```
   python -m scripts.create_superuser && /app/entrypoint.sh
   ```
3. 触发重新部署
4. 查看日志确认 `✅ 超级管理员创建成功`
5. **立即恢复**启动命令为 `/app/entrypoint.sh`，并**删除**三个临时环境变量
6. 重新部署

> ⚠️ **安全提示**：创建完成后务必删除 `SUPERUSER_PASSWORD` 环境变量，避免密码长期暴露在配置中。

**方式 3：将普通用户升级为管理员**

如果你已经通过前端注册了账号，可以将该账号升级为超级管理员：

```bash
# 在 Railway Shell 中执行（替换 username 为已注册的用户名）
python -m scripts.create_superuser \
  --username your_username \
  --email your_email@example.com \
  --password "YourCurrentPassword123" \
  --upgrade-only
```

> 💡 `--upgrade-only` 参数：仅升级已有用户为管理员，不创建新用户，不修改密码（密码参数仅用于通过校验，不会被修改）。

**方式 4：通过 PostgreSQL SQL 直接操作**

如果以上方式不可用，可以直接在 Railway PostgreSQL Query 中执行 SQL：

```sql
-- 查看当前用户
SELECT id, username, email, is_superuser FROM users;

-- 将指定用户升级为超级管理员
UPDATE users SET is_superuser = true WHERE username = 'your_username';

-- 验证
SELECT id, username, email, is_superuser FROM users WHERE username = 'your_username';
```

> ⚠️ **注意**：不推荐直接用 SQL 创建新用户，因为密码需要 bcrypt 哈希。升级已有用户用 SQL 是安全的。

**验证超级管理员**：用管理员账号登录前端，用户名旁会显示"管理员"标签。

> 💡 **登录说明**：系统登录端点同时支持**用户名**和**邮箱**登录。前端登录表单虽以邮箱字段呈现，但后端查询条件为 `User.username == input OR User.email == input`。因此创建管理员后，既可用 `admin`（用户名）也可用 `admin@yourcompany.com`（邮箱）登录前端。

#### 4.7 注册审批流程部署说明

GeiIt 企业知识库采用**注册审批制**：用户提交申请 → 管理员审批 → 用户通过邮件链接设置密码 → 账号创建。此流程依赖邮件服务，请先完成 [4.5 配置邮件服务](#45-配置邮件服务resend)。

**4.7.1 流程全链路**

```
用户提交申请（/auth/register/apply）
    → 创建 pending 申请记录
    → 异步发送管理员通知邮件（到 ADMIN_NOTIFY_EMAIL）

管理员登录前端 → 进入审批页面 → 批准/拒绝
    → 批准：生成密码设置 Token（secrets.token_urlsafe(32)）
    → 异步发送密码设置邮件（含 Token 链接）给申请人
    → 拒绝：异步发送拒绝通知邮件给申请人

用户点击邮件链接 → 设置密码（/auth/register/set-password）
    → 校验 Token（SHA-256 比对 + 24h 过期 + 一次性使用）
    → 创建 User 账号
    → 异步发送账号创建确认邮件
```

**4.7.2 部署必须配置的变量**

| 变量名 | 作用 | 配置位置 |
|--------|------|----------|
| `EMAIL_ENABLED` | 必须为 `True` | API + Worker |
| `ADMIN_NOTIFY_EMAIL` | 接收注册申请通知的管理员邮箱 | API + Worker |
| `FRONTEND_BASE_URL` | 拼接密码设置链接的前端地址（如 `https://app.example.com`） | API + Worker |
| `SMTP_PASSWORD` | Resend API Key | API + Worker |

> ⚠️ **FRONTEND_BASE_URL 至关重要**：密码设置链接格式为 `{FRONTEND_BASE_URL}/set-password?token=xxx`。如果此变量配置错误，用户收到的链接将无法打开。

**4.7.3 管理员审批入口**

超级管理员登录前端后，导航栏会显示**"审批管理"**入口，可查看所有注册申请并执行批准/拒绝操作。

**4.7.4 Token 安全机制**

- **生成**：`secrets.token_urlsafe(32)` 生成 43 字符 URL 安全随机串（256 位熵）
- **存储**：SHA-256 哈希后存数据库，明文 Token 不落库
- **有效期**：24 小时（`PASSWORD_TOKEN_EXPIRE_HOURS=24` 可调）
- **一次性**：使用后标记 `password_token_used_at`，不可重复使用
- **防重复提交**：同一邮箱 1 小时内只能申请一次（Redis 锁）

**4.7.5 降级模式**

如果 `EMAIL_ENABLED=False` 或 `ADMIN_NOTIFY_EMAIL` 未配置：
- 注册申请记录仍会创建（用户可查询申请状态）
- 管理员不会收到通知邮件（需主动登录前端查看审批列表）
- 批准后不会发送密码设置邮件（申请人无法收到链接）

> 💡 **建议**：生产环境务必配置邮件服务，否则审批流程无法自动通知用户。

---

### 第 5 步：部署 Celery Worker 服务

Worker 负责异步处理文档（解析、分块、向量化），是文档上传功能的核心依赖。

#### 5.1 创建 Worker 服务

1. 在 Railway 项目页面，点击 **New → GitHub Repository**
2. 选择同一代码仓库
3. **设置根目录**为 `kb_qa_system/backend`（与 API 服务相同）
4. 这个服务也使用同一个 Dockerfile，但通过 `ROLE` 环境变量切换启动角色

#### 5.2 配置 Worker 环境变量

Worker 服务需要与 API 服务**完全相同的基础环境变量**（除了 Worker 不需要 `CORS_ORIGINS`）。

最快的方式：在 Railway 中，你可以逐个添加，或使用 **Raw Editor** 批量粘贴。

**必须配置的变量**：

| 变量名 | 值 |
|--------|-----|
| `ENVIRONMENT` | `production` |
| `DEBUG` | `False` |
| `SECRET_KEY` | （与 API 服务相同的值） |
| `OPENAI_API_KEY` | （与 API 服务相同的值） |
| `OPENAI_API_BASE` | （与 API 服务相同的值） |
| `LLM_MODEL_NAME` | （与 API 服务相同的值） |
| `EMBEDDING_MODEL_NAME` | （与 API 服务相同的值） |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `CELERY_BROKER_URL` | `${{Redis.REDIS_URL}}` |
| `CELERY_RESULT_BACKEND` | `${{Redis.REDIS_URL}}` |
| `ROLE` | `worker` |

> ⚠️ **关键**：`ROLE=worker` 会让 `entrypoint.sh` 启动 Celery Worker 而非 FastAPI。

**可选变量**：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `CELERY_WORKER_CONCURRENCY` | `2` | Worker 并发数 |
| `CELERY_MAX_TASKS_PER_CHILD` | `100` | 每个 Worker 进程处理最大任务数后重启（防内存泄漏） |

#### 5.3 修改 Worker 的健康检查

Worker 服务没有 HTTP 端点，需要修改健康检查方式：

1. 进入 Worker 服务的 **Settings** 标签页
2. 找到 **Healthcheck**，将其设为空或禁用（Railway 对非 HTTP 服务会使用进程存活检查）
3. 或者设置自定义健康检查命令：
   - **Healthcheck Path**：留空
   - Railway 会通过检查进程是否存活来判断健康状态

#### 5.4 部署并验证

1. 部署完成后，查看日志，确认出现：
   ```
   🔧 启动 Celery Worker...
   celery@... ready.
   ```
2. Worker 会连接 Redis 和 PostgreSQL，等待处理文档任务

---

### 第 6 步：部署前端服务

#### 6.1 创建前端服务

1. 在 Railway 项目页面，点击 **New → GitHub Repository**
2. 选择同一代码仓库
3. **设置根目录**为 `kb_qa_system/frontend`

#### 6.2 配置构建参数

前端 Dockerfile 使用构建参数（build arg）注入 API 地址。在 Railway 中通过 **Service Variables** 配置：

在服务的 **Variables** 标签页，添加：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `VITE_API_BASE_URL` | `https://你的后端域名.up.railway.app/api/v1` | 后端 API 公网地址（替换为第 4.4 步获取的域名） |
| `VITE_APP_TITLE` | `GeiIt企业知识库` | 应用标题 |

> ⚠️ **重要**：
> - `VITE_API_BASE_URL` 必须是后端的**公网 HTTPS 域名**，以 `/api/v1` 结尾
> - 这是构建时注入的变量（Vite 在构建时读取），修改后需要**重新部署**前端服务才会生效

#### 6.3 更新后端 CORS 配置

1. 获取前端域名（第 6.4 步部署后会生成）
2. 回到后端 API 服务的 **Variables** 标签页
3. 更新 `CORS_ORIGINS` 为：
   ```
   ["https://你的前端域名.up.railway.app"]
   ```
4. 如有自定义域名，也需要加入：
   ```
   ["https://你的前端域名.up.railway.app","https://your-custom-domain.com"]
   ```

#### 6.4 部署并获取域名

1. Railway 会自动构建前端（node 编译 → nginx 镜像）
2. 构建完成后，在 **Settings → Networking → Generate Domain**
3. 获取前端域名，如 `https://geiit-frontend-production.up.railway.app`
4. **用此域名更新后端的 `CORS_ORIGINS` 变量**
5. **用后端域名更新前端的 `VITE_API_BASE_URL` 变量**
6. 重新部署前后端服务使配置生效

#### 6.5 验证前端

1. 访问前端域名，应看到登录页面
2. 尝试注册账号并登录
3. 登录成功后进入文档管理页面
4. 尝试上传一个小文档，观察是否触发 Worker 处理

---

### 第 7 步：验证部署

#### 7.1 健康检查

```bash
# 后端 API 健康
curl https://你的后端域名/health
# 应返回 status: "healthy"

# 前端可访问
curl -I https://你的前端域名
# 应返回 200 OK
```

#### 7.2 功能验证清单

- [ ] 访问前端域名，显示登录页面
- [ ] 注册新账号，登录成功
- [ ] 上传一个 PDF/Markdown 文档
- [ ] 文档状态变为 "completed"（Worker 处理完成）
- [ ] 进入问答页面，提问并收到回答
- [ ] 设置页面导出个人数据
- [ ] 登出后重新登录

#### 7.3 日志检查

在 Railway Dashboard 中查看各服务日志：

- **后端 API 日志**：确认无 `ERROR` 级别日志，JSON 格式输出
- **Worker 日志**：确认文档处理任务执行无异常
- **PostgreSQL 日志**：确认无连接超时或错误
- **Redis 日志**：确认无内存溢出或连接拒绝

---

### 第 8 步：配置自定义域名（可选）

### 8.1 前端自定义域名

1. 在前端服务的 **Settings → Networking**
2. 点击 **Custom Domain**
3. 输入你的域名（如 `kb.yourcompany.com`）
4. Railway 会生成 CNAME 记录，将其添加到你的 DNS 提供商
5. 等待 DNS 生效（通常几分钟到几小时）
6. Railway 自动配置 SSL 证书

### 8.2 更新 CORS 配置

添加自定义域名后，更新后端 `CORS_ORIGINS`：

```
["https://kb.yourcompany.com","https://你的前端域名.up.railway.app"]
```

### 8.3 更新前端 API 地址（如需）

如果使用自定义域名作为前端入口，无需修改 `VITE_API_BASE_URL`（前端通过 CORS 直接访问后端 Railway 域名）。

---

## 环境变量完整参考

### 后端 API 服务

```env
# ===== 应用配置 =====
ENVIRONMENT=production
DEBUG=False
PORT=8000
# Railway 已通过 releaseCommand 执行迁移，跳过启动时迁移
MIGRATE_ON_STARTUP=false

# ===== 数据库 =====
DATABASE_URL=${{Postgres.DATABASE_URL}}
DB_POOL_SIZE=10
DB_MAX_OVERFLOW=20
DB_POOL_RECYCLE=1800
DB_POOL_TIMEOUT=30

# ===== Redis =====
REDIS_URL=${{Redis.REDIS_URL}}

# ===== Celery =====
CELERY_BROKER_URL=${{Redis.REDIS_URL}}
CELERY_RESULT_BACKEND=${{Redis.REDIS_URL}}
CELERY_TASK_TIMEOUT=600
CELERY_TASK_MAX_RETRIES=3

# ===== JWT 认证 =====
SECRET_KEY=<生成的32+字符随机密钥>
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=15
REFRESH_TOKEN_EXPIRE_DAYS=7

# ===== CORS =====
CORS_ORIGINS=["https://你的前端域名.up.railway.app"]

# ===== 邮件 SMTP（Resend）=====
EMAIL_ENABLED=True
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASSWORD=re_your_resend_api_key
SMTP_USE_TLS=True
SMTP_START_TLS=False
SMTP_TIMEOUT=30
EMAIL_FROM=GeiIt企业知识库 <noreply@yourdomain.com>
ADMIN_NOTIFY_EMAIL=admin@yourcompany.com
FRONTEND_BASE_URL=https://你的前端域名.up.railway.app
PASSWORD_TOKEN_EXPIRE_HOURS=24

# ===== LLM 配置 =====
OPENAI_API_KEY=<你的API密钥>
OPENAI_API_BASE=https://api.openai.com/v1
LLM_MODEL_NAME=gpt-3.5-turbo
LLM_FALLBACK_MODEL_NAME=gpt-3.5-turbo
EMBEDDING_MODEL_NAME=text-embedding-ada-002
EMBEDDING_DIMENSION=1536
VISION_MODEL_NAME=gpt-4o-mini

# ===== LLM 容错 =====
LLM_MAX_RETRIES=3
LLM_RETRY_BASE_DELAY=1.0
LLM_TIMEOUT=30
LLM_STREAM_FIRST_TOKEN_TIMEOUT=5
CIRCUIT_BREAKER_THRESHOLD=5
CIRCUIT_BREAKER_RECOVERY_TIME=60

# ===== 向量检索 =====
SEARCH_TOP_K=4
SIMILARITY_THRESHOLD=0.5
ENABLE_HYBRID_SEARCH=True
KEYWORD_SEARCH_WEIGHT=0.3

# ===== 文档处理 =====
CHUNK_SIZE=500
CHUNK_OVERLAP=50
DOCUMENT_QUALITY_THRESHOLD=60.0
ENABLE_OCR=True
ENABLE_VISION=True
ENABLE_TABLE_EXTRACTION=True

# ===== 限流 =====
ENABLE_RATE_LIMIT=True
RATE_LIMIT_GLOBAL_PER_MINUTE=100
RATE_LIMIT_LOGIN_PER_MINUTE=5
RATE_LIMIT_ASK_PER_MINUTE=20
RATE_LIMIT_UPLOAD_PER_HOUR=20
LOGIN_FAILURE_LOCK_THRESHOLD=5
LOGIN_FAILURE_LOCK_MINUTES=15

# ===== RAG 优化 =====
ENABLE_INTENT_DETECTION=True
ENABLE_CONFLICT_DETECTION=True
ENABLE_LATEX_PROTECTION=True
CONVERSATION_HISTORY_LIMIT=5
CONVERSATION_HISTORY_MAX_TOKENS=2000
ENABLE_HISTORY_SUMMARY=True
SUMMARY_EVERY_N_TURNS=5

# ===== Prometheus 监控 =====
ENABLE_PROMETHEUS=True
PROMETHEUS_METRICS_PATH=/metrics
PROMETHEUS_AUTH_ENABLED=True
PROMETHEUS_AUTH_USER=prometheus
PROMETHEUS_AUTH_PASSWORD=<生成的密码>
PROMETHEUS_INCLUDE_PATH_LABEL=False

# ===== Sentry（可选）=====
ENABLE_SENTRY=False
SENTRY_DSN=

# ===== 运行时 =====
UVICORN_WORKERS=1
REQUEST_LOG_SAMPLE_RATE=1.0
```

### Celery Worker 服务

```env
# ===== 角色标识（关键！）=====
ROLE=worker

# ===== 应用配置 =====
ENVIRONMENT=production
DEBUG=False
# Worker 角色不执行数据库迁移（entrypoint.sh 仅在 ROLE=api 时迁移）
# MIGRATE_ON_STARTUP 对 Worker 无影响，但建议也设为 false 保持一致
MIGRATE_ON_STARTUP=false

# ===== 数据库 =====
DATABASE_URL=${{Postgres.DATABASE_URL}}

# ===== Redis =====
REDIS_URL=${{Redis.REDIS_URL}}

# ===== Celery =====
CELERY_BROKER_URL=${{Redis.REDIS_URL}}
CELERY_RESULT_BACKEND=${{Redis.REDIS_URL}}
CELERY_WORKER_CONCURRENCY=2
CELERY_MAX_TASKS_PER_CHILD=100
CELERY_TASK_TIMEOUT=600
CELERY_TASK_MAX_RETRIES=3

# ===== JWT =====
SECRET_KEY=<与API服务相同的密钥>

# ===== 邮件 SMTP（Resend）— Worker 发送邮件任务必需 =====
EMAIL_ENABLED=True
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASSWORD=re_your_resend_api_key
SMTP_USE_TLS=True
SMTP_START_TLS=False
SMTP_TIMEOUT=30
EMAIL_FROM=GeiIt企业知识库 <noreply@yourdomain.com>
ADMIN_NOTIFY_EMAIL=admin@yourcompany.com
FRONTEND_BASE_URL=https://你的前端域名.up.railway.app
PASSWORD_TOKEN_EXPIRE_HOURS=24

# ===== LLM 配置 =====
OPENAI_API_KEY=<与API服务相同的密钥>
OPENAI_API_BASE=https://api.openai.com/v1
LLM_MODEL_NAME=gpt-3.5-turbo
LLM_FALLBACK_MODEL_NAME=gpt-3.5-turbo
EMBEDDING_MODEL_NAME=text-embedding-ada-002
EMBEDDING_DIMENSION=1536
VISION_MODEL_NAME=gpt-4o-mini

# ===== LLM 容错 =====
LLM_MAX_RETRIES=3
LLM_TIMEOUT=30
LLM_STREAM_FIRST_TOKEN_TIMEOUT=5
CIRCUIT_BREAKER_THRESHOLD=5
CIRCUIT_BREAKER_RECOVERY_TIME=60

# ===== 多 API 降级配置（可选，推荐生产环境启用）=====
# 作用：主 API 不可用时自动切换备用提供者，避免单点故障
# 降级链路：primary → fallback → local_fallback
# 配置文件：app/core/model_provider/providers.yaml
# 优先级：环境变量 > .env > YAML 默认值 > YAML 字面值
LLM_FALLBACK_API_KEY=
LLM_FALLBACK_API_BASE=
LLM_FALLBACK_ENABLED=true
LOCAL_LLM_ENABLED=false
LOCAL_LLM_MODEL=qwen2.5:7b
LOCAL_LLM_BASE=http://localhost:11434/v1
# Embedding 降级（cloud_fallback 提供者，复用 LLM_FALLBACK 配置）
EMBEDDING_FALLBACK_API_KEY=
EMBEDDING_FALLBACK_API_BASE=
EMBEDDING_FALLBACK_MODEL_NAME=
LOCAL_EMBEDDING_ENABLED=false

# ===== 向量检索 =====
SEARCH_TOP_K=4
SIMILARITY_THRESHOLD=0.5
ENABLE_HYBRID_SEARCH=True
KEYWORD_SEARCH_WEIGHT=0.3

# ===== 文档处理 =====
CHUNK_SIZE=500
CHUNK_OVERLAP=50
DOCUMENT_QUALITY_THRESHOLD=60.0
ENABLE_OCR=True
ENABLE_VISION=True
ENABLE_TABLE_EXTRACTION=True

# ===== RAG 优化 =====
ENABLE_INTENT_DETECTION=True
ENABLE_CONFLICT_DETECTION=True
ENABLE_LATEX_PROTECTION=True
CONVERSATION_HISTORY_LIMIT=5
CONVERSATION_HISTORY_MAX_TOKENS=2000
ENABLE_HISTORY_SUMMARY=True
SUMMARY_EVERY_N_TURNS=5

```

### 前端服务

```env
VITE_API_BASE_URL=https://你的后端域名.up.railway.app/api/v1
VITE_APP_TITLE=GeiIt企业知识库
```

---

## 监控与日志

### 日志查看

Railway 自动收集所有服务的标准输出日志。在 Dashboard 中点击对应服务 → **Deployments** → 查看日志。

**生产环境日志格式**：JSON 结构化日志（使用 structlog），每条日志包含：

```json
{
  "event": "应用启动成功！环境: production",
  "level": "info",
  "timestamp": "2026-07-10T12:00:00Z"
}
```

### 健康监控

- **后端健康检查**：`GET /health`（Railway 每 30 秒自动检查）
  - 返回 `status: "healthy"` — 一切正常
  - 返回 `status: "degraded"` — 数据库或 Redis 异常
- **前端健康检查**：`GET /`（nginx 返回 200）

### 可选：启用 Prometheus 监控

1. 在后端环境变量中设置：
   ```env
   ENABLE_PROMETHEUS=True
   PROMETHEUS_AUTH_ENABLED=True
   PROMETHEUS_AUTH_USER=prometheus
   PROMETHEUS_AUTH_PASSWORD=<生成的密码>
   PROMETHEUS_INCLUDE_PATH_LABEL=False
   ```
2. 访问 `https://你的后端域名/metrics`（需 Basic Auth）
3. 将 metrics 端点接入 Grafana / Datadog 等监控系统

> ⚠️ **10D 审查提醒（D3-02）**：`/metrics` 端点默认无认证（`PROMETHEUS_AUTH_ENABLED=False`），**生产环境必须设为 `True`** 并配置 `PROMETHEUS_AUTH_USER` / `PROMETHEUS_AUTH_PASSWORD`，否则指标数据（含请求量、延迟、错误率）将公开暴露。

### 可选：启用 Sentry 错误监控

1. 注册 [Sentry](https://sentry.io) 账号，获取 DSN
2. 在后端环境变量中设置：
   ```env
   ENABLE_SENTRY=True
   SENTRY_DSN=https://your-sentry-dsn@sentry.io/123
   ```

---

## 备份策略

### 数据库备份

Railway 的 PostgreSQL 插件支持自动备份：

1. 进入 PostgreSQL 服务的 **Settings** 标签页
2. 找到 **Backups**，开启自动备份
3. 建议配置：
   - 备份频率：每日一次
   - 保留天数：7–30 天

### 手动备份

```bash
# 导出数据库（使用 Railway 提供的连接信息）
pg_dump "${DATABASE_URL}" > backup_$(date +%Y%m%d).sql

# 恢复数据库
psql "${DATABASE_URL}" < backup_20260710.sql
```

### Redis 备份

Redis 可保存认证吊销、限流和队列等运行时状态；这不是 PostgreSQL 或上传文件的备份。FAQ 答案缓存没有接入问答路径。请按实际 Redis/队列部署策略配置持久化，不要把 AOF 当作数据库备份。

项目现有加密备份与管理员恢复接口、快照验证和恢复预检查，见 [备份与恢复说明](BACKUP_RECOVERY_API.md)。部署者仍需在目标环境验证运行配置、上传文件和数据库的联合恢复，并记录可接受的 RPO/RTO；本页旧版 Railway 指南不代表已完成这些演练。

---

## 回滚流程

### 方式 1：Railway Dashboard 回滚（推荐）

1. 进入服务（API/前端/Worker）的 **Deployments** 标签页
2. 找到上一个正常运行的部署
3. 点击 **Redeploy**（重新部署该版本）

### 方式 2：Git 回滚

```bash
# 回退到上一个 commit
git revert HEAD
git push origin main
# Railway 会自动检测到新 push 并重新部署
```

### 方式 3：数据库回滚

如果数据库迁移导致问题：

```bash
# 回退到上一个 Alembic 迁移版本
alembic downgrade -1

# 回退到指定版本
alembic downgrade <revision_id>

# 查看迁移历史
alembic history
```

> ⚠️ **注意**：数据库回滚可能导致数据丢失，仅在必要时使用。回滚前务必备份数据库。

> ⚠️ **10D 审查提醒（D9-02）**：Railway Dashboard 回滚仅回滚代码，**不自动回滚数据库迁移**。完整的回滚 SOP 应为：
> 1. **先判断**：当前部署是否包含新的 Alembic 迁移？（查看 `alembic history`）
> 2. **如无新迁移**：直接 Railway Dashboard Redeploy 上一个版本即可
> 3. **如有新迁移**：先备份数据库 → Railway 回滚代码 → 手动执行 `alembic downgrade -1` → 验证应用启动正常
> 4. **如 downgrade 失败**（如删列迁移不可逆）：保持当前 schema，修复代码兼容旧 schema 后重新部署

---

## 部署检查清单

部署完成后，逐项确认：

### 基础设施
- [ ] PostgreSQL 服务已创建，pgvector 扩展已启用（`CREATE EXTENSION vector;`）
- [ ] Redis 服务已创建，持久化已启用
- [ ] 后端 API 服务已部署，`/health` 返回 healthy
- [ ] **超级管理员账号已创建**（`python -m scripts.create_superuser`）
- [ ] Celery Worker 服务已部署，日志显示 ready
- [ ] 前端服务已部署，可正常访问
- [ ] **邮件服务（Resend）API Key 已配置**，发件域名已验证
- [ ] **`ADMIN_NOTIFY_EMAIL` 已设置**（接收注册申请通知）

### 环境变量
- [ ] `SECRET_KEY` 已设置（≥32 字符，非弱默认值）
- [ ] `OPENAI_API_KEY` 已设置且有效
- [ ] `DATABASE_URL` 引用 PostgreSQL 服务变量
- [ ] `REDIS_URL` 引用 Redis 服务变量
- [ ] `CELERY_BROKER_URL` 和 `CELERY_RESULT_BACKEND` 已设置
- [ ] `CORS_ORIGINS` 包含前端域名（非通配符 `*`）
- [ ] `ENVIRONMENT=production`，`DEBUG=False`
- [ ] Worker 服务的 `ROLE=worker`
- [ ] **`EMAIL_ENABLED=True`**，`SMTP_PASSWORD` 已设置（Resend API Key）
- [ ] **`FRONTEND_BASE_URL` 指向前端域名**（用于密码设置链接拼接）
- [ ] **`PROMETHEUS_AUTH_ENABLED=True`**（生产环境强制开启 /metrics 认证）
- [ ] Worker 服务也配置了邮件相关变量（与 API 服务一致）

### 功能验证
- [ ] 注册新账号成功
- [ ] 登录获取 Token 成功
- [ ] **管理员账号登录成功**，用户名旁显示"管理员"标签
- [ ] 上传文档后状态变为 completed
- [ ] 问答功能正常（能收到 LLM 回答）
- [ ] 数据导出功能正常（下载 JSON 文件）
- [ ] 账号删除功能正常
- [ ] **注册申请提交后管理员收到通知邮件**
- [ ] **管理员审批后申请人收到密码设置邮件**
- [ ] **密码设置链接可正常打开**，设置密码后可登录

### 安全检查
- [ ] `DEBUG=False`，访问 `/docs` 返回 404
- [ ] `CORS_ORIGINS` 不含通配符 `*`
- [ ] HTTPS 有效（Railway 自动配置）
- [ ] 生产环境启动校验通过（日志无 "配置校验失败" 错误）
- [ ] **`/metrics` 端点需 Basic Auth 认证**（未认证访问返回 401）

---

## 性能调优

### Railway PostgreSQL 调优

Railway 提供 managed PostgreSQL，**不支持**挂载自定义 `postgresql.conf` 或覆盖启动命令。需通过 `ALTER SYSTEM` 逐项设置参数。

**执行方式**：在 Railway Dashboard → PostgreSQL 服务 → **Query** 标签页执行以下 SQL（一次性，持久化到 `postgresql.auto.conf`）：

```sql
-- Railway PostgreSQL 调优脚本
-- 注意：参数值需按 Railway PG 套餐内存调整
-- 共享 1G 套餐示例（Pro 8G 套餐请按比例放大）

-- 内存与缓冲区
ALTER SYSTEM SET shared_buffers = '128MB';           -- RAM 的 25%
ALTER SYSTEM SET effective_cache_size = '384MB';     -- RAM 的 75%
ALTER SYSTEM SET work_mem = '8MB';                   -- 排序/哈希内存
ALTER SYSTEM SET maintenance_work_mem = '64MB';      -- VACUUM/索引构建

-- 查询规划（SSD 优化）
ALTER SYSTEM SET random_page_cost = 1.1;             -- SSD 随机读代价
ALTER SYSTEM SET effective_io_concurrency = 200;     -- SSD 并发 IO

-- 连接与超时
ALTER SYSTEM SET max_connections = 50;               -- 匹配连接池配置
ALTER SYSTEM SET idle_in_transaction_session_timeout = 60000;
ALTER SYSTEM SET statement_timeout = 30000;

-- 慢查询日志
ALTER SYSTEM SET log_min_duration_statement = 1000;  -- 记录 >1s 慢查询

-- 应用配置（部分参数需重启 PG 生效，Railway 会提示）
SELECT pg_reload_conf();
```

> ⚠️ **限制说明**：
> - `shared_buffers`、`max_connections` 等参数需重启 PG 生效（Railway Dashboard → PostgreSQL → Settings → Restart）
> - `max_connections` 不能超过 Railway 套餐上限
> - Railway Redis **不支持** `maxmemory-policy` 配置，已通过应用层 `RedisManager` 的 LRU 兜底

### 连接池 Sizing 建议

Railway 后端服务通常为单实例，DB 连接池配置建议：

| Railway 套餐 | DB_POOL_SIZE | DB_MAX_OVERFLOW | 说明 |
|--------------|--------------|-----------------|------|
| Hobby（512M） | 5 | 10 | 单实例低并发 |
| Pro（1G+） | 10 | 20 | 默认值，多并发 |
| 多实例部署 | 5/实例 | 10/实例 | 避免多实例总连接数超 `max_connections` |

在 Railway 后端服务 → **Variables** 中设置：

```
DB_POOL_SIZE=5
DB_MAX_OVERFLOW=10
DB_POOL_RECYCLE=1800
```

### 冷启动优化

Railway 部署建议设置 `MODEL_EAGER_HEALTH_CHECK=False`（默认值），使应用启动后立即通过健康检查，避免 Railway 误判部署超时。

在 Railway 后端服务 → **Variables** 中设置：

```
MODEL_EAGER_HEALTH_CHECK=False
```

> 💡 健康检查在后台异步启动，不阻塞应用就绪。首轮探测完成前熔断器默认 CLOSED（不熔断），首批请求会触发 `_ensure_initialized()` 懒加载兜底。

### 前端资源加载优化

前端已内置以下优化（无需额外配置）：

1. **API 预连接**：`index.html` 通过 `<link rel="preconnect">` 预连接后端域名，减少首屏 DNS+TLS 握手（~100-200ms）。Vite 构建时自动从 `VITE_API_BASE_URL` 替换占位符。
2. **modulePreload**：移除了不必要的 polyfill（~600 bytes），依赖浏览器原生 `modulepreload` 支持。
3. **路由级懒加载**：除 LoginPage 和 NotFoundPage 外，所有页面使用 `React.lazy()` 按需加载。
4. **静态资源长期缓存**：nginx 配置 `/assets/` 路径 `Cache-Control: public, immutable`，带 hash 文件名支持长期缓存。

---

## 常见问题排查

### Q1：后端部署失败 — 构建错误

**症状**：Railway 构建日志显示 `pip install` 失败

**排查**：
1. 检查 `requirements.txt` 中的依赖版本是否正确
2. 某些包（如 `opencv-python-headless`、`PyMuPDF`）需要系统依赖，Dockerfile 中已安装
3. 确认 Dockerfile 的 builder 阶段包含 `build-essential` 和 `libpq-dev`

### Q2：后端启动失败 — 配置校验不通过

**症状**：日志显示 "生产环境配置校验失败"

**排查**：
1. 检查 `SECRET_KEY` 是否已设置且 ≥32 字符
2. 检查 `OPENAI_API_KEY` 是否非空
3. 检查 `DATABASE_URL` 是否以 `postgresql` 开头（不能是 sqlite）
4. 检查 `CORS_ORIGINS` 是否不含通配符 `*`
5. 检查 `DEBUG` 是否为 `False`

### Q3：前端访问后端 API 报 CORS 错误

**症状**：浏览器控制台显示 `Access-Control-Allow-Origin` 错误

**排查**：
1. 检查后端 `CORS_ORIGINS` 是否包含前端域名（精确匹配，包括协议和端口）
2. 确认 `CORS_ORIGINS` 格式正确：`["https://xxx.up.railway.app"]`
3. 确认前端 `VITE_API_BASE_URL` 指向正确的后端域名
4. 修改 CORS 后需**重新部署后端**才生效

### Q4：文档上传后一直处于 "processing" 状态

**症状**：文档状态卡在 processing，未变为 completed

**排查**：
1. 检查 Worker 服务是否正常运行（日志中是否有 `celery@... ready`）
2. 检查 Worker 的 `CELERY_BROKER_URL` 是否正确指向 Redis
3. 检查 Worker 的 `DATABASE_URL` 是否与 API 服务一致
4. 检查 Worker 日志是否有异常（如 LLM API Key 无效、Embedding 失败）
5. 确认 Worker 的 `OPENAI_API_KEY` 和 `EMBEDDING_MODEL_NAME` 配置正确

### Q5：数据库迁移失败

**症状**：后端启动日志显示 `alembic upgrade head` 失败

**排查**：
1. 检查 `DATABASE_URL` 是否正确
2. 确认 pgvector 扩展已启用：`CREATE EXTENSION vector;`
3. 查看具体错误信息，可能是 PostgreSQL 版本不兼容
4. 手动执行迁移：在 Railway 的 PostgreSQL Query 中运行 `SELECT * FROM alembic_version;` 查看当前版本

### Q6：Worker 内存不足（OOM）

**症状**：Worker 日志显示 `Killed` 或容器频繁重启

**排查**：
1. 降低 `CELERY_WORKER_CONCURRENCY`（如从 2 降到 1）
2. 降低 `CELERY_MAX_TASKS_PER_CHILD`（让 Worker 更频繁重启释放内存）
3. 在 Railway 中升级 Worker 服务的资源限制（RAM）
4. 关闭 `ENABLE_OCR`（OCR 是内存密集型操作）

### Q7：前端构建时 `VITE_API_BASE_URL` 不生效

**症状**：前端构建后仍使用默认 `/api/v1`

**排查**：
1. Vite 构建参数在 Docker 构建阶段注入，需在 Railway 服务的 Variables 中设置
2. 修改变量后需点击 **Redeploy** 触发重新构建
3. 确认变量名拼写正确：`VITE_API_BASE_URL`（不是 `VITE_BASE_URL`）

### Q8：Redis 连接失败

**症状**：后端日志显示 Redis 连接超时或拒绝

**排查**：
1. 检查 `REDIS_URL` 是否正确引用了 Redis 服务变量
2. Railway Redis 的连接地址格式为 `redis://default:password@host:port`
3. 确认 Redis 服务未暂停（Railway 免费版可能自动暂停空闲服务）
4. 检查 `CELERY_BROKER_URL` 和 `CELERY_RESULT_BACKEND` 是否也正确引用了 Redis

### Q9：如何创建超级管理员账号

**症状**：系统没有默认管理员，需要手动创建

**解决方案**：

```bash
# 在 Railway 后端服务的 Shell 中执行
python -m scripts.create_superuser \
  --username admin \
  --email admin@yourcompany.com \
  --password "YourSecure123"
```

详细操作步骤见 [第 4.6 步：创建超级管理员账号](#46-创建超级管理员账号)。

### Q10：如何将已有用户升级为管理员

**症状**：已通过前端注册了账号，需要将其提升为管理员

**解决方案**：

```bash
# 方式 1：使用脚本（推荐）
python -m scripts.create_superuser \
  --username your_username \
  --email your_email@example.com \
  --password "anypassword1" \
  --upgrade-only

# 方式 2：直接 SQL（在 Railway PostgreSQL Query 中）
UPDATE users SET is_superuser = true WHERE username = 'your_username';
```

### Q11：注册申请提交后管理员未收到邮件

**症状**：用户提交注册申请成功，但管理员邮箱未收到通知邮件

**排查**：
1. 检查 `EMAIL_ENABLED` 是否为 `True`（为 `False` 则跳过邮件发送）
2. 检查 `ADMIN_NOTIFY_EMAIL` 是否配置为正确的管理员邮箱
3. 检查 `SMTP_PASSWORD`（Resend API Key）是否有效
4. 检查 Worker 服务是否正常运行（邮件由 Celery Worker 异步发送）
5. 查看 Worker 日志是否有 SMTP 错误（如认证失败、连接超时）
6. 确认 Resend 发件域名是否已验证（未验证域名只能发到 Resend 注册邮箱）
7. 检查 Resend Dashboard → Logs 是否有发送记录和错误详情

### Q12：密码设置链接打开报"Token 无效或已过期"

**症状**：用户点击邮件中的密码设置链接，页面提示 Token 无效或已过期

**排查**：
1. **Token 已过期**：密码设置 Token 有效期 24 小时（`PASSWORD_TOKEN_EXPIRE_HOURS=24`），超时需管理员重新审批
2. **Token 已使用**：密码设置 Token 为一次性使用，已设置过密码的链接不可重复使用
3. **`FRONTEND_BASE_URL` 配置错误**：检查此变量是否正确指向前端域名，链接格式为 `{FRONTEND_BASE_URL}/set-password?token=xxx`
4. **前后端域名不匹配**：邮件中的链接域名必须与前端实际部署域名一致

### Q13：Resend 邮件发送失败（日志显示 SMTP 错误）

**症状**：Worker 日志显示 SMTP 连接失败或认证错误

**排查**：
1. 检查 `SMTP_HOST` 是否为 `smtp.resend.com`
2. 检查 `SMTP_PORT` 是否为 `465`，`SMTP_USE_TLS=True`，`SMTP_START_TLS=False`
3. 检查 `SMTP_USER` 是否为 `resend`（固定值，不是邮箱地址）
4. 检查 `SMTP_PASSWORD` 是否为完整的 Resend API Key（格式 `re_xxxxxxxx`）
5. 检查 `EMAIL_FROM` 的域名是否已在 Resend 验证
6. 检查 Resend 免费额度是否用尽（3000 封/月）
7. 如使用 `onboarding@resend.dev` 发件地址，只能发到 Resend 注册邮箱

### Q14：多副本部署时数据库迁移冲突

**症状**：后端 API 服务配置多副本（replicas > 1）时，部署日志出现 Alembic 迁移冲突错误

**排查**：
1. 确认 `railway.json` 已配置 `releaseCommand: "alembic upgrade head"`（**当前代码已配置**，Railway 会在部署前执行迁移）
2. 确认后端环境变量 `MIGRATE_ON_STARTUP=false`（避免 `entrypoint.sh` 启动时重复迁移）
3. 如果仍出现冲突，检查是否存在多个服务引用同一数据库且未设置 `MIGRATE_ON_STARTUP=false`

**解决方案**：
```json
// railway.json（已配置，无需修改）
"deploy": {
  "releaseCommand": "alembic upgrade head",
  "startCommand": "/app/entrypoint.sh"
}
```

```bash
# 后端环境变量（必须设置）
MIGRATE_ON_STARTUP=false
```

> ✅ **当前状态**：`railway.json` 已配置 `releaseCommand`，`entrypoint.sh` 已支持 `MIGRATE_ON_STARTUP` 环境变量跳过迁移。只需确保环境变量正确设置即可，**无需修改代码**。

### Q15：访问 `/metrics` 返回 422 VALIDATION_ERROR

**症状**：访问 `https://你的后端域名/metrics` 返回 `422 Unprocessable Entity`，错误信息含 `VALIDATION_ERROR`

**原因**：旧版本代码中 `/metrics` 端点使用 `Depends(None)`（当 `PROMETHEUS_AUTH_ENABLED=False` 时），FastAPI 会将 `None` 解析为查询参数，导致 422 验证错误

**排查**：
1. 确认后端代码版本已包含 P-02 修复（[metrics.py](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/kb_qa_system/backend/app/api/routes/metrics.py) 中使用 `Depends(_security)` 而非 `Depends(None)`）
2. 确认 `ENABLE_PROMETHEUS=True`（默认 `False`，未启用时返回 404 是正常行为）

**解决方案**：
- 如代码版本过旧，更新到最新版本（P-02 已修复此问题）
- 如已更新仍报错，检查 `PROMETHEUS_AUTH_ENABLED` 配置：
  ```bash
  # Railway
  railway variables | grep PROMETHEUS
  # 确认 ENABLE_PROMETHEUS=True
  # 如需认证：PROMETHEUS_AUTH_ENABLED=True + 设置用户名密码
  ```

> 📖 P-02 修复详情见 [问题分级处理报告.md](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/docs/问题分级处理报告.md)

### Q16：Celery Worker 启动时出现 broker_connection_retry 弃用警告

**症状**：Worker 启动日志出现 `connection_retry` 相关的 DeprecationWarning

**原因**：Celery 5.4+ 弃用了 `broker_connection_retry`，Celery 6.0 将完全移除

**解决方案**：
- 当前代码已在 [celery_app.py](file:///c:/Users/DOXIA/Desktop/企业知识库问答系统/kb_qa_system/backend/app/core/celery_app.py) 中设置 `broker_connection_retry_on_startup = True`（P-04 修复）
- 如仍出现警告，确认 Celery 版本 ≥ 5.4，并检查代码是否包含该配置

---

## 附录：项目架构速查

```
kb_qa_system/
├── backend/                    # 后端
│   ├── app/
│   │   ├── main.py            # FastAPI 入口（日志配置、生命周期、路由注册）
│   │   ├── core/              # 核心配置（config/database/redis/security/celery）
│   │   ├── api/routes/        # API 路由（auth/documents/chat/stats/metrics）
│   │   ├── models/            # 数据模型（user/document/conversation/document_chunk）
│   │   ├── schemas/           # Pydantic 数据验证 Schema
│   │   ├── services/          # 业务逻辑（RAG/文档处理/LLM 容错等）
│   │   ├── tasks/             # Celery 异步任务（文档处理流水线）
│   │   └── middleware/        # 中间件（Prometheus 监控）
│   ├── alembic/               # 数据库迁移脚本
│   ├── Dockerfile             # 后端镜像（多阶段构建，含 Tesseract OCR）
│   ├── railway.json           # Railway 部署配置
│   ├── entrypoint.sh          # 启动脚本（ROLE=api/worker/flower）
│   ├── requirements.txt       # Python 依赖
│   └── .env.example           # 环境变量模板
│
├── frontend/                   # 前端
│   ├── src/
│   │   ├── api/               # API 客户端（封装 fetch 请求）
│   │   ├── components/        # React 组件（common/auth/chat/documents/settings）
│   │   ├── pages/             # 页面（Login/Documents/Chat/Settings/Privacy/Terms）
│   │   ├── store/             # Zustand 状态管理（auth/document/chat/toast）
│   │   ├── types/             # TypeScript 类型定义
│   │   └── utils/             # 工具函数（constants/validate/format/fileType）
│   ├── public/                # 静态资源（robots.txt 等）
│   ├── Dockerfile             # 前端镜像（node 构建 → nginx 运行）
│   ├── railway.json           # Railway 部署配置
│   ├── nginx.conf             # nginx 配置（SPA 路由 + 缓存 + 安全头）
│   └── package.json           # Node 依赖
│
└── docs/                      # 文档
    ├── RAILWAY_DEPLOYMENT_GUIDE.md   # 本文件（Railway 部署指南）
    ├── LOCAL_DEPLOYMENT_GUIDE.md     # 本地部署指南
    ├── COMPREHENSIVE_REVIEW_10D.md   # 十维度代码审查报告（最新）
    ├── COMPREHENSIVE_REVIEW_8D.md    # 八维度代码审查报告
    ├── EMAIL_SYSTEM_REVIEW.md        # 邮件系统安全审查
    ├── P0_FIX_REPORT.md              # P0 修复报告
    └── PHASE_E_REPAIR_REPORT.md      # Phase E 修复报告
```

---

## 技术支持

如部署过程中遇到问题：

1. 查看 Railway 部署日志（Dashboard → 对应服务 → Deployments）
2. 查看本指南的 [常见问题排查](#常见问题排查) 章节
3. 检查后端 `/health` 端点返回的具体错误信息
4. 确认所有环境变量已正确配置（参考 [环境变量完整参考](#环境变量完整参考)）

---

*本指南最后更新：2026-07-11 | GeiIt企业知识库 v1.0.0*
