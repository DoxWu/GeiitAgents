# A28 供应商与隐私验收

## 已确认配置

- 阿里云 OpenAI 兼容端点提供主 LLM 和 Embedding。
- DeepSeek OpenAI 兼容端点只作为 LLM 备用；不用于 Embedding。
- 邮件支持 Resend HTTP API 或 SMTP，由部署实例选择；本轮实际验收的是单封合成 SMTP 通知及用户确认收件。
- 公开反馈邮箱由每个前端部署实例配置；未配置或地址无效时，帮助页和隐私页隐藏邮箱链接。
- 运营主体、所在地、处理区域、保留期和跨境情况由部署运营方核实后填写。云端部署及“多数情况下非跨境”不构成已核实的具体数据流或法律承诺。

## 部署变量

在后端密钥管理器/容器环境设置 `ALIYUN_API_KEY`、`ALIYUN_API_BASE`、`ALIYUN_LLM_MODEL`、`ALIYUN_EMBEDDING_MODEL`、`EMBEDDING_DIMENSION`、`DEEPSEEK_API_KEY`、`DEEPSEEK_API_BASE`、`DEEPSEEK_LLM_MODEL` 和 `DEEPSEEK_LLM_ENABLED=true`。模型 ID、阿里云地域/工作空间端点及向量维度必须来自部署者实际账号；本仓库不替部署者猜测。更改向量维度或模型前应先确认现有 pgvector schema 和旧向量重处理计划。

Resend 真实发送需要 `EMAIL_ENABLED=true`、`EMAIL_PROVIDER=http`、`RESEND_API_KEY` 和已验证域名对应的 `EMAIL_FROM`。验收命令可添加 `--email-provider smtp` 使用 SMTP 配置；收件人可由 `--email-to` 明确指定或回退到 `ADMIN_NOTIFY_EMAIL`。该命令会发送一封只含合成文本的测试邮件。若要验收注册/审批通知流程，还要在后端配置 `ADMIN_NOTIFY_EMAIL`；它是业务邮件收件箱，与可选公开的 `PUBLIC_CONTACT_EMAIL` 相互独立。验收脚本直连邮件服务商，不会验证 Celery 队列或整条业务邮件流程。

在前端容器设置 `PUBLIC_CONTACT_EMAIL`、`PUBLIC_OPERATOR_NAME`、`PUBLIC_OPERATOR_LOCATION`、`PUBLIC_DATA_PROCESSING_REGION`、`PUBLIC_DATA_RETENTION_NOTICE`、`PUBLIC_CROSS_BORDER_NOTICE` 和 `PUBLIC_THIRD_PARTY_PROCESSING_NOTICE`。这些字段会写入浏览器可读取的 `runtime-config.js`，只允许放公开信息，不得包含密钥、连接串或内部网络地址。未填写的隐私信息会显示为“请向部署运营方核实”。

## 运行验收

先在 API 容器终端运行不发请求的配置检查：

```bash
python -m app.ops.provider_acceptance --preflight
```

完成供应商账户授权、密钥和测试库准备后，运行真实检查：

```bash
python -m app.ops.provider_acceptance --live --email-provider http --email-to admin@example.com
```

SMTP 模式命令：

```bash
python -m app.ops.provider_acceptance --live --email-provider smtp
```

SMTP 模式在省略 `--email-to` 时使用运行环境中的 `ADMIN_NOTIFY_EMAIL`。完成一次收件验收后不要重复发送。直接 SMTP 收件成功不代表 `.env` 已将 `EMAIL_PROVIDER` 切换为 SMTP，也不代表生产通知 worker 已使用或通过该通道。

脚本只读取容器进程环境，不加载 `.env`。真实模式先以只读事务检查 `document_chunks.content_vector` 类型维度；随后分别直连阿里云 LLM、阿里云工具调用、DeepSeek LLM、DeepSeek 工具调用和阿里云 Embedding；最后对所选邮件通道发送一次请求。模型调用会产生供应商用量。Resend 不做自动重试：超时、5xx 或缺少邮件 ID 会报告 `UNKNOWN`，须先到 Resend Events 核对，再决定是否人工重发。

脚本不会输出 Key、邮件地址、模型响应或供应商错误正文。401/403、429、超时、其他 HTTP 状态和连接错误会以有限状态标签显示。视觉模型在当前配置中默认关闭并标为“未配置/未测试”；要启用视觉需选定模型、单独配置并补做真实验收。流式截断、故障重试分类和 unknown 邮件状态由隔离测试覆盖，不由这组短探测宣称线上故障验收通过。

## 验收边界

代码配置、合成回归、本地构建和供应商直连探测是不同证据。2026-10-20 使用项目 `.env` 的主/备 LLM 聊天和工具调用、主 Embedding（1024 维）直连通过；一封合成 SMTP 邮件已由收件人确认收到，没有重复发送。

本轮另用 Docker PostgreSQL 16.14 + pgvector，从空库迁移到 head 并核对 `vector(1024)`；真实 Embedding → pgvector → 权限过滤 → 真实 Qwen 重排 → 非流式/流式 RAG 的三份合成资料服务层联调通过。后端固定依赖全量 747 项通过（含真实 PostgreSQL 恢复/维护和 Redis 生命周期），覆盖率 49.34%。所有数据库操作只针对随机隔离库，未连接或修改用户目标库。

上述结果不代表旧目标库跨维度迁移、HTTP 上传/登录/Celery 的完整业务链、Resend HTTP、真实用户逐次授权、供应商合同、数据处理区域、跨境情况、保留/销毁流程或法规合规已验收。高级检索开关及范围见 [重排说明](RERANKING.md)。部署者应把实际邮件投递、供应商账号/合同、数据处理清单及隐私告知逐项对照记录。
