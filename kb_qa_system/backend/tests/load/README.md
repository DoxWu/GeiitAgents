# Locust 压测脚本 — GeiIt企业知识库

> 本目录包含 GeiIt企业知识库后端 API 的 Locust 负载测试脚本，用于验证系统在高并发场景下的稳定性和响应速度。

---

## 目录

1. [安装](#1-安装)
2. [前置准备](#2-前置准备)
3. [运行压测](#3-运行压测)
4. [压测场景说明](#4-压测场景说明)
5. [环境变量配置](#5-环境变量配置)
6. [结果指标解读](#6-结果指标解读)
7. [性能基线建议](#7-性能基线建议)
8. [注意事项](#8-注意事项)

---

## 1. 安装

Locust 是可选的压测工具，**不在项目 requirements.txt 中**，需独立安装：

```bash
# 方式 1：直接安装（推荐）
pip install locust

# 方式 2：使用虚拟环境（避免污染项目依赖）
python -m venv .venv-loadtest
# Windows
.venv-loadtest\Scripts\activate
# Linux/Mac
source .venv-loadtest/bin/activate
pip install locust
```

验证安装：

```bash
locust --version
# 输出示例：locust 2.31.0
```

---

## 2. 前置准备

### 2.1 服务运行中

确保后端 API 和 Worker 服务已启动（本地或 Railway）：

```bash
# 验证服务可用
curl http://localhost:8000/health
# 应返回 {"status": "healthy", ...}
```

### 2.2 创建测试账号

压测脚本需要 2 个测试账号（通过前端注册或 `create_superuser` 脚本创建）：

```bash
# 在隔离测试环境中创建专用的普通账号；不要复用管理员或生产用户。
# 通过组织的密钥管理器将账号注入 Locust 进程环境：
#   TEST_USERNAME / TEST_PASSWORD
# 只有运行 MixedUser 时才需要第二个账号：
#   TEST_USER2_USERNAME / TEST_USER2_PASSWORD
```

> 💡 也可以通过前端注册审批流程创建普通用户账号。

### 2.3 准备测试数据

QAUser 场景需要知识库中有已处理的文档才能测试检索效果。建议：

1. 用测试账号登录前端
2. 上传 3-5 个文档（PDF/Markdown/TXT）
3. 等待文档状态变为 `completed`（Worker 处理完成）

---

## 3. 运行压测

### 3.1 Web UI 模式（推荐）

```bash
# 进入压测脚本目录
cd kb_qa_system/backend/tests/load

# 启动 Locust Web UI
locust -f locustfile.py

# 浏览器访问 http://localhost:8089
# 配置：
#   - Number of users (峰值并发数): 如 50
#   - Ramp up (每秒启动用户数): 如 5
#   - Host: http://localhost:8000（或 Railway 域名）
```

### 3.2 Headless 模式（CI/CD 适用）

```bash
# 只运行健康检查场景，50 并发，持续 60 秒
locust -f locustfile.py HealthCheckUser \
  --headless \
  -u 50 \
  -r 5 \
  --run-time 60s \
  --host http://localhost:8000

# 只运行只读场景，100 并发，持续 120 秒
locust -f locustfile.py ReadOnlyUser \
  --headless \
  -u 100 \
  -r 10 \
  --run-time 120s \
  --host http://localhost:8000

# 运行所有场景（混合），30 并发，持续 300 秒
locust -f locustfile.py \
  --headless \
  -u 30 \
  -r 3 \
  --run-time 300s \
  --host http://localhost:8000
```

### 3.3 指定环境变量

```bash
# 将 TARGET_HOST 和测试账号凭据由受控环境注入后，在隔离的预发布环境执行。
# 不要把生产管理员、账号密码或密钥写进命令行、脚本或仓库。
locust -f locustfile.py ReadOnlyUser --headless -u 20 -r 2 --run-time 60s
```

---

## 4. 压测场景说明

| 场景 | 类名 | 描述 | LLM 成本 | 推荐并发 |
|------|------|------|----------|----------|
| 健康检查 | `HealthCheckUser` | 仅访问 /health，基线测试 | 无 | 100-500 |
| 只读 | `ReadOnlyUser` | 文档列表、统计、对话列表 | 无 | 50-200 |
| 问答 | `QAUser` | RAG 全链路（检索+生成） | 高 | 5-20 |
| 混合读写 | `MixedUser` | 上传+浏览+提问+删除 | 中 | 10-30 |

### 场景 1：HealthCheckUser（健康检查）

- **端点**：`GET /health`
- **目的**：验证服务存活，测量最简请求延迟基线
- **特点**：无认证、无数据库查询（仅 ping）、无 LLM 调用
- **适用**：部署后验证、CI/CD 冒烟测试

### 场景 2：ReadOnlyUser（只读）

- **端点**：`GET /documents`、`GET /documents/stats/overview`、`GET /chat/conversations`、`GET /auth/me`
- **目的**：测量数据库查询和缓存性能
- **特点**：需登录、有数据库查询、无 LLM 调用
- **适用**：验证索引效果和连接池配置；脚本不测量 FAQ 答案缓存命中率

### 场景 3：QAUser（问答 — RAG 链路）

- **端点**：`POST /chat/ask`、`GET /chat/conversations`
- **目的**：测量 RAG 端到端延迟（向量检索 → 重排序 → LLM 生成）
- **特点**：需登录、有向量检索、有 LLM 调用、响应时间 5-30 秒
- **适用**：验证 LLM 熔断器和 RAG 链路性能基线；当前问答路径没有接入 FAQ 答案缓存
- **⚠️ 注意**：每次提问消耗 LLM Token，控制压测时长避免成本超支

### 场景 4：MixedUser（混合读写）

- **端点**：`POST /documents/upload`、`GET /documents`、`POST /chat/ask`、`DELETE /documents/{id}`
- **目的**：测试读写并发下的数据一致性和级联删除性能
- **特点**：需登录、有文件上传、有 Celery 任务投递、有 LLM 调用
- **适用**：验证文档处理流水线、级联删除、资源竞争

---

## 5. 环境变量配置

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `TARGET_HOST` | `http://localhost:8000` | 目标后端地址 |
| `TEST_USERNAME` | 无 | 只读/问答场景的测试账号，必须在未跟踪环境中显式设置 |
| `TEST_PASSWORD` | 无 | 测试账号密码，必须在未跟踪环境中显式设置 |
| `TEST_USER2_USERNAME` | 无 | 混合读写场景的第二个测试账号，必须在未跟踪环境中显式设置 |
| `TEST_USER2_PASSWORD` | 无 | 第二个测试账号密码，必须在未跟踪环境中显式设置 |

> 只在明确授权的隔离或预发布环境进行压测。不要直接对生产环境运行混合读写或 LLM 场景；账号必须是专用普通用户，并通过外部密钥管理机制注入环境变量。

---

## 6. 结果指标解读

Locust Web UI 和 headless 模式输出以下关键指标：

| 指标 | 说明 | 关注点 |
|------|------|--------|
| **Requests/s** | 每秒请求数（RPS） | 越高越好，反映吞吐量 |
| **Avg** | 平均响应时间（ms） | 越低越好 |
| **Min / Max** | 最小/最大响应时间 | Max 反映最差情况 |
| **P50** | 中位数响应时间 | 50% 请求在此以下 |
| **P95** | 95 分位响应时间 | **关键指标**，反映大部分用户体验 |
| **P99** | 99 分位响应时间 | 反映长尾延迟 |
| **Fails** | 失败请求数 | 应为 0，否则检查限流/错误 |

### 健康标准

| 指标 | 健康 | 需关注 | 异常 |
|------|------|--------|------|
| 失败率 | 0% | <1% | >5% |
| 健康检查 P95 | <100ms | <500ms | >1s |
| 文档列表 P95 | <200ms | <1s | >2s |
| 提问 P95 | <15s | <25s | >30s（触发告警） |
| RPS | 随并发线性增长 | 增长放缓 | 下降（可能过载） |

---

## 7. 性能基线建议

基于 10D 审查报告（D4 性能维度）和系统配置，建议建立以下性能基线：

### 7.1 健康检查基线

| 并发数 | 预期 RPS | 预期 P95 | 预期失败率 |
|--------|----------|----------|------------|
| 50 | >200 | <50ms | 0% |
| 100 | >300 | <100ms | 0% |
| 200 | >400 | <200ms | 0% |

### 7.2 只读场景基线

| 并发数 | 预期 RPS | 预期 P95 | 预期失败率 |
|--------|----------|----------|------------|
| 50 | >100 | <500ms | 0% |
| 100 | >150 | <1s | <1% |

### 7.3 问答场景基线

| 并发数 | 预期 RPS | 预期 P95 | 预期失败率 |
|--------|----------|----------|------------|
| 5 | >0.5 | <15s | 0% |
| 10 | >0.8 | <20s | <5%（限流） |
| 20 | >1.0 | <25s | <10%（限流） |

> ⚠️ 问答场景 P95 >30s 会触发 Prometheus `HighRAGLatency` 告警。

---

## 8. 注意事项

### 8.1 限流配置

系统配置了以下限流（见 `.env.example`）：

| 操作 | 限流 | 压测脚本应对 |
|------|------|-------------|
| 登录 | 5次/分钟 | 登录放在 `on_start`，每用户仅登录一次 |
| 提问 | 20次/分钟 | QAUser `wait_time=3-5s`，最多 12次/分钟 |
| 上传 | 20次/小时 | MixedUser 上传权重最低（1/7） |
| 全局 | 100次/分钟 | 总请求量受此限制 |

> 💡 如需提高压测强度，可临时调高 `RATE_LIMIT_*` 环境变量，但生产环境不建议修改。

### 8.2 Worker 依赖

- 文档上传后由 Worker 异步处理（解析、分块、向量化）
- 压测前确保 Worker 服务正常运行
- MixedUser 上传的文档可能在压测期间未处理完成（正常现象）

### 8.3 LLM API 成本

- QAUser 和 MixedUser 的提问操作会消耗 LLM Token
- GPT-3.5-turbo 大约 $0.002/次提问
- 100 并发 × 5 分钟 ≈ 100 次提问 ≈ $0.2
- **建议**：开发环境使用本地 Ollama 模型压测，避免 API 成本

### 8.4 数据影响

- MixedUser 会创建和删除文档，**压测后知识库内容会变化**
- 建议在专用测试环境运行，不要在生产环境运行 MixedUser
- MixedUser 写操作默认关闭；只有在专用隔离环境设置 `ALLOW_MUTATIONS=true` 后才会上传，并且只删除本轮成功上传且收到 ID 的文档。
- `QAUser` 默认停止。只有明确设置 `ENABLE_LLM_TRAFFIC=true` 才发送可能计费的问题。
- 所有 HTTP 调用使用 `LOCUST_REQUEST_TIMEOUT_SECONDS` 超时；登录失败用户会停止。
- 测试账号需由运维在隔离环境准备。本脚本不自动创建/清理账号或数据库夹具，也不配置并发账号池。
- 生产等价 PostgreSQL/Redis/Celery/RAG 阶梯和故障压力未在本机验收，生产环境不得运行混合写入测试。

### 8.5 监控配合

压测时建议同时观察 Prometheus 指标（`/metrics`）：

- `http_requests_in_progress`：在途请求数（应 < 100，否则触发告警）
- `http_requests_total`：请求总量（按状态码分组）
- `rag_total_duration_seconds`：RAG 处理耗时分布
- `rag_degradation_total`：降级次数（LLM 熔断时增加）
- `http_stream_duration_seconds`、`http_streams_in_progress`：完整流生命周期指标

---

## 参考文档

- [十维度审查报告 D4](../../../../docs/COMPREHENSIVE_REVIEW_10D.md) — 性能和压力测试维度
- [Railway 部署指南](../../../../docs/RAILWAY_DEPLOYMENT_GUIDE.md) — 监控与日志章节
- [本地部署指南](../../../../docs/LOCAL_DEPLOYMENT_GUIDE.md) — 本地启动服务
- [Locust 官方文档](https://docs.locust.io/) — 更多用法
