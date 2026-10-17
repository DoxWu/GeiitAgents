# GeiIt企业知识库 — 事故响应手册（Runbook）

> **文档日期**：2026-07-11
> **适用范围**：GeiIt企业知识库生产环境
> **关联文档**：[回滚 SOP](ROLLBACK_SOP.md)、[灰度发布方案](CANARY_RELEASE.md)、[部署指南](RAILWAY_DEPLOYMENT_GUIDE.md)

---

## 一、故障分级标准

| 级别 | 定义 | 示例 | 响应时间 | 修复时限 |
|------|------|------|----------|----------|
| **P0 紧急** | 全站不可用或数据丢失 | 数据库宕机、前端无法访问、数据损坏 | 15 分钟 | 2 小时 |
| **P1 严重** | 核心功能不可用或安全漏洞 | 登录失败、RAG 问答不可用、XSS 漏洞 | 1 小时 | 8 小时 |
| **P2 一般** | 非核心功能异常或性能下降 | 文档搜索慢、邮件通知失败、上传超时 | 4 小时 | 24 小时 |
| **P3 低** | 体验问题或小 bug | UI 错位、文案错误、非关键警告 | 24 小时 | 下个迭代 |

---

## 二、故障处理流程

```
发现 → 评估分级 → 响应 → 修复 → 验证 → 复盘
 │        │         │       │       │       │
 │        │         │       │       │       └─ 24h 内编写事后复盘文档
 │        │       │       │       └─ 回归测试 + 确认修复
 │        │       │       └─ 编写修复代码 + 测试
 │        │       └─ 指定责任人 + 评估影响范围
 │        └─ 分配 P0-P3 级别
 └─ 告警/用户反馈/监控发现
```

---

## 三、常见故障处理

### 3.1 数据库连接耗尽（P0/P1）

**症状**：
- API 返回 500 错误，日志显示 `QueuePool limit of size X overflow Y reached`
- 健康检查 `/health` 返回 unhealthy

**排查步骤**：
1. 查看 Grafana 数据库面板，确认连接池使用率
2. 查看 Railway 日志，搜索 `QueuePool` 关键词
3. 检查是否有长查询阻塞连接

**处理步骤**：
1. 重启 API 服务（Railway Dashboard → Redeploy）
2. 如果是长查询阻塞，通过 psql 执行 `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'active' AND query_start < now() - interval '5 minutes';`
3. 调整连接池大小（环境变量 `DB_POOL_SIZE`、`DB_MAX_OVERFLOW`）
4. 排查是否有未关闭的数据库会话（代码层面）

### 3.2 Redis 不可用（P0/P1）

**症状**：
- 限流功能失效（fail-open）或所有请求被拒（fail-closed）
- 分布式锁无法获取，并发控制失效

**排查步骤**：
1. 检查 Railway Redis 服务状态
2. 在 Railway Console 执行 `redis-cli ping`
3. 查看 Redis 内存使用 `redis-cli INFO memory`

**处理步骤**：
1. 重启 Redis 服务（Railway Dashboard）
2. 如果内存满，执行 `redis-cli FLUSHDB`（注意：会清除所有缓存，但不影响数据）
3. 检查是否有过期键未正确设置 TTL

### 3.3 Celery 任务积压（P1/P2）

**症状**：
- 文档处理长时间无响应
- Flower 面板显示大量 PENDING/RETRY 任务

**排查步骤**：
1. 访问 Flower 面板查看任务状态
2. 检查 Worker 是否存活：`celery -A app.core.celery_app:celery_app inspect active`
3. 查看死信队列：`celery -A app.core.celery_app:celery_app inspect queues`

**处理步骤**：
1. 重启 Celery Worker（Railway Dashboard → Worker 服务 → Redeploy）
2. 如果是单任务卡住，通过 Flower 终止该任务
3. 检查死信队列中的失败任务，分析失败原因
4. 调整 Worker 并发数（环境变量 `CELERY_WORKER_CONCURRENCY`）

### 3.4 LLM 调用超时/降级（P1/P2）

**症状**：
- 问答响应极慢或返回降级提示
- 日志显示 `LLM call timeout` 或 `LLM resilience degraded`

**排查步骤**：
1. 查看 Sentry 错误面板，过滤 LLM 相关错误
2. 检查 OpenAI API 状态（status.openai.com）
3. 查看 Grafana RAG 链路面板，定位是检索阶段还是生成阶段超时

**处理步骤**：
1. 如果是 OpenAI 服务问题，等待恢复（LLMResilienceService 会自动降级）
2. 如果是网络问题，检查 Railway 出站网络
3. 调整超时时间（环境变量 `LLM_REQUEST_TIMEOUT`）
4. 如果持续超时，考虑切换到备用 LLM

### 3.5 前端无法访问（P0）

**症状**：
- 用户访问前端页面白屏或 502
- UptimeRobot 告警

**排查步骤**：
1. 检查 Railway 前端服务状态（是否 running）
2. 查看 Railway 前端日志
3. 直接访问 `/index.html` 确认 nginx 是否正常

**处理步骤**：
1. 重启前端服务（Railway Dashboard → Redeploy）
2. 如果是构建失败，检查最新部署的 Build 日志
3. 回滚到上一个稳定版本（Railway Dashboard → 选择上一个部署 → Redeploy）

### 3.6 文档处理失败（P2）

**症状**：
- 文档状态长时间停留在 `processing` 或变为 `failed`
- 日志显示 OCR/分块/向量化错误

**排查步骤**：
1. 查看文档详情中的 `error_message` 字段
2. 在 Flower 中搜索该文档的处理任务
3. 检查文件类型和大小是否超出限制

**处理步骤**：
1. 通过前端"重新处理"按钮重新提交
2. 如果是 OCR 失败，检查 Tesseract 是否正常安装
3. 如果是向量化失败，检查 pgvector 扩展和 Embedding 模型

---

## 四、紧急联系人矩阵

| 故障类型 | 第一联系人 | 第二联系人 | 升级联系人 |
|----------|------------|------------|------------|
| 数据库故障 | 后端负责人 | 运维负责人 | 技术负责人 |
| Redis 故障 | 后端负责人 | 运维负责人 | 技术负责人 |
| Celery 故障 | 后端负责人 | 运维负责人 | - |
| LLM/AI 故障 | AI 工程师 | 后端负责人 | 技术负责人 |
| 前端故障 | 前端负责人 | 运维负责人 | - |
| 安全事件 | 安全负责人 | 技术负责人 | 管理层 |
| Railway 平台 | 运维负责人 | 技术负责人 | - |

> **注意**：实际联系人信息请在此文档部署时填入。

---

## 五、应急操作手册

### 5.1 数据库切换

```bash
# 1. 确认主数据库不可用
psql $DATABASE_URL -c "SELECT 1;"

# 2. 切换到备用数据库（更新 Railway 环境变量）
# Railway Dashboard → Backend Service → Variables → DATABASE_URL

# 3. 重启所有服务
# Railway Dashboard → 全部服务 → Redeploy

# 4. 验证
curl https://<backend-domain>/health
```

### 5.2 Redis 故障转移

```bash
# 1. 确认 Redis 不可用
redis-cli -u $REDIS_URL ping

# 2. 重启 Redis
# Railway Dashboard → Redis Service → Redeploy

# 3. 验证
redis-cli -u $REDIS_URL ping
```

### 5.3 强制清理所有 Celery 队列

```bash
# 1. 停止 Worker
# Railway Dashboard → Worker Service → Pause

# 2. 清空队列
celery -A app.core.celery_app:celery_app purge

# 3. 清空死信队列
redis-cli -u $REDIS_URL DEL celery dead_letter

# 4. 重启 Worker
# Railway Dashboard → Worker Service → Resume/Redeploy
```

### 5.4 紧急回滚

详见 [回滚 SOP](ROLLBACK_SOP.md)

```bash
# 代码回滚：Railway Dashboard → 选择上一个部署 → Redeploy
# 数据库迁移异常：先按回滚 SOP 备份并在隔离库验证；不要直接在唯一生产库执行 downgrade
```

---

## 六、事后复盘模板

```markdown
# 事故复盘 - [事故名称]

## 事故概述
- 事故级别：P0/P1/P2
- 发生时间：YYYY-MM-DD HH:MM
- 恢复时间：YYYY-MM-DD HH:MM
- 影响时长：X 小时 Y 分钟
- 影响范围：受影响的功能和用户数

## 时间线
| 时间 | 事件 |
|------|------|
| HH:MM | 告警触发/用户反馈 |
| HH:MM | 开始排查 |
| HH:MM | 定位根因 |
| HH:MM | 开始修复 |
| HH:MM | 修复完成 |
| HH:MM | 验证通过 |

## 根因分析
（描述根本原因，而非表面现象）

## 影响评估
- 用户影响：
- 数据影响：
- 业务影响：

## 修复措施
（描述临时修复和永久修复）

## 改进措施
| 改进项 | 负责人 | 完成时限 | 状态 |
|--------|--------|----------|------|
| | | | |

## 经验教训
（记录本次事故的教训，避免类似问题再次发生）
```

---

## 七、监控告警参考

| 告警规则 | 条件 | 级别 | 处理章节 |
|----------|------|------|----------|
| API 5xx 错误率高 | > 10% 持续 5 分钟 | Critical | 3.1 / 3.5 |
| API 响应慢 | P95 > 2s 持续 10 分钟 | Warning | 3.1 |
| 数据库连接池满 | 使用率 > 90% | Critical | 3.1 |
| Redis 不可达 | 持续 1 分钟 | Critical | 3.2 |
| Celery 队列积压 | > 100 个任务 | Warning | 3.3 |
| LLM 超时率 | > 20% | Warning | 3.4 |
| 健康检查失败 | 连续 3 次失败 | Critical | 对应章节 |
| 磁盘空间不足 | > 85% | Warning | 清理日志/备份 |

---

> 本手册应定期更新，每次重大故障后补充新的处理案例。
> 建议每季度进行一次故障演练，验证应急操作流程的有效性。
