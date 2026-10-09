# GeiIt Agents 接手文档

2026-10-09 接续状态优先于下列 10-03 历史记录：本轮已修复登录页无法退出，加入可选且明确可见的账号服务器（桌面默认 `https://api.geiit.online/api/v1`），新增无需账号的自购 API 直连，并补齐模型列表进度/取消/失败及 20 秒超时。前端本次 128 文件 / 1244 项、Rust 21 项、check/lint 和 Chromium 隔离模拟验证通过，dev.67 NSIS 安装包已构建。本批保存在开发分支本地提交，GitHub 443 不可达，未完成本批同步；缓存远程最后成功记录为 `cb65340`，并非实时查询结论。完整状态、安装包摘要、验证边界和下一步以 [WORK_LOG.md](WORK_LOG.md) 首部及 [ACCOUNT_AND_MODEL_ACCESS.md](ACCOUNT_AND_MODEL_ACCESS.md) 为准。用户授权较大模块完成后普通推送，禁止强推；本次未改线上部署。

更新时间：2026-10-03（Asia/Shanghai）

用途：供新的 Codex 对话直接接续开发、验收和发布前审查。本文是压缩后的当前状态入口；完整时间线仍以 WORK_LOG.md 为准。

## 当前结论

用户最初要求的核心范围已经完成：办公工具、笔记/待办、文件整理、模型配置与体验，以及历史前端全量失败处理均已有代码、测试和浏览器验收证据。当前处于“核心功能完成、发布前审查”阶段；性能、运行时数据保护、故障恢复、真实供应商/邮件联调和发布验证仍是未完成的工程目标，不能因为核心里程碑完成就自动视为可选。

部署选型与上线准备以 [DEPLOYMENT_SELECTION_RECOMMENDATION_2026-10-03.md](DEPLOYMENT_SELECTION_RECOMMENDATION_2026-10-03.md) 为准：当前首发推荐 Sealos/Kubernetes 上单副本前端 + `api+worker`、pgvector PostgreSQL、Redis、PVC 和集群外 ops；Railway 保留为海外/预发布方案，并明确 API/Worker 分离时的共享文件限制。

当前工作树干净。部署选型、CI 容器门禁和 Sealos 应用模板已推送到远程；后续新提交仍需按模块完成后检查并普通推送：

    本地分支：develop/geiit-agents
    远程：agents/develop/geiit-agents
    远程已同步：cb65340 deploy: add sealos application manifests
    本地与远程：当前一致
    旧 main：未修改
    远程地址：https://github.com/DoxWu/GeiitAgents.git

当前开发安装包是未签名的 dev.66：

    路径：kb_qa_system/frontend/src-tauri/target-dev/release/bundle/nsis/GeiIt Agents Dev_0.1.0-dev.66_x64-setup.exe
    大小：9,179,349 字节
    SHA-256：F65770A91ED85AC07EFA4364CEDC3092B5E6696E70F4E7F0D9EDD6526A161AB1

安装包只代表当前源码已完成 Windows NSIS 构建，不代表已签名、安装升级、部署或生产验收。

本接手文档及后续部署记录已在本地提交并随模块推送；当前远程 `agents/develop/geiit-agents` 已同步到 `cb65340`。后续仍需先检查差异，再执行普通 `git push agents develop/geiit-agents`，不要强推。

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
- 本地知识库实时回答：真实 E5/WASM 检索、索引、授权、导出、加密归档和刷新恢复通过；回答生成使用 mock 通过。使用 backend/.env fallback 的 live helper 返回 `PermissionError`，但 helper 会捕获导入、文件读取和 provider 异常，且浏览器进程使用 `.tools/python-ops` 的隔离依赖；因此目前只能确认“live helper 失败”，依赖/文件 ACL 与 provider 权限的具体来源尚未判定。没有输出密钥、URL 或供应商响应，不能宣称真实 provider 已通过。
- 证据日期：上述前端、后端、Rust 和 E5 结果是 2026-10-02 的历史验证；2026-10-03 只复核了安装包摘要和文档/Git 状态，没有重跑这些测试。

## 剩余任务：按优先级接续

### P0：新对话建议先做

1. 诊断并重新确认真实模型 provider 的 live helper 环境

当前可复现现象是 live helper 返回 `PermissionError`，但根因未确认。先在本地诊断 Python helper 的导入、依赖目录 ACL、配置读取和 provider 调用边界，再决定是否需要用户修正模型权限。不要直接把异常归因于供应商。

脚本固定打开 `http://127.0.0.1:1423/workbench`，运行前需在另一个终端从 `kb_qa_system/frontend` 启动对应页面，例如：

    npm run dev -- --host 127.0.0.1 --port 1423

页面可访问后，使用新 profile 重跑：

    cd kb_qa_system/frontend
    $env:LOCAL_ANSWER_PROVIDER = 'configured-fallback'
    $env:LOCAL_ANSWER_PROFILE = Join-Path (Resolve-Path '../../.tools').Path ('local-answer-qa-profile-' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds())
    node scripts/verify-local-answer-live.mjs

新 profile 没有 E5 权重缓存时需要可用网络或预置缓存；历史上空 profile 曾因初始化失败，而已有缓存 profile 通过。不得使用个人 profile，因为脚本会删除本地知识库和工作台密钥库两个 IndexedDB 数据库。不打印或提交 backend/.env 内容；若仍失败，只记录安全类别、依赖/ACL 或 provider 的已证实边界，不把 mock 结果写成真实模型验收。

2. 补做 Windows 原生 WebView2 实际验收

优先尝试当前 dev.66 可执行文件和独立 WebView2 数据目录：

    cd kb_qa_system/frontend
    node scripts/verify-workflows.mjs --native
    node scripts/verify-native-organizer.mjs
    node scripts/verify-native-stream.mjs
    node scripts/verify-workbench-backup.mjs --native

如果出现 Native debugger unavailable，先记录为 WebView2/CDP/会话环境问题；不要用 Chromium Web 验收替代原生验收，也不要把 Rust 单元测试扩大成完整原生 UI 验收。`verify-native-organizer.mjs` 会等待真实 Windows 目录选择器，需人工选择脚本打印的测试目录，并非完全无人值守。

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
5. 关闭客户端后仍执行的服务器端工作流。当前工作流触发器只在客户端开启且密钥库解锁时运行；关闭或锁库后变为待设备/待授权，这是当前安全设计，不是隐藏的后台调度。服务端提醒的持久调度代码已经存在，不要把“提醒后台实现”写成待开发项。
6. 真实邮件供应商、Celery、PostgreSQL 并发和 Sealos/PVC/异地备份联调。现有服务端提醒调度需要做真实基础设施验证；用户此前要求先不以部署资源阻塞应用改造，因此这些项目保持后置。

### P3：维护工作

- 逐文件处理历史 Rust cargo fmt --check 差异；不应为此批量格式化无关文件。
- 代码签名、安装器升级/卸载、多平台迁移和正式发布流程。
- 清理或在文档开头标注更早日期的“尚未实现”描述。历史日志不能改写，但当前入口文档必须避免误导。
- `docs/LOCAL_KNOWLEDGE_ANSWERS.md` 的早期历史段落仍写有真实供应商成功描述；在下一次文档整理时应明确以最新 WORK_LOG 和本接手文档为准，并修正过期表述。

## 尚未决定、需要新对话确认的事项

- 下一阶段是优先做性能/故障验收，还是先做 OCR/复杂格式扩展。
- 本地知识库运行时加密是否必须进入下一阶段；这会影响存储格式、性能和锁库逻辑。
- 工作流是否需要客户端关闭后继续运行；若需要，应设计服务端任务、授权和密钥生命周期，不能直接复用当前本机触发器。
- 真实 provider 应使用哪一家、是否有可用模型权限；不要在没有明确权限时反复调用或记录响应。
- 是否进入正式发布工程（签名、升级、安装测试），还是继续保持开发分支迭代。

## 关键代码位置和验收标准

- 本地知识库与回答：`kb_qa_system/frontend/src/localKnowledge/`、`kb_qa_system/frontend/src/services/vaultBackup.ts`、`kb_qa_system/frontend/scripts/verify-local-answer-live.mjs`。
- 模型与 provider：`kb_qa_system/frontend/src/services/modelDiscovery.ts`、`kb_qa_system/frontend/src/services/modelStream.ts`、`kb_qa_system/backend/app/core/model_provider/`、`kb_qa_system/backend/app/services/private_model.py`。
- 工作流调度：`kb_qa_system/frontend/src/workflows/`、`kb_qa_system/frontend/src/store/workbenchStore.ts`（以及对应 workflow store 测试）。
- 备份、恢复、迁移和告警：`kb_qa_system/backend/app/ops/backup.py`、`kb_qa_system/backend/app/ops/recovery.py`、`kb_qa_system/backend/app/ops/alerts.py`、`kb_qa_system/backend/app/tasks/reminder_tasks.py`、`kb_qa_system/backend/alembic/`。
- 原生文件能力：`kb_qa_system/frontend/src-tauri/src/organizer.rs` 及 `kb_qa_system/frontend/src-tauri/permissions/`。

完成下一批工作至少应能回答：代码路径是否已接入、对应测试是否本次重跑、是否走 Chromium 合成 provider/真实 provider/原生 WebView2、是否生成构建产物、是否仍未做线上部署。性能任务需给出设备内存、语料规模、冷/热缓存、P50/P95、峰值内存和失败恢复结果；备份任务需给出校验、恢复预检查、幂等与告警结果；真实 provider 失败只保留安全类别和可复现边界。

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
    $toolsRoot = (Resolve-Path '../../.tools').Path
    $tmp = Join-Path $toolsRoot 'pytest-backend-next'
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $env:PYTHONPATH = "$repo;$ops;$provider"
    $env:DEBUG = 'False'
    python -m pytest -q --basetemp=$tmp

Windows 原生 Rust 测试建议使用项目工具链和仓库临时目录，并按权限情况运行：

    cd kb_qa_system/frontend
    . ./scripts/Use-ProjectRustToolchain.ps1
    $toolsRoot = (Resolve-Path '../../.tools').Path
    $tmp = Join-Path $toolsRoot 'rust-native-next'
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
