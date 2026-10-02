# GeiIt Agents 部署选型与上线准备建议

更新时间：2026-10-03（Asia/Shanghai）

本文基于当前 `develop/geiit-agents` 分支、容器入口、健康探针、备份/恢复接口和现有 Sealos/Railway 文档整理。它给出可执行的首发部署方案，同时区分已经由本地证据确认的能力、需要在目标环境验证的项目和不能用本地测试替代的真实联调。

## 推荐结论

首发建议选择 **Sealos/Kubernetes（中国大陆访问为主）**，采用下面的保守架构：

```text
浏览器 / Windows Tauri 客户端
              │ HTTPS
              ▼
      前端 Nginx（静态文件 + /api 同源反代）
              │ 内网 HTTP
              ▼
      FastAPI + Celery Worker（同一 Pod，1 副本）
          │                  │
          ▼                  ▼
 PostgreSQL 16 + pgvector     Redis 7
          │
          ▼
   PVC：数据库、上传文件、运行数据

独立 ops 进程（站点探活、备份、恢复预检查、故障/恢复邮件）
```

首发阶段不把 API 和 Worker 拆到不同 Pod。当前文档处理会在 API 写入 `/app/uploads`，Worker 再读取同一目录；拆分后必须提供可靠的 ReadWriteMany 或对象存储迁移，并重新验证强杀、重复任务和文件一致性。小团队单副本不需要先承担这项复杂度。

## 选型比较

| 方案 | 适合场景 | 优点 | 主要限制 | 建议 |
| --- | --- | --- | --- | --- |
| Sealos/Kubernetes | 中国大陆用户、5–20 人团队、需要持久卷和国内低延迟 | 与现有 PVC、`api+worker`、pgvector 镜像、探针和备份文档最匹配；可保留同源 Nginx | 需要配置镜像仓库、PVC、Secret、域名和基本 K8s 操作；平台故障恢复需独立 ops | **首发推荐** |
| Railway | 海外访问、快速试运行、希望少管理 K8s | Dockerfile 和 Railway 配置已有；公网域名、HTTPS、服务变量较方便 | API/Worker 分离时没有共享上传目录；托管 PostgreSQL 是否支持 pgvector 要先实测；公网出站与国内延迟可能不稳定 | 海外试运行或预发布 |
| 单机 Docker Compose/VPS | 内网、小规模验收、预算最低 | 成本低、架构直观、可完整控制卷和网络 | 单机故障域、升级/备份/证书/监控都需自己负责；不适合作为唯一生产容灾方案 | 本地 staging 或内网 |
| 托管 PostgreSQL/Redis + 容器平台 | 希望减少数据库运维 | 数据库备份、升级和监控交给供应商 | pgvector、网络白名单、TLS、备份导出和版本兼容必须逐项确认 | 二期优化 |

### 为什么不把 Railway 作为首发

Railway 可以启动当前后端和前端镜像，但当前代码仍有三个部署耦合：

1. 文档上传和异步解析依赖共享的 `/app/uploads`；API 和独立 Worker 服务没有共享本地文件系统。
2. Celery beat 需要独立的常驻进程；把 API、Worker、beat 拆分后还要重新确认重复调度和文件可见性。
3. Railway PostgreSQL 是否可用 `pgvector` 不能只看变量注入，必须在目标实例执行扩展检查并验证迁移。

如果必须使用 Railway，首发应将后端设为一个 `ROLE=api+worker` 服务，保持单副本，并把前端通过 `BACKEND_URL` 反代到后端；等上传文件迁移到对象存储或确认 RWX 后，再考虑拆分 Worker。

## 首发资源建议

这是面向 5–20 人团队、文档量不超过数万分块、低并发办公使用的起步规格，不是容量上限承诺：

| 组件 | 副本 | 起步资源 | 持久化 | 说明 |
| --- | ---: | ---: | --- | --- |
| 前端 Nginx | 1 | 0.25 vCPU / 256 MiB | 无 | 静态资源和同源反代 |
| API + Worker | 1 | 1 vCPU / 1–2 GiB | `/app/uploads` 2 GiB、`/app/data` 1 GiB | 先合并部署，避免上传文件跨 Pod |
| PostgreSQL 16 + pgvector | 1 | 1 vCPU / 1–2 GiB | 10 GiB 起步 | 预装 `vector`、`pg_trgm`；容量按文档和向量增长扩容 |
| Redis 7 | 1 | 0.25 vCPU / 256–512 MiB | 1 GiB（AOF 可选） | 缓存、限流、Celery broker/result 分库 |
| 独立 ops | 1 | 0.25 vCPU / 256 MiB | `ops-state.json` | 放在主集群之外更有价值 |

首发不建议 API 多副本。要扩容到多副本，必须先完成对象存储/RWX、任务幂等、限流共享、会话与上传一致性、滚动升级和并发压测验收。

## 上线前必须具备的外部资源

### 必需

- 可用域名和 HTTPS；前端域名与 API 反代路径固定为 `/api/`，不要把密钥放入 `VITE_*`。
- PostgreSQL 16 或兼容版本，已安装 `vector` 和 `pg_trgm` 扩展；数据库连接使用 TLS 或内网连接。
- Redis 7，分别为缓存、Celery broker 和 result backend 使用不同逻辑库或独立实例。
- `/app/uploads` 与 `/app/data` 持久卷；数据库使用独立 PVC。卷必须在重启/滚动更新后仍然存在。
- Secret 管理：`SECRET_KEY`、模型 API Key、数据库连接、Redis 连接、邮件凭据、备份加密密钥不得写入镜像、Git 或前端构建变量。
- 至少一个已授权的生产模型 provider；模型地址、模型名、Embedding 维度和 pgvector 列维度必须匹配。

### 建议

- Resend 或其他已验证域名的邮件通道；启用邮件前先用受控收件箱验证注册、重置密码和提醒。
- 专用备份 PostgreSQL 存储和独立恢复目标库；`BACKUP_ENCRYPTION_KEY` 需在密码管理器和离线安全副本各保存一份。
- 集群外的 ops 运行位置，能够访问站点 `/ready`、备份库和邮件服务。
- 日志、指标和告警平台；生产环境启用 Prometheus 时同时启用 Basic Auth，不能公开无认证 `/metrics`。

## 部署顺序

1. **冻结发布提交**：从 `develop/geiit-agents` 创建发布候选提交，确认工作树干净；不修改旧 `main`。
2. **构建并标记镜像**：后端、前端和 pgvector 镜像使用不可变版本标签（建议 Git SHA），不要只使用 `latest`。
3. **创建数据库和 PVC**：先创建 PostgreSQL、Redis、上传卷、运行数据卷和数据库卷；确认 PVC 为 Bound。
4. **安装扩展并验证**：在 PostgreSQL 执行 `CREATE EXTENSION IF NOT EXISTS vector` 和 `pg_trgm`，记录服务端版本。
5. **配置 Secret/变量**：复制 `backend/.env.example` 的字段，按生产值填写；生产必须关闭 DEBUG、禁用 CORS 通配符、设置精确前端域名。
6. **先部署 API + Worker**：使用 `ROLE=api+worker`，让入口脚本执行迁移和目录权限修复；等待 `/live` 成功，再等待 `/ready` 通过数据库和 Redis 检查。
7. **部署前端**：设置 `BACKEND_URL` 为 API 内网地址，前端通过同源 `/api/v1` 访问；确认 `/ready` 代理返回 JSON 而不是 SPA HTML。
8. **初始化管理员**：只在空库首次初始化时短暂启用 `BOOTSTRAP_ADMIN_ENABLED`，完成后关闭并移除初始化密码变量。
9. **配置备份和 ops**：先生成加密备份密钥，配置独立备份库、验证管理员连接和恢复目标库，再打开定时备份；ops 放在主集群之外。
10. **执行上线验收**：登录、注册/重置邮件、上传文档、异步解析、检索、流式回答、导出、管理员备份预检查、恢复到空目标库和告警恢复逐项验证。

## 发布门禁

### 已有本地证据

- 前端全量历史证据：126 个测试文件、1226 项通过（历史记录，不能写成本次重跑）。
- 后端历史证据：608 项通过、16 项跳过；跳过项依赖真实 PostgreSQL 或外部运维资源。
- Rust/Tauri 历史证据：20 项通过。
- 本次接手后的发布相关检查：`npm run check`、`npm run lint`、`npm run desktop:toolchain:test`、`npm run desktop:check`、`docker compose config --quiet` 通过。
- 本次未构建镜像或启动容器：当前机器 Docker CLI 可用，但 Docker daemon 不可连接。

### 目标环境必须重新验证

- 目标 PostgreSQL 的 pgvector/pg_trgm 扩展、版本、TLS 和迁移。
- 目标 Redis 的连接、持久化和 Celery 队列消费。
- `/live`、`/ready`、前端 `/ready` 反代和 SSE 流式传输。
- 上传文件在 API + Worker 容器中可读写，PVC 重启后文件仍在。
- 真实 provider 权限、模型名称、Embedding 维度和邮件投递。
- 备份快照校验、恢复预检查、空目标库恢复、幂等重试、ops 故障/恢复告警。
- 域名、HTTPS、CORS、CSP、WAF/反向代理日志脱敏和管理员权限。

## 备份、恢复和回滚

- PostgreSQL 备份只覆盖数据库；上传文件和 `/app/data` 必须另行快照或迁移到对象存储。Redis 队列不等同于业务数据备份。
- 恢复先到独立空目标库，完成结构、用户、文档、向量数量和关键抽样校验，再决定是否切换流量。
- 不用自动迁移替代数据恢复；迁移只能重建结构，不能找回用户、文档或对话。
- 版本回滚优先回滚前端/后端镜像到上一个已验证 SHA；数据库迁移若不可逆，必须先确认兼容窗口和恢复点。
- 任何不确定的邮件投递、任务执行或文件写入都保留“待核验”状态，不通过重复提交掩盖不确定性。

## 当前上线判断

当前项目已经达到“可以准备首发部署”的条件，但还没有达到“已经完成生产上线验收”。阻塞上线完成度的不是基础容器结构，而是目标环境证据仍缺失：Docker daemon/镜像构建、真实 provider 权限、真实邮件、目标 pgvector、PVC 重启和恢复演练、域名 HTTPS 与告警联调。

因此推荐按以下顺序推进：

1. 在本地或 CI 有 Docker daemon 的环境构建并推送后端/前端镜像。
2. 在 Sealos 建立隔离的 staging 环境，使用合成或受控测试账号完成全链路验收。
3. 完成真实 provider、邮件、备份恢复和 PVC 重启证据后，再复制配置到 production。
4. 首发保持单副本 `api+worker`，观察一周的错误率、队列延迟、数据库容量和备份成功率，再决定是否拆分和扩容。

本次没有执行线上部署、没有访问生产数据库、没有调用真实邮件或模型，也没有推送远程分支。
