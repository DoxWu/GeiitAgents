# A28 供应商与隐私验收

## 已确认配置

- 阿里云 OpenAI 兼容端点提供主 LLM 和 Embedding。
- DeepSeek OpenAI 兼容端点只作为 LLM 备用；不用于 Embedding。
- 邮件使用 Resend HTTP API。
- 公开反馈邮箱由每个前端部署实例配置；未配置或地址无效时，帮助页和隐私页隐藏邮箱链接。
- 运营主体、所在地、处理区域、保留期和跨境情况由部署运营方核实后填写。云端部署及“多数情况下非跨境”不构成已核实的具体数据流或法律承诺。

## 部署变量

在后端密钥管理器/容器环境设置 `ALIYUN_API_KEY`、`ALIYUN_API_BASE`、`ALIYUN_LLM_MODEL`、`ALIYUN_EMBEDDING_MODEL`、`EMBEDDING_DIMENSION`、`DEEPSEEK_API_KEY`、`DEEPSEEK_API_BASE`、`DEEPSEEK_LLM_MODEL` 和 `DEEPSEEK_LLM_ENABLED=true`。模型 ID、阿里云地域/工作空间端点及向量维度必须来自部署者实际账号；本仓库不替部署者猜测。更改向量维度或模型前应先确认现有 pgvector schema 和旧向量重处理计划。

Resend 真实发送需要 `EMAIL_ENABLED=true`、`EMAIL_PROVIDER=http`、`RESEND_API_KEY` 和已验证域名对应的 `EMAIL_FROM`。真实命令需一个明确指定的收件地址，会发送一封只含合成文本的测试邮件。若要验收注册/审批通知流程，还要在后端配置 `ADMIN_NOTIFY_EMAIL`；它是业务邮件收件箱，与可选公开的 `PUBLIC_CONTACT_EMAIL` 和命令参数 `--email-to` 相互独立。验收脚本直连供应商，不会验证 Celery 队列或整条业务邮件流程。

在前端容器设置 `PUBLIC_CONTACT_EMAIL`、`PUBLIC_OPERATOR_NAME`、`PUBLIC_OPERATOR_LOCATION`、`PUBLIC_DATA_PROCESSING_REGION`、`PUBLIC_DATA_RETENTION_NOTICE`、`PUBLIC_CROSS_BORDER_NOTICE` 和 `PUBLIC_THIRD_PARTY_PROCESSING_NOTICE`。这些字段会写入浏览器可读取的 `runtime-config.js`，只允许放公开信息，不得包含密钥、连接串或内部网络地址。未填写的隐私信息会显示为“请向部署运营方核实”。

## 运行验收

先在 API 容器终端运行不发请求的配置检查：

```bash
python -m app.ops.provider_acceptance --preflight
```

完成供应商账户授权、密钥和测试库准备后，运行真实检查：

```bash
python -m app.ops.provider_acceptance --live --email-to admin@example.com
```

脚本只读取容器进程环境，不加载 `.env`。真实模式先以只读事务检查 `document_chunks.content_vector` 类型维度；随后分别直连阿里云 LLM、阿里云工具调用、DeepSeek LLM、DeepSeek 工具调用和阿里云 Embedding；最后对 Resend 发送一次请求。模型调用会产生供应商用量。Resend 不做自动重试：超时、5xx 或缺少邮件 ID 会报告 `UNKNOWN`，须先到 Resend Events 核对，再决定是否人工重发。

脚本不会输出 Key、邮件地址、模型响应或供应商错误正文。401/403、429、超时、其他 HTTP 状态和连接错误会以有限状态标签显示。视觉模型在当前配置中默认关闭并标为“未配置/未测试”；要启用视觉需选定模型、单独配置并补做真实验收。流式截断、故障重试分类和 unknown 邮件状态由隔离测试覆盖，不由这组短探测宣称线上故障验收通过。

## 验收边界

代码配置、合成回归、本地构建和供应商直连探测是四类不同证据。本地完成本文件和脚本不代表真实供应商/邮件已连接，也不代表应用 RAG 全链路、真实用户逐次授权、合同、数据处理区域、跨境情况、保留/销毁流程或法规合规已验收。部署者应把实际邮件投递、供应商账号/合同、数据处理清单及隐私告知逐项对照记录。
