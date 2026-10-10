# GeiIt企业知识库 - 监控系统

> 基于 Prometheus + Grafana + Loki 的全链路可观测性方案，覆盖指标监控（HTTP 服务、RAG 链路、LLM 性能、服务质量、文档处理五大维度）和日志聚合（容器日志统一查询）。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                      FastAPI 应用                            │
│  ┌──────────────────┐  ┌──────────────────────────────┐    │
│  │ PrometheusMiddleware│ │ rag_chain.py 6处埋点 + chat.py 2处│    │
│  │ (HTTP层自动采集)  │  │ (RAG链路主动埋点)             │    │
│  └────────┬─────────┘  └────────────┬─────────────────┘    │
│           │                          │                       │
│           └──────────┬───────────────┘                       │
│                      ▼                                       │
│              /metrics 端点 (PlainText)                       │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP GET (15s 间隔)
                       ▼
              ┌─────────────────┐
              │   Prometheus    │  指标采集 + 告警评估
              │   (port 9090)   │
              └────────┬────────┘
                       │ PromQL 查询
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                        Grafana (port 3001)                   │
│            指标面板（Prometheus）+ 日志面板（Loki）           │
└──────────────────────────▲───────────────────────────────────┘
                           │ LogQL 查询
                           │
              ┌────────────┴───────────┐
              │      Loki (port 3100)   │  日志聚合（只索引标签）
              └────────────▲───────────┘
                           │ 推送日志
                           │
              ┌────────────┴───────────┐
              │  Promtail (port 9080)  │  日志采集代理
              │  通过 Docker socket    │
              │  自动发现 kb_qa_* 容器 │
              └────────────────────────┘
```

## 指标监控与日志聚合的关系

| 维度     | 指标监控（Prometheus）       | 日志聚合（Loki + Promtail）      |
| -------- | ---------------------------- | -------------------------------- |
| 数据类型 | 数值指标（Counter/Histogram）| 文本日志                          |
| 查询语言 | PromQL                       | LogQL                            |
| 典型场景 | 监控趋势、告警阈值、聚合统计 | 排查错误、审计追踪、关联分析      |
| 存储成本 | 低（仅存指标值）             | 中（只索引标签，不索引全文）      |
| 组合使用 | 指标面板显示延迟飙升 → 日志面板查看同时段 ERROR 日志，定位根因 ||

## 快速启动

### 1. 启用 Prometheus 指标采集

在 `backend/.env` 中设置：

```bash
ENABLE_PROMETHEUS=true
```

### 2. 启动监控栈

监控栈需与主服务一起启动（共享 Docker 网络）：

```bash
# 在 kb_qa_system 目录下执行。monitoring/.env 仅存监控凭据，不要提交。
docker compose --env-file monitoring/.env -f docker-compose.yml -f monitoring/docker-compose.monitoring.yml up -d
```

若主服务已经运行，只启动监控栈时使用相同项目目录和 Compose 环境文件：

```bash
docker compose --env-file monitoring/.env --project-directory . -f monitoring/docker-compose.monitoring.yml up -d
```

### 3. 访问监控面板

| 服务         | 地址                      | 账号         |
| ------------ | ------------------------- | ------------ |
| Prometheus   | http://localhost:9090     | 无需认证     |
| Grafana      | http://localhost:3001     | 用户名 `admin`；密码由 `GRAFANA_ADMIN_PASSWORD` 设置 |
| Alertmanager | http://localhost:9093     | 无需认证     |
| Loki API     | http://localhost:3100     | 无需认证（API，无 UI） |
| Promtail     | http://localhost:9080     | 无需认证（查看采集状态） |

Grafana 启动后会自动加载 "RAG 监控" 文件夹下的仪表盘，并自动配置 Prometheus 和 Loki 两个数据源。

### 4. 验证指标采集

```bash
# 直接访问应用 /metrics 端点
curl http://localhost:8000/metrics

# 在 Prometheus 中检查 target 状态
# 访问 http://localhost:9090/targets，kb_qa_api 应显示 UP
```

## 监控指标清单

### HTTP 层指标（中间件自动采集）

| 指标名                              | 类型      | 说明                     |
| ----------------------------------- | --------- | ------------------------ |
| `http_requests_total`               | Counter   | 请求总数（method/endpoint/status）|
| `http_request_duration_seconds`     | Histogram | 请求延迟分布             |
| `http_requests_in_progress`         | Gauge     | 当前在途请求数           |

### RAG 链路指标（rag_chain.py 主动埋点）

| 指标名                              | 类型      | 说明                     |
| ----------------------------------- | --------- | ------------------------ |
| `rag_questions_total`               | Counter   | 问答总数（intent_type/stream）|
| `rag_total_duration_seconds`        | Histogram | 端到端耗时（按意图类型） |
| `rag_retrieval_duration_seconds`    | Histogram | 检索耗时                 |
| `rag_retrieval_results_count`       | Histogram | 检索结果数分布           |
| `rag_retrieval_top_score`           | Histogram | 检索最高分分布           |
| `rag_llm_duration_seconds`          | Histogram | LLM 生成耗时             |
| `rag_llm_tokens_total`              | Counter   | Token 消耗（input/output）|
| `rag_llm_retries_total`             | Counter   | LLM 重试次数             |
| `rag_degradation_total`             | Counter   | 降级响应（按原因）       |
| `rag_validation_skipped_total`      | Counter   | 预生成校验拦截次数       |
| `rag_conflict_detected_total`       | Counter   | 矛盾检测命中次数         |

### 文档处理指标

| 指标名                              | 类型      | 说明                     |
| ----------------------------------- | --------- | ------------------------ |
| `document_uploads_total`            | Counter   | 文档上传总数（按类型）   |
| `document_processing_duration_seconds` | Histogram | 文档处理耗时          |
| `document_chunks_created_total`     | Counter   | 文档分块创建总数         |

### 系统信息指标

| 指标名              | 类型 | 说明                   |
| ------------------- | ---- | ---------------------- |
| `kb_qa_system_info` | Info | 应用版本/环境/名称信息 |

## 仪表盘面板说明

Grafana 仪表盘 `rag_dashboard.json` 包含 6 大区块、30+ 面板：

### 📡 HTTP 服务概览
- 请求总速率、在途请求数、5xx 错误率、平均响应时间
- 请求速率趋势（按端点）
- 响应时间 P95/P50（按端点）

### 🤖 RAG 问答概览
- 问答总速率、累计总数
- 问答速率趋势（按意图类型，堆叠图）
- 流式/非流式占比、意图类型占比（环形图）
- 端到端耗时 P95/P50（按意图类型）

### 🔍 检索性能
- 检索耗时 P95/P50
- 检索结果数分布
- 检索 Top Score 分布
- 检索平均最高分（质量指标，条形仪表盘）

### ⚡ LLM 生成性能
- LLM 生成耗时 P95/P50
- Token 消耗速率（tokens/min，输入/输出堆叠）
- LLM 重试速率
- Token 累计消耗

### 🛡️ 服务质量与降级
- 服务降级率（仪表盘）
- 降级原因分布（环形图）
- 预生成校验拦截总数/率
- 矛盾检测命中总数/趋势
- 降级趋势（按原因，堆叠图）

### 📄 文档处理
- 文档上传累计、分块累计
- 文档上传速率（按类型）
- 文档处理耗时 P95/P50

## 告警规则

告警规则定义在 `alerts.yml`，共 4 组 8 条告警：

| 告警组           | 告警名                   | 触发条件                          | 级别     |
| ---------------- | ------------------------ | --------------------------------- | -------- |
| http_health      | HighErrorRate            | 5xx 错误率 > 10%（持续 2m）       | critical |
| http_health      | ServiceDown              | 服务不可用（持续 1m）             | critical |
| rag_performance  | HighRAGLatency           | RAG P99 > 30s（持续 5m）          | warning  |
| rag_performance  | HighRetrievalLatency     | 检索 P95 > 5s（持续 5m）          | warning  |
| rag_performance  | HighLLMLatency           | LLM P95 > 20s（持续 5m）          | warning  |
| rag_quality      | HighDegradationRate      | 降级率 > 30%（持续 5m）           | critical |
| rag_quality      | CircuitBreakerTripping   | 熔断触发频率 > 0.1/s（持续 2m）   | critical |
| rag_quality      | HighValidationSkipRate   | 校验拦截率 > 50%（持续 10m）      | warning  |
| rag_quality      | LowRetrievalQuality      | 平均 Top Score < 0.5（持续 10m）  | warning  |
| resource_usage   | HighTokenUsage           | Token 消耗 > 100K/h（持续 10m）   | warning  |
| resource_usage   | HighConcurrentRequests   | 在途请求 > 100（持续 2m）         | warning  |

### 配置告警通知（Alertmanager）

Alertmanager 已包含在监控栈中。配置后可发送告警邮件；本仓库没有执行真实收件箱验收。

```bash
# 1. 在 Compose 的环境或私有 env 文件中配置：
#    ALERT_EMAIL_TO=ops@example.com            # 告警接收邮箱
#    ALERT_EMAIL_FROM=GeiIt企业知识库 <onboarding@resend.dev>  # 发件人
#    SMTP_HOST=smtp.resend.com                 # SMTP 主机
#    SMTP_PORT=587                             # STARTTLS 端口
#    SMTP_USER=resend                          # SMTP 用户
#    SMTP_PASSWORD=<smtp-password>             # 不写入仓库
#    GRAFANA_ADMIN_PASSWORD=<long-random-value>

# 2. 将以上值保存在未跟踪的 monitoring/.env，然后在 kb_qa_system 目录启动
docker compose --env-file monitoring/.env -f docker-compose.yml -f monitoring/docker-compose.monitoring.yml up -d

# 3. 验证 Alertmanager 状态
#    访问 http://localhost:9093，查看告警路由和静默规则
```

Compose 构建的 Alertmanager 镜像会将配置模板中的专用标记替换为 YAML 转义后的值，再以仅当前用户可读的临时文件启动。SMTP 主机和端口会校验格式；使用 STARTTLS 的 587 端口，465 隐式 TLS 未接入此模板。SMTP 用户名和密码不会写入渲染日志。监控 UI/API 只绑定本机回环地址，匿名 Grafana 访问关闭。真实 SMTP 投递仍须由运营方使用测试收件箱验收。

从仓库根目录校验 Compose 配置时，`monitoring/.env` 必须包含 `GRAFANA_ADMIN_PASSWORD`：

```bash
docker compose --env-file kb_qa_system/monitoring/.env -f kb_qa_system/docker-compose.yml -f kb_qa_system/monitoring/docker-compose.monitoring.yml config --quiet
```

## 日志聚合（Loki + Promtail）

### 工作原理

1. **Promtail** 通过 Docker socket 自动发现 `kb_qa_*` 前缀的容器
2. 读取容器的 JSON 日志文件，解析后添加标签（container_name、service、stream、level）
3. 批量推送到 **Loki**（每秒或 1MB 触发一次）
4. **Loki** 只索引标签（不索引全文），存储成本远低于 ELK
5. 在 **Grafana** 中使用 LogQL 查询日志，可与指标面板组合展示

### 日志标签

| 标签            | 来源                      | 示例值              |
| --------------- | ------------------------- | ------------------- |
| `container_name`| Docker 容器名             | `kb_qa_api`         |
| `service`       | Compose service 名        | `api`、`worker`     |
| `stream`        | 日志流                    | `stdout`、`stderr`  |
| `level`         | 日志级别（生产环境解析）  | `info`、`error`     |
| `compose_project`| Compose 项目名           | `kb_qa_system`      |

### LogQL 查询示例

在 Grafana 中添加 Loki 面板，使用以下查询：

```logql
# 查看后端 API 所有日志
{container_name="kb_qa_api"}

# 只看错误日志（生产环境 JSON 日志，已解析 level 标签）
{container_name="kb_qa_api", level="error"}

# 查看异常相关日志（全文搜索）
{container_name="kb_qa_api"} |= "异常"

# 查看 Celery Worker 日志
{container_name="kb_qa_worker"}

# 统计过去 5 分钟的错误日志速率
rate({container_name="kb_qa_api", level="error"}[5m])

# 多容器联合查询
{container_name=~"kb_qa_.*"} |= "ERROR"
```

### 验证日志采集

```bash
# 1. 检查 Promtail 是否发现容器
#    访问 http://localhost:9080/targets，应看到 kb_qa_* 容器列表

# 2. 检查 Loki 是否接收日志
curl -G -s "http://localhost:3100/loki/api/v1/labels" | jq

# 3. 查询最近日志
curl -G -s "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={container_name="kb_qa_api"}' \
  --data-urlencode 'limit=5' | jq

# 4. 在 Grafana 中查询
#    进入 Explore → 选择 Loki 数据源 → 输入 LogQL 查询
```

### 日志保留策略

- **默认保留 7 天**（`loki-config.yml` 中 `retention_period: 168h`）
- 过期日志由 Compactor 自动删除（每 10 分钟压缩和清理一次）
- 如需更长保留期，修改 `loki-config.yml` 的 `retention_period` 并重启 Loki

## 安全配置

### 生产环境安全加固

```bash
# backend/.env: enable and protect the API endpoint
ENABLE_PROMETHEUS=true
PROMETHEUS_AUTH_ENABLED=true
PROMETHEUS_AUTH_USER=prometheus
PROMETHEUS_AUTH_PASSWORD=<random secret using letters, digits, _ and ->

# monitoring/.env: Prometheus uses the same credentials to scrape the API
PROMETHEUS_AUTH_USER=prometheus
PROMETHEUS_AUTH_PASSWORD=<same secret>

# monitoring/.env: change the Grafana administrator password
GF_SECURITY_ADMIN_PASSWORD=<强密码>

# 关闭 Grafana 匿名访问
GF_AUTH_ANONYMOUS_ENABLED=false

# 关闭路径标签（降低 label 基数，防内存爆炸）
PROMETHEUS_INCLUDE_PATH_LABEL=false
```

Prometheus expands its scrape credentials from the process environment. Keep `monitoring/.env` untracked and use a random secret made from letters, digits, `_` and `-`; the same values must be present in `backend/.env`. The monitoring Compose service passes these values to Prometheus and enables config environment expansion.

## 文件结构

```
monitoring/
├── README.md                              # 本说明文档
├── prometheus.yml                         # Prometheus server 配置
├── alerts.yml                             # 告警规则
├── alertmanager.yml                       # Alertmanager 告警通知配置
├── loki-config.yml                        # Loki 日志聚合配置（E6-01）
├── promtail.yml                           # Promtail 日志采集代理配置（E6-01）
├── docker-compose.monitoring.yml          # 监控栈容器编排
└── grafana/
    ├── provisioning/
    │   ├── datasources/
    │   │   └── datasource.yml             # 数据源自动配置（Prometheus + Loki）
    │   └── dashboards/
    │       └── dashboard.yml              # 仪表盘 provider 配置
    └── dashboards/
        └── rag_dashboard.json             # RAG 监控仪表盘 JSON
```

## 常见问题

### Q: Prometheus target 显示 DOWN？

- 检查 api 服务是否正常运行：`docker compose --env-file monitoring/.env ps`
- 检查 api 容器是否在同一个 Docker 网络：`docker network inspect kb_qa_system_default`
- 检查 `ENABLE_PROMETHEUS` 是否设为 `true`
- 在 api 容器内测试：`curl http://api:8000/metrics`

### Q: Grafana 没有显示仪表盘？

- 检查 `grafana/dashboards/` 目录是否正确挂载
- 查看 Grafana 日志：`docker compose --env-file monitoring/.env --project-directory . -f monitoring/docker-compose.monitoring.yml logs grafana`
- 手动刷新 provisioning：使用配置的 Grafana 管理员凭据调用 `/api/admin/provisioning/dashboards/reload`

### Q: 指标 label 基数过高导致内存增长？

- 关闭路径标签：`PROMETHEUS_INCLUDE_PATH_LABEL=false`
- 中间件已自动将 `/conversations/123` 模板化为 `/conversations/{id}`，避免高基数

### Q: 如何在生产环境只监控关键指标？

- 在 Railway 上设置 `ENABLE_PROMETHEUS=true` 即可启用
- 认证启用时，Prometheus 抓取任务也必须配置相同用户名和密码；按上面的配置同时设置 `backend/.env` 与 `monitoring/.env`
- 可在 `prometheus.yml` 中调整 `scrape_interval` 降低采集频率

### Q: Loki/Promtail 日志查询为空？

- 检查 Promtail 是否发现容器：访问 http://localhost:9080/targets
- 确认容器名以 `kb_qa_` 前缀开头（promtail.yml 中配置的过滤器）
- 检查 Promtail 日志：`docker compose --env-file monitoring/.env --project-directory . -f monitoring/docker-compose.monitoring.yml logs promtail`
- 检查 Loki 健康：`curl http://localhost:3100/ready` 应返回 `ready`
- 确认 Grafana 数据源已配置：进入 Configuration → Data Sources，应有 Loki

### Q: Loki 磁盘占用过高？

- 当前默认保留 7 天日志（`loki-config.yml` 的 `retention_period: 168h`）
- 可缩短保留期：修改 `retention_period` 并重启 Loki
- 检查是否有高基数标签：`curl http://localhost:3100/loki/api/v1/cardinality/labels`
- 避免将 request_id、user_id 等高基数字段作为标签（promtail.yml 已规避）

### Q: 云托管环境如何使用本地 Docker 日志聚合？

- 部分云托管环境不支持 Docker Compose，Loki/Promtail 仅适用于可访问 Docker socket 的主机
- 使用托管平台提供的日志查看功能，或单独设计并验证集中式日志服务
- 如需集中式日志聚合，可将日志发送到外部服务（如 Grafana Cloud、Datadog）
