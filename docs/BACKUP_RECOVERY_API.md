# 备份与恢复管理接口

更新日期：2026-09-20。应用能力独立于供应商，当前不要求确定或变更部署方案。已有环境变量、CLI 与 `ROLE=ops` 仍保留，本批增加管理员页面和持久任务接口。

## 应用入口和行为

管理员在“设置 → 系统数据保护 → 备份与恢复”进入 `/admin/backup-recovery`。页面按路由懒加载，显示启用状态、执行器最近心跳、快照、最近任务；提供立即备份、指定快照验证、恢复预检查/确认、取消待执行任务。可见页面每 15 秒更新状态，隐藏时不轮询。

正常管理员 API 使用原有账户认证和 superuser 校验，普通用户和游客不能调用。所有响应禁止缓存；客户端不能提交连接串、密钥、SQL 或命令。连接凭据只来自运行环境，状态响应采用字段白名单。

备份/验证/恢复提交后返回 202 和任务记录，执行不在 HTTP 请求内进行。任务存在备份数据库的 `geiit_backup.jobs`，由 `ROLE=ops` 消费，不依赖主库的业务任务表、Redis/Celery 或浏览器连接。主库不可用时管理员登录仍可能不可用，因此灾难恢复保留独立 CLI；没有新增绕过账户认证的公开恢复入口。

## 配置契约

| 环境变量 | 默认 / 用途 |
| --- | --- |
| `OPS_API_ENABLED` | false；启用管理接口操作和 ops 任务消费。关闭时 status 仍返回不含敏感信息的禁用状态 |
| `BACKUP_ENABLED` | false；允许自动及手动备份，关闭后仍可在管理接口启用时验证/恢复已有快照 |
| `DATABASE_URL` | 当前应用主库，用于备份；不经 HTTP 修改 |
| `BACKUP_DATABASE_URL` | 专用备份库，保存加密归档与任务记录，不能指向应用数据库 |
| `BACKUP_VERIFY_ADMIN_URL` | 用于每次实际还原演练的临时库管理连接 |
| `BACKUP_ENCRYPTION_KEY` | 既有备份加密密钥，不返回浏览器；恢复端必须一致 |
| `BACKUP_SOURCE_ID` | 实例/数据源标识，隔离快照、任务和工作锁 |
| `RESTORE_TARGET_DATABASE_URL` | 可选，预先准备的独立空目标库，仅 HTTP 恢复使用 |
| `RESTORE_TARGET_NAME` | 默认 recovery，可读别名，1～64 位字母/数字/下划线/横线 |
| `RESTORE_ON_EMPTY` | 原有主库启动恢复开关，与 HTTP 恢复独立；不会因开启管理页面而自动开启 |

API 与 ops 使用一致的数据源、密钥、恢复目标配置。队列/快照 schema 仅在显式启用后的心跳或提交时初始化；仅读状态不会建库建表。初次启用且执行器未连接时，页面显示等待状态。

不在本批指定外部服务商或创建任何真实资源。接口可先用隔离测试库验证；后续部署只需满足上述配置契约。

## HTTP 接口

前缀 `/api/v1/admin/maintenance`，均要求当前活跃管理员 Bearer Token。

| 方法 / 路径 | 功能 |
| --- | --- |
| GET `/status` | 是否启用、备份周期/保留数、恢复目标别名、存储可达性和执行器最近心跳 |
| GET `/snapshots?limit=50` | 当前 SOURCE_ID 的快照摘要，按创建时间倒序；limit 为 1～100 |
| GET `/jobs?limit=50` | 当前 SOURCE_ID 最近任务，含操作人 ID、状态、时间和固定错误码 |
| GET `/jobs/{job_id}` | 按任务 ID 查询结果，不返回目标连接或内部确认指纹 |
| POST `/restore-plan` | 预检查指定快照是否存在、已验证且未过期，目标是否为空；返回目标别名和绑定指纹 |
| POST `/jobs` | 幂等提交 backup/verify/restore，成功返回 202；立即备份不受自动周期限制 |
| POST `/jobs/{job_id}/cancel` | 原子取消 queued；running 或已结束返回 409 |

备份提交示例（request_id 是调用方为本次操作生成的 UUID）：

```json
{"kind":"backup","request_id":"79fe40bb-4f09-4464-b4da-2a3f45c00a01"}
```

验证请求额外传入 `snapshot_id`（32 位小写十六进制）。恢复先调用：

```json
{"snapshot_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

客户端核对返回的目标别名，再提交以下字段：

```json
{
  "kind":"restore",
  "request_id":"79fe40bb-4f09-4464-b4da-2a3f45c00a02",
  "snapshot_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "target_stamp":"预检查返回的64位指纹",
  "confirmation":"recovery"
}
```

示例 ID 均为占位数据。snapshot_id 不支持路径、连接串或 SQL；请求 schema 拒绝额外字段。

任务状态为 queued、running、succeeded、failed、interrupted、cancelled。成功包含 result_snapshot_id；失败仅返回固定 error_code，不含数据库原始错误。常见 HTTP 错误：401/403 无权限，409 前置条件/目标/幂等冲突，422 请求无效，429 队列已满，503 功能关闭或存储不可用。

## 恢复保护及任务一致性

- 同一 SOURCE_ID + request_id 只能对应一次操作，重试返回原任务；操作、快照、目标指纹或操作人不同则拒绝。页面对网络结果不确定的原操作重用 ID；刷新页面后应先检查任务列表，不能宣称任意新 ID 也去重。
- 每个数据源最多 20 个 queued/running 任务。只能取消排队任务，取消与领取使用条件更新，避免已执行任务被误标为取消。
- 执行器使用备份库会话锁，同一数据源不会有两个队列消费者并发执行。主库/目标库维护锁继续保护备份、迁移与恢复。
- 执行器崩溃后，下个持锁消费者把遗留 running 标记 interrupted。对于“恢复可能完成，但结果尚未写回”的情况不自动重放；管理员核查目标后再决定下一步。
- 快照选择在提交时固定，不因之后新增快照改成“最新”。queued/running 引用的快照暂缓保留策略清理，完成后的下一次备份可再清理。
- 恢复前置检查、提交及实际恢复均核验目标。预检查只判断基本条件，不代替完整恢复演练；执行仍检查加密完整性、近期窗口、临时库还原、目标空库和单事务还原。
- 目标配置变更会使已排队的恢复失效；相同地址下新增任何业务表会拒绝覆盖。恢复不切换当前应用 DATABASE_URL，也不删除主库。若后续切换到较旧快照的库，沿用启动迁移到应用当前版本。
- 手动任务失败/中断可被独立监控作为 `maintenance-backup/verify/restore` 告警，使用原有阈值与恢复邮件规则；同类后续成功恢复健康状态。是否真正发信由 OPS_ALERTS_ENABLED 控制。

## CLI 补充接口

在 backend 目录加载同样的运维配置后：

```bash
python -m app.ops.cli backup --force
python -m app.ops.cli verify --snapshot-id <id>
python -m app.ops.cli jobs
python -m app.ops.cli work-once
python -m app.ops.cli monitor
```

`work-once` 更新心跳并最多处理一个任务，便于独立进程/测试调用；`monitor` 持续处理，手动队列任务优先于同一轮自动备份，重型操作不占用监控线程。

原有 `restore --snapshot-id <id>` 直接以 **DATABASE_URL** 为目标，仅允许空库，不使用 RESTORE_TARGET_DATABASE_URL；HTTP 队列恢复才使用后者。CLI 在主库故障、API 无法登录时仍可运行。凭据不作为命令行参数。

## 当前范围

- 数据范围仍是 PostgreSQL，尚不包括上传文件字节、对象存储和 Redis；不能称为全系统零丢失恢复。
- 列表一次最多 100 条，任务记录保留用于审计/幂等，尚未增加历史归档策略；数据量增长后需要补游标分页和归档规则。
- 管理员页面依赖现有认证；队列记录独立于主库不意味着网页登录也独立。
- 暂无运行中强制中止、删除快照、任意目标 URL、在线覆盖现库或自动切流接口。
- 前端仅增加懒加载管理页面，不影响客户端本地向量模型默认/安装策略；本地知识库的下载、推理和索引继续作为下一阶段应用改造。

## 验证

新增后端测试使用专用隔离 PostgreSQL 集群，不连接生产。覆盖权限、非法输入脱敏、幂等、任务消费、指定快照恢复、空库重检、目标变更、中断标记、单消费者、快照保留、队列容量与来源隔离。

2026-10-20 在隔离 Docker PostgreSQL 16.14 + pgvector 上，使用匹配的 PostgreSQL 16.14 `pg_dump`/`pg_restore` 运行恢复与维护队列 29 项，均通过，且纳入后端全量 747 项。宿主 PostgreSQL 18 工具生成的归档恢复到 PostgreSQL 16 曾因跨主版本不兼容失败；换用匹配工具后通过。部署时核对源库、导出/恢复客户端和目标库版本，优先保持同主版本；`pg_dump` 不能低于源库版本，恢复到较旧主版本不受支持。这不等于目标部署、上传文件或配置的联合恢复已完成。

前端测试覆盖禁用状态、确认门槛、未知提交结果重试与中断展示。`frontend/scripts/verify-maintenance.mjs` 使用模拟 API 验证桌面和 390px 窄屏、确认与提交，不会执行真实备份恢复。截图输出到 `.tools/maintenance-qa/`。具体本次测试结果记录在 [工作记录](WORK_LOG.md)。
