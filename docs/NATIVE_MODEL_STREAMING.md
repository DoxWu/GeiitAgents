# Tauri 本机聊天流式输出

2026-09-29：已实现；Windows 开发版 `0.1.0-dev.8` 已完成真实 WebView2 → Rust → 回环 HTTP fixture 验证。不是供应商联调或正式发布。

同日后续更新：dev.12 批次已对齐四条工作台聊天路径的结束判据，并新增停止原因的界面、加密保存和导出；当前契约见 [工作台流式结束与停止原因](MODEL_STREAMING_CONTRACT.md)。以下未说明更新的验证数量/产物是 dev.8 历史证据。

## 路径与兼容性

- 工作台聊天向 `completeModel` 提供增量回调，桌面路径调用新增 `stream_local_model`。每次请求创建独立 Tauri `Channel<{content: string}>`，不广播到全局事件或其他窗口。
- 原 `complete_local_model` 仍保留。连接短消息测试、文档任务和当前本地知识库回答等未提供增量回调的调用方，继续等待完整返回；本批没有给这些界面添加流式显示。
- 两个命令共用 URL/密钥/消息校验、原生请求上限和 `cancel_local_model(requestId)`。仅 localhost / 127.0.0.1 / [::1]，localhost 固定为 127.0.0.1，不使用系统代理、不跟随重定向。
- 只有流式命令发送 `stream: true`。最大输出 Token 未配置时，不发送 `max_tokens`；不自动选模型、改用账号云端或下载任何模型。
- 服务忽略 `stream: true` 并返回兼容 JSON 时，一次性发出有效文本并正常结束，不伪装成多段响应。

## 增量协议

Rust `src-tauri/src/local_stream.rs` 按字节识别 SSE 行和事件，完整行才解码 UTF-8。支持分块中文/emoji、开头 BOM、LF/CRLF/CR、多行 data、注释、role-only 及 usage 空 choices 事件。

只接收第 0 个 choice（或未标 index 的单个 choice）的 `delta.content` 文本，不拼接其他候选结果、不执行工具调用。`[DONE]` 或非空 `finish_reason` 表示供应商完成生成；没有完成标记的 EOF、HTTP/解析错误、错误事件或空回答都失败。错误不带供应商 body、密钥或原始异常详情。

限制为响应最多 2 MiB、累计内容最多 1,000,000 UTF-16 单元。原生 HTTP 总超时 115 秒；工作台聊天控制器 120 秒，连接测试控制器 25 秒。客户端最多同时运行 3 个模型请求，原生桥接保留 4 个并发上限。

dev.12 已把 `finish_reason` 归一化为 stop/length/content_filter/tool_calls/unknown，随聊天记录保存、展示和导出。供应商结束不保证文本在语义上完整；只有 DONE 的情况显示原因未知。工具调用和多模态仍不能由这个文本通道推断。

## 取消与存储

前端取消会通知对应原生请求，同时立即拒收新片段；命令结束后将 channel 回调置空，Rust 丢弃 channel 时由 Tauri 清理回调注册。完整返回是最终文本依据，迟到 IPC 片段不会在最终答案后重复追加。

共享聊天 store 的每个增量回调检查请求控制器、代次、锁定状态和取消状态。锁库后重新解锁并在同一对话发送新请求，旧请求也不能写回或结束新请求的运行状态。账号退出/变化会取消账号云端和个人云端转发请求，本机连接继续按本机密钥库管理。

流式内容仅驻留临时显示区。只有正常完成的全文才作为 assistant 消息加密保存；失败/取消保留先前已保存的用户消息，清理临时片段。刷新不会将未完成片段恢复成成功回答。

## 验证与产物

- 前端全量 80 文件、796 项通过；含独立 channel、非流式兼容、并行请求、取消后迟到事件、无效结果、回调故障、锁库/重新解锁后的旧片段、个人云端退出取消和 120 秒超时模拟。
- Rust 8 项通过，含所有 UTF-8 分割边界、BOM/CR/多行事件、终止条件、异常脱敏、大小上限、错误 channel 及上一批模型列表 HTTP 验证。
- `scripts/verify-native-stream.mjs` 使用独立 WebView 数据目录和动态调试端口启动打包 dev exe。真实验证 7 次流式请求、1 次非流式连接测试、1 次原生目录读取；覆盖结束前可见中文/emoji、两条并行会话、停止/锁库后 HTTP 连接关闭、无标记中断失败、JSON 兼容、上游错误脱敏、加密刷新恢复。模型请求由 Rust 发出，fixture 不提供 CORS，浏览器侧没有直接访问模型服务。没有在真实设备上等待 115 秒验证传输超时，超时证据是原生配置与客户端控制器测试。
- 截图和结果在忽略目录 `.tools/native-stream-qa/`，使用合成资料和 fixture Key。Web 与 desktop Web 构建、定向 ESLint、差异检查通过；本批没有改后端或重跑其全量测试，上一批 560/15 仅为历史结果。
- 已生成 `src-tauri/target-dev/release/geiit-workbench.exe` 与 `src-tauri/target-dev/release/bundle/nsis/GeiIt Agents Dev_0.1.0-dev.8_x64-setup.exe`。未签名；运行验证使用 exe，没有执行 NSIS 安装/卸载、自动更新或迁移旧用户数据。未推送或部署。

## 后续边界

普通聊天的多模态/专有协议、长对话分页仍待实现；固定办公工具协议已由后续独立任务实现。dev.12 已用共享协议样例与四条真实 HTTP 路径验收完成标记、取消/截断、BOM/多行和停止原因。原生外部目录已在 dev.10 完成首轮，文档分页和低配/长任务压测仍需单独验收。
