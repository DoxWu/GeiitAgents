# 服务器离线联合恢复包

联合包把某一静止时点的云端 PostgreSQL、`UPLOAD_DIR` 中的原件/派生文件和显式选择的恢复配置封装为一个 AEAD 加密文件，并为每个文件记录 SHA-256、大小及数据库中的活动文档引用。此工具由隔离终端执行，不是在线恢复 HTTP API，不包含客户端工作台/本地知识库，也不替代现有数据库快照。

## 范围

- PostgreSQL 自定义归档：全部 `public` 表、pgvector 数据、迁移版本和数据库记录。
- 上传目录的全部常规文件，包括图像提取子目录；有任何符号链接、Windows reparse point、多硬链接或活动文档指向目录外/缺失文件时拒绝创建。
- 管理员逐个指定的配置文件。配置以同一加密层保护；永远不递归猜选 `.env`、Secret、集群凭据或密钥文件。恢复后管理员需审阅配置再写入秘密管理器。
- 不包含 PostgreSQL/对象存储的连接配置（除非管理员显式选入配置文件）、本机工作台/本地知识库、本机模型权重、Redis 队列/会话，以及上传目录以外的外部对象存储。外部存储要另行纳入部署者的备份策略。

## 静止点与密钥

创建前从部署编排层**停止并核对 API、所有 worker、beat、清理进程和 ops monitor**；确认没有上传、删除、重处理或数据库写事务后才运行命令。脚本要求显式 `--writers-stopped`，也持有数据库维护 advisory lock、以 repeatable-read 导出数据库并在归档前后重新核对上传文件清单和每个文件元数据/hash。Web/API 自身不使用这把数据库 advisory lock；因此停写条件必须真实成立，不能把 flag 当作自动停机或锁全部上传写入的机制。发现文件在扫描中变化会拒绝发布归档。RPO 是每次离线包对应的停写检查点；停写时长和完整备份/恢复时长取决于数据量，首次应实际计时，应用不宣称固定 RTO。

联合包使用与现有备份一致的独立 32-byte base64 `BACKUP_ENCRYPTION_KEY` 和 `BACKUP_SOURCE_ID`。Source ID 参与 AEAD 认证，密钥错误或 source 错配会拒绝解密。密钥必须通过独立受控方式保管；不要把密钥放进被打包的配置文件、归档同目录、Git、工单或命令参数。保留在线加密 PostgreSQL 快照作为第二条恢复路径。

## 创建与校验

在 backend 工作目录、运行配置已安全注入进程的离线运维终端中执行。停写后，输出归档应落到受控的独立备份盘。示例路径仅是示例：

```bash
python -m app.ops.recovery_bundle create \
  --writers-stopped \
  --bundle /secure-backups/site-20261020.geiit-recovery \
  --uploads /app/uploads \
  --app-root /app \
  --config-file runtime.env=/secure-config/recovery-runtime.env

python -m app.ops.recovery_bundle verify \
  --bundle /secure-backups/site-20261020.geiit-recovery
```

每一项 `--config-file ALIAS=PATH` 都会复制进加密包的 `config/ALIAS`，可重复指定；不要导入密码、真实路径或 secrets 到示例记录。校验先认证解密、检查 tar 清单与所有文件路径/hash，再用版本匹配的 `pg_restore` 在 `BACKUP_VERIFY_ADMIN_URL` 配置的专用临时 PostgreSQL/pgvector 环境创建随机库并完整恢复演练。临时库使用后删除。创建只在验包通过后以不覆盖方式发布输出文件。

## 空环境恢复

准备与归档兼容的 PostgreSQL/pgvector **空库**，在离线恢复进程中把 `DATABASE_URL` 和 `BACKUP_VERIFY_ADMIN_URL` 明确指向隔离环境，并保留兼容的 `BACKUP_SOURCE_ID`、恢复密钥和客户端工具。选用全新的、由目标运行时服务用户拥有的工作目录：

```bash
python -m app.ops.recovery_bundle restore \
  --writers-stopped \
  --bundle /secure-backups/site-20261020.geiit-recovery \
  --workspace /recovery/instance-a
```

该命令只接受空数据库和不存在的工作目录，不会覆盖现有数据或自动切流。顺序为：全包认证/路径与哈希验证 → 在临时数据库作恢复演练 → 确认空目标 → 将文件写入新 workspace 并检查哈希 → 数据库恢复及 schema/行数/vector 检查 → 把活动文档 `file_path` 重定位到新 workspace 的 `uploads/` 并核对 → 写本机恢复回执并移除 `RESTORE_INCOMPLETE` 标记。**目录里的 `uploads/` 是上传文件树，`config/` 仍只是隔离的待审阅备份文件**；部署者必须在继续启动前逐项审阅并把配置秘密放入目标 Secret 管理系统，将 `UPLOAD_DIR` 配置为回执中的新 uploads 路径。恢复目录建成后应保持其绝对路径稳定，否则数据库文档路径会失效。

恢复中途崩溃会留下 `RESTORE_INCOMPLETE` 和已恢复的部分文件。不得启动 API/worker、不得删除标记后复用该 workspace；先检查数据库/文件，再准备**新的空库与全新 workspace**重做。现有恢复目录和非空数据库都拒绝覆盖。Redis 队列与会话不在包内；待处理文档的 Celery 消息不会自动恢复，应在审阅文档状态后通过应用的重处理流程重新派发。部署后需人工验收登录、文件预览/下载、重处理、向量查询及待办等业务，再按部署平台单独演练 PVC/对象存储、DNS/服务切换、运行配置、RPO/RTO 和回滚；此模块不管理部署编排。

## 实现验证

实现提供 `create`、`verify`、`restore` 三条离线命令；不含数据库密码的命令行参数，不输出 DSN、文件名、配置内容或原生错误正文；所有输出包扩展名已加入 Git 与前后端 Docker 构建上下文忽略规则。测试使用合成数据库/文件/配置。隔离 PostgreSQL 联合恢复测试还会用真实登录、文本/PDF 下载、向量检索和待办读写核验恢复后的业务，并检查文档路径已指向新 workspace。目标环境的真实密钥保管、停止/启动编排、外部卷、物理断电及异地恢复仍须由部署方验收。
