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

### 修改与取消

- `PATCH /reminders/{id}`：必须带 `revision`，可更新主题、正文、时区、重复规则、下一次时间、关联 Todo 或状态 `active|paused|cancelled`
- `DELETE /reminders/{id}`：等价于取消并使 `next_run_at=null`

服务端存在 `sending` 或 `unknown` 投递时，只允许先暂停或取消；其他修改返回 `409 delivery_in_flight_or_unknown`。修订号不匹配返回 `409 revision_conflict`。

### 投递记录与重试

- `GET /reminders/{reminder_id}/deliveries?limit=50&offset=0`
- `POST /reminders/{reminder_id}/deliveries/{delivery_id}/retry`

请求体：

```json
{ "acknowledge_duplicate_risk": true }
```

只有 `failed` 或 `unknown` 投递可重试。`unknown` 表示连接中断时无法确认服务商是否已接受邮件，必须显式传 `true`，否则返回 `409 duplicate_risk_acknowledgement_required`。客户端也必须在调用前向用户展示重复发送风险。邮件服务商接受不代表收件箱已经送达。

## 调度边界

Celery 每分钟认领到期 Reminder，先写入持久 `ReminderDelivery` 和 `EmailLog`，再投递邮件。连接拒绝可按退避重试；超时或断连标记为 `unknown`，不会自动重发。账号禁用、Todo 完成/取消或 Reminder 暂停/取消会阻止未发送投递。

本契约描述应用代码和本地测试行为，不代表生产配置已启用，也不包含真实数据库、邮件供应商或部署环境验证。
