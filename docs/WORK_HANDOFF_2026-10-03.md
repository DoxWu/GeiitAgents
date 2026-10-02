# GeiIt Agents 接手文档

更新时间：2026-10-03（Asia/Shanghai）

用途：供新的 Codex 对话直接接续开发、验收和发布前审查。本文是压缩后的当前状态入口；完整时间线仍以 WORK_LOG.md 为准。

## 当前结论

用户最初要求的核心范围已经完成：办公工具、笔记/待办、文件整理、模型配置与体验，以及历史前端全量失败处理均已有代码、测试和浏览器验收证据。当前剩余事项主要是低配与故障环境验收、真实供应商联调、格式能力扩展和发布工程，不应重新实现已经完成的核心模块。

当前工作树干净，开发分支已推送到远程：

    本地分支：develop/geiit-agents
    远程：agents/develop/geiit-agents
    接手前基线提交：2dd4ac2 docs: record remote development push
    旧 main：未修改
    远程地址：https://github.com/DoxWu/GeiitAgents.git

当前开发安装包是未签名的 dev.66：

    路径：kb_qa_system/frontend/src-tauri/target-dev/release/bundle/nsis/GeiIt Agents Dev_0.1.0-dev.66_x64-setup.exe
    大小：9,179,349 字节
    SHA-256：F65770A91ED85AC07EFA4364CEDC3092B5E6696E70F4E7F0D9EDD6526A161AB1

安装包只代表当前源码已完成 Windows NSIS 构建，不代表已签名、安装升级、部署或生产验收。

本接手文档已在本地提交 `cfb89be`，随后工作记录同步提交为 `e81acbe`。截至 2026-10-03，GitHub 连接两次返回无法连接 443，因此远程分支仍停在 `2dd4ac2`；网络恢复后执行普通 `git push agents develop/geiit-agents` 即可，不要强推。

## 已完成范围和证据

| 模块 | 当前能力 | 主要证据 |
| --- | --- | --- |
| 办公工具 | CSV/XLSX 检查、柱状/水平条形/折线/饼图/散点图生成、SVG/PNG/XLSX/Markdown 下载、DOCX 生成和版本编辑/比较/恢复；支持 MD/TXT/PDF/DOCX/PPTX 参考文本导入；图表视觉审阅只发送临时 PNG | OFFICE_TOOL_TASKS.md、CHART_TASKS.md、verify-office-tools.mjs、verify-chart-series.mjs、verify-chart-vision.mjs、verify-document-task.mjs |
| 笔记/待办 | 本机加密正式记录、草稿、归档/恢复、固定时区和 DST 校验、Markdown/JSON 导入导出、批量草稿导入导出；服务端提醒编辑、改期、重复规则、冲突保护、投递历史、分页、归档/导出、模板和人工结束不确定投递 | LOCAL_PERSONAL_DRAFTS.md、PERSONAL_JSON_IMPORT.md、PERSONAL_RECORDS_API.md、verify-personal-items.mjs、verify-personal-import.mjs、verify-reminder-edit.mjs |
| 文件整理 | Windows 原生目录选择、同目录和跨目录移动/撤销、摘要和身份核验、失败补偿、取消/中断待核验、历史分页/搜索、单文件与批量 MD/TXT 编辑/恢复、非重叠三方合并 | FILE_ORGANIZER.md、FILE_HISTORY_NAVIGATION.md、BATCH_TEXT_EDITING.md、LOCAL_TEXT_EDITING.md、verify-file-organizer.mjs、verify-file-history.mjs、verify-file-text-batch.mjs、verify-file-text-edit.mjs |
| 模型体验 | 本机 OpenAI-compatible、个人云端转发、账号云端模型；API Key 本机加密、云端仅临时转发；max output tokens 默认不发送；文本/工具调用/视觉能力探测、多模态 PNG/JPEG/WebP、流式结束判定、取消和锁库保护 | MODEL_DISCOVERY.md、MODEL_STREAMING_CONTRACT.md、verify-model-discovery.mjs、verify-generation-stream.mjs、verify-long-conversations.mjs |
| 本地知识库 | 用户主动启用后才下载 Xenova/multilingual-e5-small；MD/TXT/PDF/DOCX/PPTX 本机解析、CPU/WASM 索引、独立配置/索引/备份、来源检索和显式云端片段授权；与云端库完全隔离 | LOCAL_KNOWLEDGE_BASE_SPEC.md、LOCAL_KNOWLEDGE_DOCUMENT_IMPORT.md、LOCAL_KNOWLEDGE_BACKUP.md、.tools/local-knowledge-qa/metrics.json |
| 工作流 | 手动 DAG、条件分支、模型节点、加密草稿、便携 JSON、历史分页、续跑/单节点重试、画布缩放/自动布局、本机定时/事件触发、待设备/待授权、修订变化自动暂停旧触发器 | VISUAL_WORKFLOWS.md、verify-workflows.mjs --web |
| 备份/恢复与可靠性 | 管理员备份/恢复接口和页面、独立持久任务队列、幂等、锁、失败/中断状态、恢复预检查、自动迁移和告警接口；工作台 .geiitwork 加密备份/整体恢复 | BACKUP_RECOVERY_API.md、WORKBENCH_BACKUP.md、../kb_qa_system/docs/SEALOS_RECOVERY_AND_BACKUP.md |
| 历史前端失败 | ChatPage、DocumentsPage、DocumentPreview 旧失败项已独立重跑，49 项通过；当前全量前端回归 126 个文件/1226 项通过 | npm test -- --reporter=dot、WORK_LOG.md 最后几条验收记录 |

当前回归数字：

- 前端：126 个测试文件、1226 项通过。
- 后端：在项目隔离依赖和仓库临时目录下 608 项通过、16 项跳过。跳过项依赖真实 PostgreSQL/外部运维资源；不是代码失败。
- Rust/Tauri：20 项通过。普通沙箱曾因 Windows 临时目录 ACL 失败，受控权限和仓库隔离临时目录下通过。
- 本地知识库实时回答：真实 E5/WASM 检索、索引、授权、导出、加密归档和刷新恢复通过；回答生成使用 mock 通过。使用 backend/.env fallback 的真实 provider 返回 PermissionError，没有输出密钥、URL 或供应商响应，不能宣称真实 provider 已通过。

## 剩余任务：按优先级接续

### P0：新对话建议先做

1. 重新确认真实模型 provider 权限

当前唯一明确的真实环境阻塞是 provider 返回 PermissionError。如果用户提供了已确认可用的模型权限或修正配置，使用新浏览器 profile 重跑：

    cd kb_qa_system/frontend
    $env:LOCAL_ANSWER_PROVIDER = 'configured-fallback'
    $env:LOCAL_ANSWER_PROFILE = (Join-Path (Resolve-Path '../../.tools').Path ('local-answer-qa-profile-' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds()))
    node scripts/verify-local-answer-live.mjs

不打印或提交 backend/.env 内容。若仍为权限错误，只在工作记录写安全类别和供应商权限未满足，不把 mock 结果写成真实模型验收。

2. 补做 Windows 原生 WebView2 实际验收

优先尝试当前 dev.66 可执行文件和独立 WebView2 数据目录：

    cd kb_qa_system/frontend
    node scripts/verify-workflows.mjs --native
    node scripts/verify-native-organizer.mjs
    node scripts/verify-native-stream.mjs
    node scripts/verify-workbench-backup.mjs --native

如果出现 Native debugger unavailable，先记录为 WebView2/CDP/会话环境问题；不要用 Chromium Web 验收替代原生验收，也不要把 Rust 单元测试扩大成完整原生 UI 验收。

3. 确认当前安装包是否只需开发包

当前包未签名、未安装升级。若下一阶段目标是发布而不是继续功能开发，再单独安排代码签名、安装/卸载/升级和版本迁移验收；不要把 dev.66 当作正式发布包。

### P1：性能和数据安全

1. 在 8 GB、无独显设备上测本地 E5 的冷启动、模型缓存、峰值内存、每百段索引耗时、查询 P50/P95、UI 响应和 1000–2000 片段容量。
2. 评估本地知识库运行时原文/索引当前未加密的问题。现在是独立 IndexedDB/Cache Storage，便携备份已加密，但运行时数据仍按规格明确说明为未加密；若要改变，需设计迁移、性能和密钥库锁定语义。
3. 验证跨物理卷移动、强杀、断电和网络盘错误。当前文件整理有失败补偿和中断核验，但没有真实断电证据。
4. 验证大规模 .geiitwork 导出、恢复、低内存和分块/流式方案。当前明文负载约 16 MiB、加密文件约 24 MiB，未实现定时异地工作台备份、增量或选择性合并。

### P2：功能扩展

1. PDF 扫描件 OCR、复杂多栏/字体/表单视觉预览；Office/PPTX/PDF 的版式转换和图像内容处理。现有 PDF/DOCX/PPTX 导入是有界文本抽取，不是原文件保真转换。
2. 更多 Word/LibreOffice 组合和工作流导出入口的真实分页验收。Word 已有英文/中文合成样本 33 页证据，不能扩展到所有字体、模板或 LibreOffice。
3. 真实视觉模型、Ollama/LM Studio 多模态兼容性和专有模型协议。当前能力登记依赖显式探测，不根据模型名称推断。
4. 工作流循环和任意插件工具。现有工作流有固定工具白名单、条件分支和续跑，循环与插件权限模型尚未实现。
5. 关闭客户端后仍执行的服务器端工作流/提醒调度。当前工作流触发器只在客户端开启且密钥库解锁时运行；关闭或锁库后变为待设备/待授权，这是当前安全设计，不是隐藏的后台调度。
6. 真实邮件供应商、Celery、PostgreSQL 并发和 Sealos/PVC/异地备份联调。用户此前要求先不以部署资源阻塞应用改造，因此这些项目保持后置。

### P3：维护工作

- 逐文件处理历史 Rust cargo fmt --check 差异；不应为此批量格式化无关文件。
- 代码签名、安装器升级/卸载、多平台迁移和正式发布流程。
- 清理或在文档开头标注更早日期的“尚未实现”描述。历史日志不能改写，但当前入口文档必须避免误导。

## 尚未决定、需要新对话确认的事项

- 下一阶段是优先做性能/故障验收，还是先做 OCR/复杂格式扩展。
- 本地知识库运行时加密是否必须进入下一阶段；这会影响存储格式、性能和锁库逻辑。
- 工作流是否需要客户端关闭后继续运行；若需要，应设计服务端任务、授权和密钥生命周期，不能直接复用当前本机触发器。
- 真实 provider 应使用哪一家、是否有可用模型权限；不要在没有明确权限时反复调用或记录响应。
- 是否进入正式发布工程（签名、升级、安装测试），还是继续保持开发分支迭代。

## 新对话启动步骤

    cd 'C:\Users\DOXIA\Desktop\企业知识库问答系统'
    git switch develop/geiit-agents
    git pull --ff-only agents develop/geiit-agents
    Get-Content -Encoding UTF8 docs/WORK_HANDOFF_2026-10-03.md
    Get-Content -Encoding UTF8 docs/WORK_LOG.md -Tail 80
    git status --short --branch

前端检查和 Cargo 检查：

    cd kb_qa_system/frontend
    npm run check
    npm run lint
    npm run desktop:toolchain:test
    npm run desktop:check

后端回归需要项目隔离依赖和可写临时目录：

    cd kb_qa_system/backend
    $repo = (Resolve-Path '.').Path
    $ops = (Resolve-Path '../../.tools/python-ops').Path
    $provider = (Resolve-Path '../../.tools/python-tools-provider').Path
    $tmp = (Resolve-Path '../../.tools/pytest-backend-next').Path
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $env:PYTHONPATH = "$repo;$ops;$provider"
    $env:DEBUG = 'False'
    python -m pytest -q --basetemp=$tmp

Windows 原生 Rust 测试建议使用项目工具链和仓库临时目录，并按权限情况运行：

    cd kb_qa_system/frontend
    . ./scripts/Use-ProjectRustToolchain.ps1
    $tmp = (Resolve-Path '../../.tools/rust-native-next').Path
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $env:TEMP = $tmp
    $env:TMP = $tmp
    & $env:CARGO test --manifest-path src-tauri/Cargo.toml -- --test-threads=1

## 验收和记录规则

1. 每完成一批工作，都追加 WORK_LOG.md；不要把旧日期的测试写成本次重跑。
2. 明确区分代码实现、单元测试、Chromium 合成 provider、真实 provider、原生 WebView2、构建产物和线上部署。
3. 不记录密码、API Key、连接串或真实供应商响应；真实 provider 失败只记录安全类别。
4. 本地知识库默认 E5 只在用户主动启用后下载；它与云端知识库的模型、文档、索引保持分离。
5. max_tokens 默认不配置；本机密钥库口令最低 4 位，不等于厂商 API Key 长度。
6. 不修改旧 main，不强制推送；新功能继续在 develop/geiit-agents 上提交。
7. 远程分支已经存在，推送前先 git fetch agents --prune、检查差异和凭据，再使用普通 push。

## 可直接复制给新对话的开场

请先阅读 docs/WORK_HANDOFF_2026-10-03.md、docs/WORK_LOG.md 和根目录 AGENTS.md。当前核心办公助手目标已经完成，分支是 develop/geiit-agents，远程为 agents/develop/geiit-agents，不要重做已完成模块。请从接手文档的 P0/P1 剩余任务开始，先确认当前工作树和远程状态；所有新工作完成后更新 docs/WORK_LOG.md，不要记录凭据，也不要把合成 provider 验收写成真实供应商验收。

