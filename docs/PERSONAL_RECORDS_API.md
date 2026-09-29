# 个人记录与邮件提醒 API

个人记录接口位于 `/api/v1/personal`，只服务正式账号。客户端本机 Note/Todo 使用独立的 AES-GCM 本地库，不会因为调用这些接口而自动上传；下面的接口是用户明确选择的服务端记录和邮件提醒。

所有响应都带 `Cache-Control: no-store`。记录按当前账号隔离，找不到其他账号的 ID 时返回 `404 record_not_found`，数据库暂时不可用时返回 `503 personal_storage_unavailable`。

## 本机能力检查

`GET /capabilities`

返回：

```json
{
  "email_reminders_enabled": false,
  "recipient_policy": "account_email",
  "scheduler_interval_seconds": 60
}
```

只有 `email_reminders_enabled=true` 时才允许创建提醒；它要求服务端同时启用邮件和提醒配置。收件人固定为当前账号的有效邮箱，客户端不能指定其他收件人。

## Note 与 Todo

### Note

- `GET /notes?q=&limit=50&offset=0`
- `POST /notes`：`title`、`content`、`tags`
- `PATCH /notes/{id}`：必须带 `revision`，其他字段可选
- `DELETE /notes/{id}`

### Todo

- `GET /todos?q=&status=open|completed|cancelled&overdue=true&limit=50&offset=0`
- `POST /todos`：Note 字段加 `status`、`priority`、`due_at`
- `PATCH /todos/{id}`：必须带 `revision`
- `DELETE /todos/{id}`

`due_at` 接受带时区的 ISO 8601 时间，服务端保存 UTC。更新时若 `revision` 不匹配返回 `409 revision_conflict`。Todo 进入 `completed` 或 `cancelled` 后，关联的未发送提醒会被取消。

## Reminder

### 创建与列表

- `GET /reminders?limit=50&offset=0`
- `GET /reminders/{id}`：按当前账号读取单条最新版本，用于编辑冲突后明确重新载入
- `GET /reminders/by-request/{UUID}`：按当前账号的创建请求标识核查结果，找不到或属于其他账号均返回 404；不会创建或重试提醒
- `POST /reminders`

创建请求：

```json
{
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "subject": "提交周报",
  "body": "请在今天完成周报。",
  "timezone": "Asia/Shanghai",
  "recurrence": "once",
  "next_run_at": "2026-10-01T09:00:00+08:00",
  "todo_id": null
}
```

`recurrence` 支持 `once`、`daily`、`weekly`。`next_run_at` 必须晚于当前时间，保存时转换为 UTC；`timezone` 必须是 IANA 时区。相同账号和 `request_id` 重复提交时，若请求内容相同返回原记录（HTTP 200）；内容不同返回 `409 idempotency_conflict`。

### 提醒及投递的游标分页

- `GET /reminders/page?limit=20&q=&status=&recurrence=`，可搜索主题/正文并筛选状态与重复规则，q 最多 200 字符，通配符按普通字符处理
- `GET /reminders/{reminder_id}/deliveries/page?limit=20`

返回结构为 `{ "items": [...], "snapshot_id": 123, "next_cursor": 104 }`。`limit` 范围 1–100，默认 20；`next_cursor=null` 表示已到末页。后续页传 `cursor=<next_cursor>&snapshot_id=<首次返回的 snapshot_id>`；返回较早页面时使用保存的该页起始 cursor，并保留同一个 snapshot_id。首次无结果返回空 items、snapshot_id=0、next_cursor=null。

两类记录都按固定 ID 降序读取，条件为 `id <= snapshot_id AND id < cursor`，每次最多读取 limit+1 条，不使用大 OFFSET 或全表 COUNT。首次请求返回的 snapshot_id 是本次浏览的新增记录上界，之后新插入的更大 ID 通过刷新/重新打开查看。已存在记录的改期、状态更新不会改变其分页位置，cursor 对应行被删除后仍能继续翻页。所有查询仍限定当前账号及对应 Reminder；游标不是访问凭据。

这里的 snapshot_id **不是数据库时间点快照**：每页返回请求时可见的最新字段值，被删除的记录不会保留；跨请求不持有数据库事务，也不保证更早分配 ID、稍后才提交的并发插入一定出现在此次浏览中。需要观察新变化时刷新。旧的数组型 `GET /reminders`、`GET /reminders/{id}/deliveries` 及 offset/limit 行为保留兼容；旧提醒列表按计划时间排序，不具备新接口的稳定位置约定。

### 修改与取消

- `PATCH /reminders/{id}`：必须带 `revision`，可更新主题、正文、时区、重复规则、下一次时间、关联 Todo 或状态 `active|paused|cancelled`
- `DELETE /reminders/{id}`：等价于取消并使 `next_run_at=null`

服务端存在 `sending` 或 `unknown` 投递时，只允许先暂停或取消；其他修改返回 `409 delivery_in_flight_or_unknown`。修订号不匹配返回 `409 revision_conflict`。

修改 `timezone` 或 `recurrence` 的值时，必须同时提供未来的 `next_run_at`，否则返回 `422 rule_change_requires_schedule`；下一次时间会同时成为新重复规则的 `anchor_at`。只修改主题或正文不会移动计划时间。已取消/已结束的提醒不能通过 PATCH 重新激活，返回 `409 reminder_closed`；需要再次提醒时创建新记录。暂停后原计划已过期时，恢复必须提供新的未来时间。

每次成功修改会增加修订号，并在同一事务中取消旧版本 `pending`/`failed` 的 `ReminderDelivery` 与对应 `EmailLog`。已进入 broker 的旧消息到达 worker 时也会重新核验修订号和状态，因此不会继续投递旧计划。已开始调用邮件服务商的请求无法撤回；此时暂停/取消只影响之后的发送，返回的投递结果仍可能为 `sent`。

### 投递记录与重试

- `GET /reminders/{reminder_id}/deliveries?limit=50&offset=0`
- `POST /reminders/{reminder_id}/deliveries/{delivery_id}/retry`

请求体：

```json
{ "acknowledge_duplicate_risk": true }
```

只有 `failed` 或 `unknown` 投递可重试。`unknown` 表示连接中断时无法确认服务商是否已接受邮件，必须显式传 `true`，否则返回 `409 duplicate_risk_acknowledgement_required`。客户端也必须在调用前向用户展示重复发送风险。邮件服务商接受不代表收件箱已经送达。

重试还要求提醒处于 `active` 且修订号与投递匹配；暂停或修改后的旧投递不能直接重试。

### 人工结束结果不明的尝试

`POST /reminders/{reminder_id}/deliveries/{delivery_id}/dismiss`

```json
{ "acknowledge_delivery_uncertainty": true }
```

只允许 `unknown`，`sending` 必须等待结果或超时判定；拒绝时返回 `409 delivery_not_dismissible`。缺少显式确认返回 `409 delivery_uncertainty_acknowledgement_required`。结束后投递和邮件日志标记 `cancelled`，保留 `uncertain_delivery_dismissed`，界面显示“人工结束（可能已发送）”。这不是发送失败证明，也不是邮件撤回。对已人工结束的同一投递重复调用，返回原记录，适用于 HTTP 响应丢失后的安全重试。

若该投递仍是运行中提醒的当前修订，结束时将计划推进到下一周期；一次性提醒变为 `completed`，但不会伪造 `last_run_at` 或 `sent_at`。暂停/取消/其他修订的提醒不自动恢复或改变其计划。人工结束后，用户可以修改暂停记录并选择新时间恢复。

## 客户端编辑行为

- 支持主题、正文、下一次时间、IANA 时区及一次/每日/每周规则编辑。表单以记录的时区显示与转换，设备所在时区不会替换原记录时区。
- 首次安排/改期时，夏令时跳变中不存在的时刻拒绝保存，回拨重复时刻提供两个实际 UTC 时刻供用户选择。后续周期沿用服务端规则：不存在的时刻顺延跳变间隔、重复时刻取第一次。
- 保存携带打开表单时的 `revision`。遇到冲突保留草稿、禁止直接覆盖重试，提供“载入最新版本（放弃草稿）”；载入后按新修订重新编辑。仅正文修改不因为表单分钟精度丢失原计划的秒数。
- 草稿按服务端地址/账号 ID/邮箱组合本机加密持久化，输入停止 400 毫秒后保存，锁库前冲刷；提交快照加密成功才发 HTTP。未知创建或编辑结果跨刷新保留，提供“核查上次提交”“重试同一提交”，不会自动重发或换创建标识。GET 查不到不证明请求未执行；已知校验错误允许修改，修订冲突仍需明确载入最新记录。存储失败不能保证最后输入已保存。
- 账号变化会卸载旧表单并取消创建/编辑客户端等待，旧结果不写入新页面；旧账号加密草稿保留，再次使用该账号可恢复。这不会撤销已被服务端接受的请求。
- 界面已接入新分页接口：提醒和投递各有独立的上一页/下一页，每页最多 20 条，仅保留当前提醒页和展开的当前投递页；翻页不累计所有历史。翻页失败保留当前页/游标及草稿。提醒刷新重置浏览上界且保持当前搜索/筛选，改变查询后从第一页开始；投递重新打开读取新上界；成功创建后刷新到当前筛选第一页。正文超过 500 字符默认折叠。归档及批量导出仍未实现。
- 已有三个内置提醒模板和本机加密自定义模板；只包含主题/正文/时区/重复规则，不保存旧日期、收件人、请求 ID 或修订。应用后明确确认计划时间和提交。完整边界及当前验收见 [提醒草稿、模板与搜索](REMINDER_DRAFTS_AND_TEMPLATES.md)。

## 调度边界

Celery 每分钟认领到期 Reminder，先写入持久 `ReminderDelivery` 和 `EmailLog`，再投递邮件。连接拒绝可按退避重试；超时或断连标记为 `unknown`，不会自动重发。账号禁用、Todo 完成/取消或 Reminder 暂停/取消会阻止未发送投递。

本契约描述应用代码和本地测试行为，不代表生产配置已启用，也不包含真实数据库、邮件供应商或部署环境验证。

2026-09-29 本机证据：后端个人记录/调度测试 32 项通过，前端编辑/时区测试 17 项通过。`frontend/scripts/verify-reminder-edit.mjs` 启动仅绑定回环的 `backend/tests/reminder_qa_server.py`（真实 FastAPI personal 路由、替换账号认证、SQLite 内存库、无调度器/发信），在生产 Web 页面验证洛杉矶设备时区下的上海提醒创建/改期、规则编辑、HTTP 409 草稿保护、人工结束未知结果、过期提醒改期恢复及 390px 布局；结果/截图位于忽略目录 `.tools/reminder-edit-qa/`。这不等于生产账号登录、PostgreSQL 并发锁、真实 Celery 或供应商投递验证。

同日后续分页批次：后端个人记录测试增至 42 项，提醒界面 16 项（另 4 项时区测试在全量中继续通过）；全量前端 77 文件/758 项、后端 543 项/15 项环境跳过。真实 HTTP 脚本扩展到 63 条提醒/4 页和 55 条投递/3 页，验证插入上界、往返翻页、每页数量上限及刷新看到新记录，零真实邮件。仅 Web 产物已构建，原生安装包和生产环境未更新。
