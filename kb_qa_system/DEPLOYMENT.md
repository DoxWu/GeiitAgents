# 部署指南

> 当前首发部署选型、资源规划、Railway 与 Sealos 的取舍、发布门禁和恢复要求，以 [部署选型与上线准备建议](../docs/DEPLOYMENT_SELECTION_RECOMMENDATION_2026-10-03.md) 为准。本文件保留本地 Compose 和 Railway 的操作细节；它不代表已经完成线上部署或真实供应商联调。

本文档说明GeiIt企业知识库的本地开发环境启动和 Railway 生产部署流程。

---

## 一、本地开发环境（docker-compose）

一键启动 PostgreSQL+pgvector、Redis、FastAPI、Celery Worker、Flower 全套服务。

### 1. 准备配置

```bash
cd kb_qa_system/backend
cp .env.example .env
# 编辑 .env，至少修改：
#   SECRET_KEY     → 随机长字符串
#   ALIYUN_API_KEY / ALIYUN_API_BASE / ALIYUN_LLM_MODEL / ALIYUN_EMBEDDING_MODEL
#   DEEPSEEK_API_KEY / DEEPSEEK_API_BASE / DEEPSEEK_LLM_MODEL
```

### 2. 启动全部服务

```bash
cd kb_qa_system
docker-compose up -d
```

### 3. 访问地址

| 服务      | 地址                       | 说明                  |
| --------- | -------------------------- | --------------------- |
| API 文档  | http://localhost:8000/docs | Swagger UI            |
| 健康检查  | http://localhost:8000/health | 服务存活探活         |
| Flower    | http://localhost:5555      | Celery 任务监控面板   |
| PostgreSQL | localhost:5432            | 数据库（postgres/postgres） |
| Redis     | localhost:6379            | 缓存                  |

### 4. 常用命令

```bash
docker-compose up -d          # 后台启动
docker-compose logs -f api    # 查看 API 日志
docker-compose logs -f worker # 查看 Worker 日志
docker-compose down           # 停止（保留数据）
docker-compose down -v        # 停止并清空数据
docker-compose build          # 重新构建镜像
```

> 开发模式下 `./backend` 挂载进容器，代码修改后 API 需重启容器，Worker 默认不自动重载。

---

## 二、Railway 生产部署

Railway 部署后端 API、Celery Worker 两个服务，外加 Railway 提供的 PostgreSQL 和 Redis 插件。

### 1. 创建 Railway 项目并添加插件

1. 登录 [Railway](https://railway.app)，新建项目。
2. 添加 **PostgreSQL** 插件（Railway 自动注入 `DATABASE_URL`、`PGHOST` 等）。
3. 添加 **Redis** 插件（Railway 自动注入 `REDIS_URL`、`REDIS_PRIVATE_DOMAIN` 等）。

> Railway 的 PostgreSQL 默认不含 pgvector 扩展。需在插件创建后，进入 PostgreSQL 的 **Query** 面板执行：
> ```sql
> CREATE EXTENSION IF NOT EXISTS vector;
> CREATE EXTENSION IF NOT EXISTS pg_trgm;
> ```
> 若 Railway PostgreSQL 版本不支持 pgvector，可改用自带 pgvector 的数据库服务（如 Supabase / Neon）。

### 2. 部署后端服务（API）

1. 在项目中 **New Service → GitHub Repo**，选择本仓库。
2. **Settings → Root Directory** 设为 `kb_qa_system/backend`（railway.json 所在目录）。
3. Railway 会自动识别 `railway.json`，用 Dockerfile 构建并启动。
4. 在 **Variables** 中配置环境变量（见下表），关键变量：
   - `ROLE=api`
   - `ENVIRONMENT=production`
   - `DEBUG=False`
   - `SECRET_KEY=<随机长字符串>`
   - `OPENAI_API_KEY=<你的 Key>`
   - `DATABASE_URL` → 引用 PostgreSQL 插件变量 `${{Postgres.DATABASE_URL}}`
   - `REDIS_URL` → 引用 Redis 插件变量 `${{Redis.REDIS_URL}}`
   - `CELERY_BROKER_URL` → `${{Redis.REDIS_URL}}`
   - `CELERY_RESULT_BACKEND` → `${{Redis.REDIS_URL}}`
5. **Settings → Networking → Generate Domain** 生成公网域名。
6. 部署完成后访问 `https://<你的域名>/health` 验证。

> 启动时 `entrypoint.sh` 会自动执行 `alembic upgrade head` 完成数据库迁移。

### 3. 部署 Celery Worker 服务

1. 在同一 Railway 项目中 **New Service → GitHub Repo**，选择同一仓库。
2. **Root Directory** 同样设为 `kb_qa_system/backend`。
3. **Variables** 中配置：
   - `ROLE=worker`
   - 与 API 相同的 `DATABASE_URL`、`REDIS_URL`、`CELERY_BROKER_URL`、`OPENAI_API_KEY` 等
   - `CELERY_WORKER_CONCURRENCY=2`
4. Worker 不需要暴露端口，不需要 Generate Domain。

### 4. 环境变量完整清单

参考 `backend/.env.example`，生产环境至少配置：

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `ENVIRONMENT` | 运行环境 | `production` |
| `DEBUG` | 调试模式 | `False` |
| `SECRET_KEY` | JWT 密钥 | 随机 32+ 字符 |
| `DATABASE_URL` | PostgreSQL 连接串 | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | Redis 连接串 | `${{Redis.REDIS_URL}}` |
| `CELERY_BROKER_URL` | Celery broker | `${{Redis.REDIS_URL}}` |
| `CELERY_RESULT_BACKEND` | Celery 结果后端 | `${{Redis.REDIS_URL}}` |
| `ALIYUN_API_KEY` | 阿里云主 LLM/Embedding Key | 由部署密钥管理器注入 |
| `ALIYUN_API_BASE` | 阿里云兼容 API 基址 | 按账号地域填写 |
| `ALIYUN_LLM_MODEL` | 阿里云主 LLM 模型名 | 由部署者选择 |
| `ALIYUN_EMBEDDING_MODEL` | 阿里云向量模型名 | 由部署者选择 |
| `DEEPSEEK_API_KEY` | DeepSeek 备用文本模型 Key | 由部署密钥管理器注入 |
| `DEEPSEEK_API_BASE` | DeepSeek 兼容 API 基址 | `https://api.deepseek.com/v1` |
| `DEEPSEEK_LLM_MODEL` | DeepSeek 备用文本模型名 | 由部署者选择 |
| `EMBEDDING_DIMENSION` | 向量输出维度 | 必须匹配所选模型与数据库列 |
| `CORS_ORIGINS` | 允许的前端域名 | `["https://你的前端域名.vercel.app"]` |

> `CORS_ORIGINS` 需配置为 Vercel 前端域名，否则前端无法调用 API。

### 5. 角色化部署说明

镜像通过 `ROLE` 环境变量区分启动角色：

| ROLE | 说明 | 启动命令 |
| --- | --- | --- |
| `api` | FastAPI 服务（含自动迁移） | `alembic upgrade head && uvicorn app.main:app` |
| `worker` | Celery Worker（异步任务） | `celery -A app.core.celery_app worker` |
| `flower` | Flower 监控（可选） | `celery -A app.core.celery_app flower` |

---

## 三、前端部署（Vercel）

前端代码就绪后：

1. 在 Vercel 导入 GitHub 仓库，Root Directory 设为前端目录。
2. 配置环境变量 `VITE_API_BASE_URL`（或 `NEXT_PUBLIC_API_BASE_URL`）为 Railway 后端域名。
3. 部署后将 Vercel 域名加入后端 `CORS_ORIGINS`。

本地开发可使用 `frontend/.env.example` 中的非敏感 Vite 配置。若部署 Nginx 容器，请在前端容器环境配置 `PUBLIC_CONTACT_EMAIL` 和经运营方核实的 `PUBLIC_*` 隐私说明；这些值会公开给访问者，邮箱留空时帮助页和隐私页不显示 mailto 链接。真实 provider/邮件验收步骤见 [A28 验收说明](../docs/A28_PROVIDER_ACCEPTANCE.md)。

---

## 四、故障排查

| 问题 | 排查方向 |
| --- | --- |
| 容器启动失败 | `docker-compose logs <服务名>` 查看错误 |
| 数据库连接失败 | 检查 `DATABASE_URL`、PostgreSQL 是否健康 |
| Redis 连接失败 | 检查 `REDIS_URL`、Redis 是否健康 |
| OCR 不工作 | 容器内执行 `tesseract --list-langs`，应包含 `chi_sim` |
| 迁移失败 | 手动执行 `alembic upgrade head` 查看详细错误 |
| pgvector 报错 | 确认数据库已执行 `CREATE EXTENSION vector;` |
