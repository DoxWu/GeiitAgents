# Sealos 故障恢复、异地备份与告警

## 已实现的行为

- API 启动读取环境变量，等待 PostgreSQL 可用，检查 Alembic 版本和关键表，自动迁移；直接用 uvicorn 启动也适用。
- 运行期间默认每 60 秒检查数据库，数据库恢复连接后再次检查/迁移，无需人工登录容器执行命令。
- 启动、迁移、备份和恢复共享数据库咨询锁，避免本应用多副本互相干扰。手工 SQL/外部工具仍需自行暂停写入。
- `/live` 只检查进程；`/ready` 和兼容路径 `/health` 检查数据库结构及 Redis，异常返回 HTTP 503，正常 200。
- 可选 `ROLE=ops` 独立进程做周期备份、依赖检查、故障和恢复邮件。邮件不依赖主数据库/Redis/Celery。
- 默认不启用异地备份、自动还原或邮件，没有配置信息时不会连接外部备份服务。

自动迁移只能重建结构，不能找回已经丢失的用户、密码、文档或对话。没有备份时，空库可重新初始化服务，但原账号无法凭空恢复。可选初始管理员也不是用户数据恢复。

## 先排查数据为什么丢失

正常 PostgreSQL 重启应保留已持久化的数据。当前代码无法确认你实际 Sealos 的存储状态，部署时检查：

1. 确认数据库使用持久化 PVC，PVC 为 Bound；实际 `SHOW data_directory` 指向的目录位于挂载卷内，不是容器临时文件系统。不同 PostgreSQL 镜像和版本目录可能不同，不要盲目复制路径。
2. 检查旧 PVC 是否被删除、替换，重建服务时是否创建了新空卷；查 Sealos 事件、数据库日志、存储账单/容量和回收策略。原卷仍存在时先保全，可能仍有可恢复数据。
3. 确认重启后 DATABASE_URL 的主机、数据库名和命名空间没有改变；URL 必须持久保存于 Sealos Secret/环境变量。
4. 同样持久化 `/app/uploads` 与 `/app/data`，Redis 使用持久化配置。不要用删除数据库服务/PVC 的方式测试重启。
5. 保持 JWT `SECRET_KEY` 稳定。重新生成它会让旧登录令牌失效，但不会清除数据库账号。

## 目前还没有异地库时

在 Sealos API 环境变量保留：

```dotenv
MIGRATE_ON_STARTUP=true
DB_RECOVERY_ENABLED=true
DB_STARTUP_TIMEOUT_SECONDS=300
BACKUP_ENABLED=false
RESTORE_ON_EMPTY=false
OPS_ALERTS_ENABLED=false
```

主库账号需要应用表的 DDL 权限，以及首次创建 pgvector 扩展的权限（或由数据库管理员预装扩展）。连接必须指向已存在的数据库；应用不会自动创建主数据库服务、PVC 或修复供应商基础设施。

如需在完全丢失数据后创建一个能登录的管理员，设置 `BOOTSTRAP_ADMIN_ENABLED=true` 及 `SUPERUSER_USERNAME`、`SUPERUSER_EMAIL`、`SUPERUSER_PASSWORD`。密码仍遵守账户规则（至少 8 位且含字母和数字），与客户端四位本地解锁口令无关。只有 users 表没有任何用户时才创建；恢复备份或有任何用户时不修改账号。首次初始化后建议关闭并移除该密码。

## Sealos 探针

把下面字段合并到 API 容器配置中，端口随 PORT 调整：

```yaml
startupProbe:
  httpGet: {path: /live, port: 8000}
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 120
livenessProbe:
  httpGet: {path: /live, port: 8000}
  periodSeconds: 30
  timeoutSeconds: 3
  failureThreshold: 3
readinessProbe:
  httpGet: {path: /ready, port: 8000}
  periodSeconds: 30
  timeoutSeconds: 20
  failureThreshold: 2
```

启动重试总预算默认 300 秒；单次迁移/恢复工具默认最多 600 秒，启动探针要留出足够时间。大数据库恢复需要同时增加相关预算。依赖异常时移除流量，不因数据库/Redis 故障重启 API；不要将 `/ready` 用作存活探针。Sealos UI 若只有一种健康检查，需要确认它实际对应哪种探针，必要时编辑 YAML。

## 创建异地备份与验证环境

在其他服务商准备：

| 资源 | 要求 |
| --- | --- |
| 备份存储数据库 | 专用空 PostgreSQL 库，账号可创建 `geiit_backup` schema、表并读写；不能与主库相同 |
| 恢复演练管理连接 | `CREATEDB`，有权删除自己创建的库，服务器装有兼容 pgvector，能恢复源库使用的扩展 |
| 独立监控进程 | 在 Sealos 之外运行一份 ops 服务，可访问主库/备份库、站点 HTTPS 和邮件服务 |

备份库保存的是 AES-256-GCM 加密的分块归档，不是可以直接切流的在线副本。多个源使用不同 BACKUP_SOURCE_ID，避免混用。存储账号不需要 pgvector，恢复演练环境需要；两者可在同一外部 PostgreSQL 实例。许多托管服务不开放 CREATEDB，此时另配可创建临时库的验证服务器。建议 PostgreSQL/pgvector 与主库同版本；pg_dump 客户端不能低于源库主版本，恢复到较旧主版本不受支持。

镜像安装发行版的 `postgresql-client`。部署前运行 `pg_dump --version` 与主库 `SHOW server_version` 比对；如果主库比镜像客户端新，先在构建镜像中安装对应主版本客户端。当前尚未获取你线上 PostgreSQL 的版本，不能预先保证版本匹配。

公网数据库连接使用服务商要求的 TLS，优先 `sslmode=verify-full` 和可信根证书，至少 require；限制来源网络/IP。不要为此将主库无保护地开放到公网。也可通过专用隧道/VPN访问。数据库原有 RLS/权限限制不得让备份账号漏掉应用数据。

## 配置与启动

1. 外部主机复制 `backend/.env.example` 为 `.env.ops`，配置主库 DATABASE_URL、备份 BACKUP_DATABASE_URL、演练 BACKUP_VERIFY_ADMIN_URL。URL 中密码的特殊字符需百分号编码。
2. 执行 `python -m app.ops.cli generate-key` 生成 BACKUP_ENCRYPTION_KEY，保存到密钥管理器/离线安全副本。恢复端使用同一密钥。不要随意换密钥，旧快照不会自动重加密。
3. 设置 `BACKUP_ENABLED=true`，默认每 24 小时备份、保留 7 份。第一次启用后立即做手动备份/验证，再启用自动恢复。
4. 配置 `OPS_MONITOR_URL=https://你的站点域名/ready`。本次前端 Nginx 已添加该路径的后端转发，需要同时部署更新后的前端镜像；也可以用后端公网域名。再设置 `OPS_ALERTS_ENABLED=true`、ADMIN_NOTIFY_EMAIL、EMAIL_FROM，及 EMAIL_PROVIDER=http + RESEND_API_KEY，或 smtp + SMTP_*。STARTTLS 与隐式 TLS 二选一。
5. `docker compose -f docker-compose.ops.yml up -d --build`。该部署文件不开放任何入站端口。只运行一个监控副本并持久化 ops_state，防止重复告警。可再用独立 uptime 服务监视此监控主机自身。

只做站点监控时可以留空数据库/Redis连接，关闭备份，仅填 OPS_MONITOR_URL 和邮件设置。若 Sealos 不允许外部直连数据库，先用此方式启用平台故障邮件。

在 backend 目录，或容器 `/app`，使用相同环境变量执行：

```bash
python -m app.ops.cli check      # 依赖/最近备份检查，失败非零退出
python -m app.ops.cli backup     # 首次立即备份；间隔未到返回 not-due
python -m app.ops.cli verify     # 下载最新有效备份，验证解密并再次完整恢复演练
python -m app.ops.cli startup    # 与应用启动相同的检查/迁移流程
```

每次快照使用同一个 PostgreSQL 一致性快照做 pg_dump 和表行数统计；恢复到随机临时库，核对表、行数、迁移版本、pgvector，再从异地库读回解密/hash 校验。全部通过后提交为有效快照，最后清理超出保留数量的旧版本。失败不轮换旧快照；默认拒绝备份没有用户的源库。备份库连接失败、最近有效备份超过两倍间隔也会触发监控。

默认连续失败 3 次告警，持续异常每小时最多再次通知一次，恢复后发恢复邮件；发送失败会重试。故障详情不写连接串、密码或用户文档内容。邮件投递仍依赖所选邮件提供商，部署后需用受控方式验证收件箱，代码测试不会代你发送真实邮件。

## 自动与手动恢复

确认已有有效快照后，在 Sealos API 配置同样的备份连接、密钥、SOURCE_ID、验证连接，设置 `RESTORE_ON_EMPTY=true`。

恢复顺序是：数据库可连接 → 获取锁 → 确认目标完全空 → 下载近期有效快照并解密校验 → 临时库恢复演练 → 再次确认目标空 → 单事务恢复目标 → 校验 → 迁移到当前程序版本。

开启自动恢复后，如果找不到近期有效备份、密钥错误、数据损坏或演练失败，启动保持失败并告警，不降级为新空库。默认最多接受 168 小时内的备份。已有表/数据时绝不自动清空或覆盖；部分表损坏、只有 Alembic 标记还在等情况需要人工判断，自动迁移不等于任意结构修复。

手动恢复仅支持专门准备的空目标库，将 DATABASE_URL 指向该库后执行 `python -m app.ops.cli restore`，然后执行 startup。没有自动覆盖生产库的命令。

## 范围与容量

- 这是定时备份恢复，不是自动主从切换或 PITR。默认最多可能丢失上次成功快照之后约 24 小时的数据，备份故障时窗口更长；恢复时间取决于数据量和网络，首次应测量演练时长。
- 备份仅包含 PostgreSQL。`/app/uploads` 文件字节、对象存储、Redis 任务/会话以及环境变量要另行备份。仅恢复数据库不代表所有文档文件都回来了。
- 本地临时目录需要至少两份 dump 的空间；BACKUP_MAX_BYTES 是完成导出后的大小校验，不是导出过程中硬磁盘配额。应限制容器临时盘并监控容量。
- 验证服务器需要至少一份完整恢复数据库的磁盘/内存。外部存储容量按压缩 dump 大小 × 保留份数加余量规划；数据量很大时对象存储与专业备份工具通常更合适。
- 不应自动执行 drop/recreate 数据库、删除 PVC 或无条件回滚。长期建议同时启用服务商原生自动备份/快照，与应用备份互补。

## 本地验证

2026-09-17：在单独启动的本地 PostgreSQL 18 + pgvector 集群完成 15 项运维测试，相关配置/模型/私有连接回归 257 项通过。覆盖空库迁移、重复启动、备份加密与损坏拒绝、还原后密码/向量/序列一致、主库丢失后自动恢复、过期备份拒绝、故障告警阈值及投递失败重试、存活/就绪 HTTP 状态。生产配置字段拼写错误也已修复并验证。

已检查 Python 编译、Shell 语法、Compose YAML 和 Railway JSON。当前未构建/运行容器镜像（本机 Docker daemon 未运行），未验证实际 Sealos 网络/PVC/权限，也没有向真实管理员发送邮件；这些需要在部署环境验证。

`tests/test_ops.py` 包含隔离 PostgreSQL/pgvector 演练和告警单元测试。集成测试只有显式设置 `GEIIT_OPS_TEST_ADMIN_URL` 才运行，要求 localhost/127.0.0.1 的专用 ops_test 用户；使用随机数据库名，只删除本次创建的测试库。不要指向真实服务。

```bash
GEIIT_OPS_TEST_ADMIN_URL=postgresql://ops_test@127.0.0.1:55439/postgres python -m pytest tests/test_ops.py -q
```
