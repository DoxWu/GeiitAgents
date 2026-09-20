# GeiIt 企业知识库 — 后端架构文档

> M-20: 本文档为 docs 目录充实产出，系统化记录后端架构、模块职责与关键设计决策，
> 便于团队协作、新人上手与运维排查。

## 1. 系统概览

GeiIt 企业知识库是一个基于 RAG（检索增强生成）的企业级问答系统，支持文档上传、
向量化检索、流式问答、多轮对话等核心能力。后端采用 FastAPI 异步框架，结合 Celery
执行异步文档处理任务，PostgreSQL + pgvector 提供向量存储，Redis 提供缓存与分布式锁。

### 技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| Web 框架 | FastAPI | 异步 API，自动生成 OpenAPI 文档 |
| 任务队列 | Celery | 文档解析、向量化等耗时任务异步执行 |
| 数据库 | PostgreSQL + pgvector | 关系数据 + 向量索引 |
| 缓存/锁 | Redis | 会话缓存、幂等锁、熔断器状态共享 |
| ORM | SQLAlchemy 2.0 | 异步 Session，支持类型推断 |
| 迁移 | Alembic | 数据库版本管理 |
| 部署 | Railway / Docker | 容器化部署，支持弹性伸缩 |

## 2. 目录结构

```
backend/
├── app/
│   ├── main.py                 # FastAPI 应用入口、中间件、路由注册
│   ├── core/                   # 核心基础设施
│   │   ├── config.py           # 配置管理（Pydantic Settings）
│   │   ├── security.py         # JWT、密码哈希
│   │   ├── database.py         # 数据库连接与 Session 工厂
│   │   ├── redis_manager.py    # Redis 封装、分布式锁
│   │   ├── circuit_breaker.py  # 熔断器（M-24 线程安全）
│   │   └── url_validator.py    # SSRF 防护（C-1 重定向校验）
│   ├── api/routes/             # API 路由层
│   │   ├── auth.py             # 认证（注册、登录、密码重置）
│   │   ├── documents.py        # 文档管理（上传、导入、批量操作）
│   │   ├── chat.py             # 问答（流式/非流式、多轮对话）
│   │   └── stats.py            # 统计分析
│   ├── models/                 # SQLAlchemy 数据模型
│   ├── schemas/                # Pydantic 请求/响应 Schema
│   ├── services/               # 业务逻辑层
│   │   ├── rag_chain.py        # RAG 检索链（M-13 单例线程安全）
│   │   ├── llm_resilience.py   # LLM 调用熔断与重试
│   │   ├── document_pipeline/  # 文档处理流水线
│   │   └── intent_service.py   # 意图识别与查询改写
│   ├── tasks/                  # Celery 异步任务
│   └── utils/                  # 工具函数（响应封装 M-19 等）
├── tests/                      # 测试套件
├── alembic/                    # 数据库迁移
└── docs/                       # 项目文档（M-20）
```

## 3. 核心流程

### 3.1 文档处理流水线

```
用户上传/URL导入 → 幂等校验(M-1/M-2) → Celery 任务异步执行
→ 解析(PDF/DOCX/Markdown/TXT/URL) → 清洗 → 分块 → 向量化 → 存入 pgvector
```

- **解析器**：`document_pipeline/parsers.py` 按 MIME 类型分发
- **SSRF 防护**：URL 导入禁用自动重定向（C-1），手动校验每个重定向目标
- **幂等性**：上传哈希去重 + Redis 分布式锁防止 TOCTOU（M-2）

### 3.2 问答检索流程

```
用户提问 → 意图识别 → 查询改写 → 关键词+向量混合检索 → 重排序
→ 上下文组装（按用户文档权限过滤 M-3）→ LLM 流式生成 → 会话缓存
```

- **权限隔离**：检索严格限制在用户授权的文档库（M-3 无 user_id 时拒绝检索）
- **熔断保护**：LLM/Embedding 调用经熔断器，失败时降级到 fallback provider
- **流式响应**：SSE 推送，独立 Session 处理后持久化避免失效问题

## 4. 安全设计

| 编号 | 措施 | 说明 |
|------|------|------|
| C-1 | SSRF 重定向防护 | 禁用自动重定向，手动校验目标 URL |
| C-2 | 幂等锁异常释放 | 流式接口 except 块释放锁（H-2 token 比对） |
| M-3 | 检索权限隔离 | 无 user_id 拒绝检索，防止越权 |
| M-4 | 管理员审计日志 | 超级管理员操作记录 |
| M-23 | MIME 类型校验 | 上传文件扩展名与 MIME 一致性检查 |

## 5. 可靠性设计

- **熔断器**（Circuit Breaker）：LLM/Embedding 调用失败率超阈值时熔断，状态经 Redis
  在 API 与 Worker 间共享，避免单点过载
- **分布式锁**：使用 `acquire_lock(key, ttl)` + `release_lock(key, token)`（UUID + Lua CAS），
  防止误删他人锁
- **单例线程安全**：RAG Chain、LLM Service 使用双重检查锁定（M-13/M-24）
- **幂等性**：URL 导入哈希去重（M-1），聊天请求幂等锁（C-2/L-14）

## 6. 部署架构

```
Railway
├── api (FastAPI)        ← Web 服务，处理 HTTP 请求
├── worker (Celery)      ← 异步任务执行
├── postgres + pgvector  ← 数据库
├── redis                ← 缓存/锁/熔断状态
└── flower (可选)        ← Celery 监控（仅监控 profile 激活时启动）
```

- 数据库迁移：启动与运行时数据库检查/迁移（MIGRATE_ON_STARTUP、DB_RECOVERY_ENABLED），参见 ../../docs/SEALOS_RECOVERY_AND_BACKUP.md
- Redis 持久化：支持 fail-closed 策略（C-6/C-7）
- 容器资源限制：api/worker 1G，postgres 512M，redis 256M，flower 256M
