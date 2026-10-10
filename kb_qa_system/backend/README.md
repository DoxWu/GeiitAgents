# GeiIt企业知识库 - 后端

> GeiIt 企业知识库服务端的开发说明。代码能力、部署模板和本地测试不表示目标线上环境已完成配置或验收。

## 📋 项目简介

本系统是一个面向企业场景的 RAG 问答后端，核心特性包括：

- 📄 **多格式文档处理**：PDF、Markdown、Word、TXT、网页导入；图片 OCR 受 Tesseract 二进制、语言包和解析路径限制，不保证所有扫描 PDF 均可识别
- 🔍 **混合检索**：pgvector 向量检索 + 关键词全文检索 + 重排序（Reranker）
- 🤖 **RAG 问答**：基于知识库的智能问答，附带引用来源
- 💬 **流式输出**：SSE 实时返回，打字机效果
- 📝 **多轮对话**：上下文追问 + 记忆衰退（历史摘要）
- 🎯 **意图识别**：闲聊/追问/元问题走无检索路径，避免误拦截
- 🛡️ **权限隔离**：用户只能检索自己授权的文档（个人库 + 公共库）
- 🔒 **安全加固**：JWT 双 Token + 黑名单、限流、幂等、SSRF 防护、异常脱敏
- ⚡ **异步处理**：Celery 任务队列处理文档解析与向量化
- 📊 **质量监控**：Prometheus 指标 + Grafana 看板 + QA 质量埋点
- 🔁 **容错降级**：LLM 重试 + 熔断器 + 多级降级 + 流式部分保存

## 🏗️ 项目结构

```
kb_qa_system/
├── docker-compose.yml              # 本地开发编排（PostgreSQL+pgvector / Redis / API / Worker / Flower）
├── docs/                           # Sealos 部署与备份恢复参考
├── monitoring/                     # Prometheus + Grafana 监控栈
│   ├── docker-compose.monitoring.yml
│   ├── prometheus.yml
│   ├── alerts.yml
│   └── grafana/                    # 数据源、仪表盘自动供给
└── backend/
    ├── app/
    │   ├── main.py                 # 主应用入口（生命周期 / 路由注册 / 异常处理）
    │   ├── core/                   # 核心基础设施
    │   │   ├── config.py           # 配置管理（Pydantic Settings + 生产校验）
    │   │   ├── database.py         # SQLAlchemy 引擎与会话
    │   │   ├── redis.py            # Redis 管理器（缓存/限流/分布式锁）
    │   │   ├── security.py         # JWT 双 Token + 黑名单 + bcrypt
    │   │   ├── rate_limit.py       # 限流 + 登录锁定（fail-closed）
    │   │   ├── celery_app.py       # Celery 应用与任务状态查询
    │   │   ├── circuit_breaker.py  # 熔断器
    │   │   ├── url_validator.py    # SSRF 防护（URL 安全校验）
    │   │   └── prometheus_metrics.py # Prometheus 指标定义
    │   ├── middleware/
    │   │   └── prometheus_middleware.py # HTTP 请求指标采集中间件
    │   ├── models/                 # ORM 模型
    │   │   ├── user.py             # 用户
    │   │   ├── document.py         # 文档（含可见性 visibility）
    │   │   ├── document_chunk.py   # 文档分块
    │   │   ├── conversation.py     # 对话与消息
    │   │   └── qa_event.py         # QA 质量埋点
    │   ├── schemas/                # Pydantic 数据验证
    │   │   ├── user.py / document.py / chat.py
    │   ├── api/
    │   │   ├── deps.py             # 依赖注入（当前用户 / 超级管理员）
    │   │   └── routes/
    │   │       ├── auth.py         # 认证（注册/登录/刷新/登出/me）
    │   │       ├── documents.py    # 文档管理（上传/列表/详情/删除/重处理/URL导入/任务状态/统计）
    │   │       ├── chat.py         # 对话问答（提问/流式/对话列表/详情/删除）
    │   │       ├── stats.py        # 质量看板（仅管理员）
    │   │       └── metrics.py      # Prometheus /metrics 端点
    │   ├── services/               # 业务服务层
    │   │   ├── rag_chain.py        # RAG 检索链路（核心问答编排）
    │   │   ├── vector_store.py     # pgvector 向量存储
    │   │   ├── document_processor.py # 文档处理入口
    │   │   ├── document_pipeline/  # 文档处理流水线
    │   │   │   ├── pipeline.py     # 流水线编排
    │   │   │   ├── parsers.py      # 多格式解析器
    │   │   │   ├── pdf_parser.py   # PDF 版面分析
    │   │   │   ├── table_extractor.py # 表格结构化提取
    │   │   │   ├── image_processor.py # 图像处理
    │   │   │   ├── cleaner.py      # 文本清洗
    │   │   │   ├── chunker.py      # 分块（LaTeX 公式保护）
    │   │   │   ├── latex_protector.py # LaTeX 公式保护器
    │   │   │   ├── quality_scorer.py # 质量评分
    │   │   │   └── context.py      # 流水线上下文
    │   │   ├── llm_resilience.py   # LLM 容错（重试/熔断/降级）
    │   │   ├── history_service.py  # 对话历史 + 摘要生成
    │   │   ├── intent_service.py   # 意图切换检测
    │   │   ├── intent_classifier.py # 意图分类
    │   │   ├── query_rewrite.py    # 查询改写
    │   │   ├── reranker.py         # 重排序
    │   │   ├── conflict_detector.py # 矛盾检测
    │   │   ├── pre_generation_validator.py # 流式预生成校验
    │   │   ├── permission.py       # 文档权限服务
    │   │   └── qa_event_service.py # QA 质量埋点服务
    │   └── tasks/
    │       └── document_tasks.py   # Celery 文档处理任务
    ├── alembic/                    # 数据库迁移
    │   ├── env.py
    │   └── versions/               # 迁移脚本（含 pgvector 索引）
    ├── scripts/
    │   └── init-db.sql             # pgvector 扩展与全文检索初始化
    ├── tests/                      # 测试（Critical / Phase C 修复验证）
    ├── Dockerfile                  # 容器镜像（api/worker/beat/flower 等角色）
    ├── entrypoint.sh               # 容器入口（按 ROLE 启动不同服务）
    ├── railway.json                # Railway 部署配置（入口自动检查迁移）
    ├── alembic.ini
    ├── requirements.txt
    ├── .env.example
    └── README.md
```

## 🚀 快速开始

### 方式一：Docker Compose 一键启动（推荐）

完整的开发环境编排位于 [`kb_qa_system/docker-compose.yml`](../docker-compose.yml)，包含 PostgreSQL+pgvector、Redis、FastAPI API、Celery Worker、Flower。

```bash
# 1. 进入项目根目录
cd kb_qa_system

# 2. 复制环境变量示例文件并配置
cp backend/.env.example backend/.env
# 编辑 backend/.env，至少填入 OPENAI_API_KEY 和 SECRET_KEY

# 3. 一键启动全部服务
docker-compose up -d

# 4. 查看日志
docker-compose logs -f api

# 5. 停止 / 清空数据
docker-compose down
docker-compose down -v   # ⚠️ 会删除所有数据
```

启动后可访问：

| 服务 | 地址 | 说明 |
|------|------|------|
| API 服务 | http://localhost:8000 | FastAPI 后端 |
| Swagger 文档 | http://localhost:8000/docs | API 交互式文档（仅 DEBUG 模式） |
| 健康检查 | http://localhost:8000/health | 服务探活 |
| Flower 监控 | http://localhost:5555 | Celery 任务面板 |
| Prometheus 指标 | http://localhost:8000/metrics | 需 `ENABLE_PROMETHEUS=True` |

> 监控栈（Prometheus + Grafana + Alertmanager）独立编排，详见 [monitoring/README.md](../monitoring/README.md)：
> ```bash
> docker-compose -f docker-compose.yml -f monitoring/docker-compose.monitoring.yml up -d
> ```

### 方式二：本地开发（不使用 Docker）

适用于二次开发调试，需自行准备 PostgreSQL（含 pgvector 扩展）和 Redis。

```bash
cd backend

# 1. 安装依赖
pip install -r requirements.txt

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env：DATABASE_URL、REDIS_URL、OPENAI_API_KEY、SECRET_KEY

# 3. 初始化数据库（执行 pgvector 扩展 + 迁移）
psql $DATABASE_URL -f scripts/init-db.sql
alembic upgrade head

# 4. 启动 API 服务（开发模式自动重载）
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 5. 另起终端启动 Celery Worker（异步文档处理）
celery -A app.tasks.celery_app worker --loglevel=info
```

## 📚 API 接口

所有业务接口前缀为 `/api/v1`，`/metrics` 和 `/health` 位于根路径。

### 认证相关

| 方法 | 路径 | 说明 | 限流 |
|------|------|------|------|
| POST | `/api/v1/auth/register` | 用户注册 | 5 次/小时 |
| POST | `/api/v1/auth/login` | 登录（返回 Access + Refresh Token） | 5 次/分钟 |
| POST | `/api/v1/auth/refresh` | 刷新 Access Token（Token 轮换） | 10 次/分钟 |
| POST | `/api/v1/auth/logout` | 登出（双 Token 拉黑） | — |
| GET | `/api/v1/auth/me` | 获取当前用户信息 | — |

### 文档管理

| 方法 | 路径 | 说明 | 限流 |
|------|------|------|------|
| POST | `/api/v1/documents/upload` | 上传文档（触发异步处理） | 20 次/小时 |
| POST | `/api/v1/documents/import-url` | 从 URL 导入文档（含 SSRF 防护） | 20 次/小时 |
| GET | `/api/v1/documents` | 文档列表（分页 + 权限范围 scope） | — |
| GET | `/api/v1/documents/{id}` | 文档详情 | — |
| DELETE | `/api/v1/documents/{id}` | 删除文档（软删除） | — |
| POST | `/api/v1/documents/{id}/reprocess` | 重新处理文档 | — |
| GET | `/api/v1/documents/{id}/task-status` | 查询处理任务状态 | — |
| GET | `/api/v1/documents/stats/overview` | 文档统计概览 | — |

### 对话问答

| 方法 | 路径 | 说明 | 限流 |
|------|------|------|------|
| POST | `/api/v1/chat/ask` | 提问（非流式，支持幂等） | 20 次/分钟 |
| POST | `/api/v1/chat/ask/stream` | 提问（流式 SSE） | 20 次/分钟 |
| GET | `/api/v1/chat/conversations` | 对话列表 | — |
| GET | `/api/v1/chat/conversations/{id}` | 对话详情 | — |
| DELETE | `/api/v1/chat/conversations/{id}` | 删除对话 | — |

### 质量看板（仅超级管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/stats/overview` | 质量总体概览 |
| GET | `/api/v1/stats/timeline` | 质量时间趋势（按天） |
| GET | `/api/v1/stats/models` | 模型使用分布 |
| GET | `/api/v1/stats/degradation` | 降级原因分布 |

### 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/metrics` | Prometheus 指标（可选 Basic Auth） |

## 🔧 技术栈

| 分类 | 技术 | 用途 |
|------|------|------|
| Web 框架 | FastAPI + Uvicorn | 异步 API 服务 |
| 数据库 | PostgreSQL 16 + pgvector | 主库 + 向量存储 |
| ORM | SQLAlchemy 2.0 + Alembic | 数据模型与迁移 |
| 缓存/队列 | Redis 7 | 缓存 + 限流 + 分布式锁 + Celery Broker |
| 异步任务 | Celery + Flower | 文档处理流水线 |
| RAG 框架 | LangChain | 检索增强生成编排 |
| LLM | OpenAI 兼容接口 | 支持 OpenAI / 智谱 / Ollama |
| 文档解析 | PyMuPDF / pdfplumber / python-docx / pypdf / pytesseract | 多格式；图片 OCR 依赖系统 Tesseract 和语言包 |
| 认证 | python-jose 3.4.0 + passlib | JWT 双 Token + bcrypt |
| 监控 | prometheus-client + structlog + Sentry | 指标 + 日志 + 错误追踪 |
| 部署 | Docker Compose + Sealos templates | 模板不是部署验收证明 |

## 📖 核心流程

### RAG 问答流程

```
用户提问
   ↓
1. 幂等检查（Redis 锁 + 结果缓存，防重复提交）
   ↓
2. 保存用户问题并提交事务（释放 DB 连接供 LLM 调用期间使用）
   ↓
3. 意图识别（闲聊/追问/元问题 → 跳过检索；知识库查询 → 走检索）
   ↓
4. 获取有效历史（近期对话 + 历史摘要，记忆衰退）
   ↓
5. 查询改写 + 向量检索（pgvector）+ 关键词检索 + 重排序
   ↓
6. 流式预生成校验（结果为空/过短/低分 → 降级，避免幻觉）
   ↓
7. 调用 LLM 生成回答（含重试 + 熔断 + 降级）
   ↓
8. 保存 AI 回答 + 更新对话轮数 + 记录 QA 质量埋点
   ↓
9. 返回答案 + 引用来源（流式 SSE 或一次性返回）
```

### 文档处理流程（Celery 异步）

```
上传文件 / URL 导入
   ↓
1. 文件校验（类型白名单 + 路径遍历防护 + 分块写入防 OOM）
   ↓
2. 创建数据库记录 + 触发 Celery 任务
   ↓
3. [Celery Worker] 解析文本（PDF 版面分析 / OCR / 表格提取）
   ↓
4. 文本清洗 + LaTeX 公式保护
   ↓
5. 分块（chunk，保护公式边界）
   ↓
6. 质量评分（低质量文档标记 low_quality）
   ↓
7. 向量化（Embedding）+ 入库 pgvector（幂等，防重复）
   ↓
8. 更新文档状态为 completed
```

## 🛡️ 安全特性

| 特性 | 说明 |
|------|------|
| JWT 双 Token | Access Token（15 分钟）+ Refresh Token（7 天），刷新时轮换 |
| Token 黑名单 | 登出后 Token 立即失效，Redis fail-closed 防绕过 |
| 登录锁定 | 连续失败 5 次锁定 15 分钟，时序攻击防护 |
| 全局限流 | 登录/注册/上传/提问/刷新均有独立限流配额 |
| 幂等性 | 提问接口支持 `idempotency_key`，防重复 LLM 调用 |
| SSRF 防护 | URL 导入校验协议/IP/端口，阻止访问内网 |
| 路径遍历防护 | 上传文件名清洗，剥离路径前缀 |
| 权限隔离 | 用户只能检索个人库 + 公共库文档，模型检索强制 user_id 限定 |
| 异常脱敏 | 不向客户端返回 `str(exc)`，error_message 仅存错误类型 |
| 分布式锁 | UUID + Lua 脚本原子释放，防误删他人锁 |
| DEBUG 保护 | 生产环境关闭 `/docs`、`/openapi.json`，SECRET_KEY 启动校验 |

## 📊 监控与运维

- **Prometheus 指标**：HTTP 请求量/延迟、RAG 全链路耗时、LLM 调用耗时、检索耗时、文档处理进度
- **Grafana 看板**：[`monitoring/grafana/dashboards/rag_dashboard.json`](../monitoring/grafana/dashboards/rag_dashboard.json) 自动供给
- **告警规则**：[`monitoring/alerts.yml`](../monitoring/alerts.yml)（高错误率、熔断触发、P95 延迟等）
- **Flower**：Celery 任务实时监控 http://localhost:5555
- **QA 质量埋点**：每次问答记录到 `qa_events` 表，看板展示成功率/降级率/模型分布

## 🚢 部署

部署参考见 [`../docs/Sealos部署指导.md`](../docs/Sealos部署指导.md) 与 [`../docs/SEALOS_RECOVERY_AND_BACKUP.md`](../docs/SEALOS_RECOVERY_AND_BACKUP.md)。旧 Railway 配置仍在仓库中，但不代表当前生产平台或线上状态：

- **迁移**：先在隔离环境验证备份与迁移兼容性；不要把启动迁移视为回滚方案
- **调度**：同一数据库和队列只应运行一个 Beat 实例；确认 Worker 和调度器健康
- **代理**：仅配置实际可信代理网段，不使用 `*` 信任任意转发头
- **供应商**：provider、SMTP/TLS 和隐私告知须由部署运营方按实际接收方核实

## 🔧 配置说明

完整配置项见 [`.env.example`](.env.example)，关键配置：

```env
# 必填
SECRET_KEY=<至少32字符随机串>      # 生成：python -c "import secrets; print(secrets.token_urlsafe(32))"
OPENAI_API_KEY=sk-xxx
DATABASE_URL=postgresql+psycopg://...
REDIS_URL=redis://...

# 服务端模型 provider（具体兼容性、维度及端点行为须逐家验证）
OPENAI_API_BASE=https://api.openai.com/v1
LLM_MODEL_NAME=gpt-3.5-turbo
EMBEDDING_MODEL_NAME=text-embedding-ada-002

# 可信代理 CIDR（逗号分隔；仅填写实际代理网段）
TRUSTED_PROXIES=127.0.0.1,::1
```

## 🧪 测试

```bash
cd backend
python -m pytest tests/ -v --tb=short
```

测试覆盖 Critical 修复（C-1 ~ C-11）与 Phase C 修复验证，详见 [`tests/test_critical_fixes.py`](tests/test_critical_fixes.py) 和 [`tests/test_phase_c_fixes.py`](tests/test_phase_c_fixes.py)。

## 📁 相关文档

- [Sealos 部署参考](../docs/Sealos部署指导.md)
- [备份恢复边界](../docs/SEALOS_RECOVERY_AND_BACKUP.md)
- [监控栈说明 monitoring/README.md](../monitoring/README.md)
- [仓库审查报告](../../docs/COMPREHENSIVE_REVIEW_2026-10-10.md)
- [修复实施跟踪](../../docs/REVIEW_REMEDIATION_2026-10-10.md)
- [发布与 Schema 安全说明](../../docs/RELEASE_AND_SCHEMA_SAFETY.md)
