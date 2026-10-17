# GeiIt企业知识库

> 基于 RAG（检索增强生成）的企业内部知识库智能问答系统，支持文档上传、向量检索、AI 问答、多用户权限管理。

## 项目简介

GeiIt 企业知识库包含服务端 RAG 应用和 Windows 桌面工作台。仓库功能、环境模板与本地验证结果不代表某个线上部署已完成验收；使用前请核对当前配置、供应商和数据保留方式。

### 核心功能

- 📄 **文档管理**：支持 PDF/Word/Markdown/TXT 上传、自动分块、向量化、质量评估
- 🔍 **智能问答**：基于 RAG 的检索增强生成，支持流式输出和上下文记忆
- 👥 **权限控制**：公共文档库 + 个人文档库，用户只能访问授权范围内的文档
- 🔒 **安全认证**：JWT 双 Token 认证、注册审批流程、邮箱验证
- 📊 **运行观测**：Prometheus 指标、有限操作审计和后台清理任务；实际调度与保留周期依部署配置而定
- 🌙 **多端适配**：PWA 支持、暗色模式、IME 输入法兼容

## 技术栈

| 层级 | 技术选型 |
|------|----------|
| **前端** | React 18 + TypeScript + Vite 6 + Tailwind CSS + Zustand |
| **后端** | FastAPI + SQLAlchemy 2.0 + Pydantic 2 + structlog |
| **数据库** | PostgreSQL 16 + pgvector（向量存储）|
| **缓存** | Redis（缓存 + 限流 + 分布式锁）|
| **任务队列** | Celery + Flower（异步文档处理）|
| **AI/RAG** | 可配置的 OpenAI-compatible provider + pgvector；桌面本地知识库使用独立 E5 模型与存储 |
| **监控** | Prometheus + Grafana + Alertmanager 模板；Sentry 为可选项 |
| **部署** | Docker Compose 与 Sealos 相关模板；未据此声明线上部署状态 |

## 项目结构

```
企业知识库问答系统/
├── .github/                    # CI/CD 配置
│   ├── workflows/ci.yml       # GitHub Actions 流水线
│   └── dependabot.yml         # 依赖漏洞扫描
├── .trae/documents/            # 开发文档与计划
├── docs/                       # 审查、工作记录、开发和运维文档
│   ├── COMPREHENSIVE_REVIEW_2026-10-10.md
│   ├── REVIEW_REMEDIATION_2026-10-10.md
│   ├── WORK_LOG.md
│   ├── RELEASE_AND_SCHEMA_SAFETY.md
│   └── RUNBOOK.md
├── kb_qa_system/
│   ├── backend/                # FastAPI 后端
│   │   ├── app/
│   │   │   ├── api/routes/     # API 路由
│   │   │   ├── core/           # 配置、安全、数据库
│   │   │   ├── middleware/     # 中间件
│   │   │   ├── models/         # 数据模型
│   │   │   ├── schemas/        # Pydantic Schema
│   │   │   ├── services/       # 业务服务层
│   │   │   ├── tasks/          # Celery 异步任务
│   │   │   └── utils/          # 工具函数
│   │   ├── tests/              # 测试文件
│   │   ├── scripts/            # 运维脚本
│   │   ├── alembic/            # 数据库迁移
│   │   └── requirements.txt
│   ├── frontend/               # React 前端
│   │   ├── src/
│   │   │   ├── api/            # API 客户端
│   │   │   ├── components/     # UI 组件
│   │   │   ├── pages/          # 页面
│   │   │   ├── store/          # Zustand 状态管理
│   │   │   ├── types/          # TypeScript 类型
│   │   │   └── utils/          # 工具函数
│   │   └── package.json
│   └── monitoring/             # 监控配置
│       ├── docker-compose.monitoring.yml
│       ├── prometheus.yml
│       ├── alertmanager.yml
│       └── alerts.yml
└── README.md                   # 本文件
```

## 快速开始

### 本地开发

开发环境准备见 [本地部署指南](docs/LOCAL_DEPLOYMENT_GUIDE.md) 和 [后端说明](kb_qa_system/backend/README.md)。

```bash
# 1. 克隆仓库
git clone <repo-url>
cd 企业知识库问答系统

# 2. 后端启动
cd kb_qa_system/backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env  # 编辑环境变量
alembic upgrade head
uvicorn app.main:app --reload

# 3. 前端启动
cd kb_qa_system/frontend
npm install
cp .env.example .env  # 编辑环境变量
npm run dev
```

### 生产部署

部署参考见 [Sealos 部署指导](kb_qa_system/docs/Sealos部署指导.md) 与 [备份恢复说明](kb_qa_system/docs/SEALOS_RECOVERY_AND_BACKUP.md)。这些是仓库文档，不代表目标环境已部署或演练。

## 文档索引

| 文档 | 说明 |
|------|------|
| [本地部署指南](docs/LOCAL_DEPLOYMENT_GUIDE.md) | 本地开发环境搭建 |
| [审查报告](docs/COMPREHENSIVE_REVIEW_2026-10-10.md) | 代码审查发现及验收条件 |
| [修复跟踪](docs/REVIEW_REMEDIATION_2026-10-10.md) | 本轮实现进度与验证边界 |
| [工作记录](docs/WORK_LOG.md) | 当前阶段、决策、验证和下一步 |
| [发布与 schema 安全](docs/RELEASE_AND_SCHEMA_SAFETY.md) | 灰度、兼容迁移和回滚检查清单；尚未做 staging 演练 |
| [事故响应手册](docs/RUNBOOK.md) | 故障处理流程 |
| [Sealos 备份恢复](kb_qa_system/docs/SEALOS_RECOVERY_AND_BACKUP.md) | 服务端备份和恢复边界 |
| [本地知识库规格](docs/LOCAL_KNOWLEDGE_BASE_SPEC.md) | 客户端本地模型、索引隔离与验收要求 |
| [当前功能矩阵](docs/CURRENT_FEATURE_MATRIX.md) | 代码入口、验证证据、功能边界及未验收项 |
| [历史详细功能清单](kb_qa_system/docs/知识库项目功能清单.md) | 历史整理稿，不作为当前实现状态依据 |

## 开发规范

- **Commit 规范**：遵循 [Conventional Commits](https://www.conventionalcommits.org/)
- **代码审查**：所有 PR 需至少 1 人审查，核心路径需 2 人
- **测试要求**：新功能需配套单元测试，CI 必须通过
- **文档同步**：API 变更需同步更新文档

## 许可证

私有项目，版权所有 © 2026 GeiIt
