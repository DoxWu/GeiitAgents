# 当前功能矩阵

更新日期：2026-10-18。本矩阵按当前路由、界面组件、服务实现和测试入口整理。代码存在或本地测试通过，不等于目标部署已启用，也不等于真实供应商、数据恢复或业务质量验收通过。

| 功能域 | 用户入口与实现 | 当前验证证据 | 限制与未验收项 |
| --- | --- | --- | --- |
| 云端文档管理 | Web `/documents`；前端 `kb_qa_system/frontend/src/pages/DocumentsPage.tsx`、`components/documents/`；后端 `kb_qa_system/backend/app/api/routes/documents.py` | 文档页、列表、预览、筛选组件测试；后端 `test_upload_conflict.py`、`test_review_lifecycle.py`、`test_review_downloads.py` | 需要已迁移且可连接的目标数据库/文件卷。过滤搜索不扫描正文；远程部署和用户数据恢复未验收。 |
| 文档解析与导入 | 云端上传/URL 导入；后端 `document_tasks.py`、`services/document_pipeline/`。桌面参考导入见 `frontend/src/officeTasks/` | `test_review_downloads.py` 与前端 DOCX/PPTX/PDF 导入测试；A32/A33 隔离资源限制回归 | OCR 取决于 Tesseract、语言包和运行配置，不保证扫描件识别；复杂版面、图表、批注和原始 Office 排版不保真。 |
| 云端问答与检索 | Web `/chat`；`frontend/src/pages/ChatPage.tsx`；后端 `chat.py`、`document_chat.py`、`services/rag_chain.py`、`services/vector_store.py` | `test_review_embedding_spaces.py`；Multi-CPR selected-30 本地 E5 检索和拒答提示词合约，详见工作记录 | 真实 LLM 对 selected-30 的逐题拒答/引用尚未运行；selected-30 不是企业业务金标。目标库迁移后须重处理来源不明的旧向量。 |
| 账号、权限与公开页面 | `/login`、`/register`、`/set-password`、`/settings`、`/admin/applications`、`/help`、`/privacy`；后端 `auth.py`、`registration.py`、依赖与权限服务 | `test_review_auth.py`、`test_account_deletion.py`、`test_superuser_privacy.py`、`PublicContact.test.tsx` | 当前没有已注册账号自助密码重置接口。Redis/WebSocket 生命周期用例曾在 CI 因源码路径错误失败；工作区已修正路径并增加模块加载回归，等待新 CI。真实发信和实例隐私声明仍待部署者验收。 |
| 管理备份与恢复 | 管理员 `/admin/backup-recovery`；`BackupRecoveryPage.tsx`、后端 `ops/` API 与独立 ops worker | `test_ops.py`、`test_maintenance.py` 曾在隔离 PostgreSQL/pgvector 通过 28/28；详情及日期见工作记录 | 数据库快照不包含上传文件/PVC、Redis、对象存储或运行配置；目标环境联合恢复、RPO/RTO 和回滚演练未完成。 |
| 本机工作台与密钥库 | `/workbench`，由 `WorkbenchPage.tsx` 提供对话、模型连接、任务、记录和本机加密库；核心实现位于 `frontend/src/store/workbenchStore.ts` | 工作台、存储、备份及模型连接测试；2026-10-17 Playwright 工作台流程 | 本机库与服务端账号数据分开。导出的 Office/HTML 文件是明文副本；Windows WebView2 真机验收仍开放。 |
| 本地知识库 | `/local-knowledge`；`frontend/src/localKnowledge/`、`pages/LocalKnowledgePage.tsx` | `LocalKnowledgePage.test.tsx`、本地 E5 浏览器基准、四浏览器 API smoke，证据见工作记录和 `LOCAL_KNOWLEDGE_BENCHMARK_2026-09-22.md` | 用户主动启用后才下载 E5。运行中的原文/向量未加密；加密备份不改变此边界。低配设备、Safari/WebView2 和目标容量仍未完整验收。 |
| AI 文档与 Office 生成 | 工作台「任务」页；`components/workbench/OfficeTasks.tsx`、`DocumentTasks.tsx`、`officeTasks/` | `OfficeToolTasks.test.tsx`、Office 导出测试及 `npm run verify:ai-workbench` | 模型先生成/编辑 Markdown，再在本机导出 DOCX/PPTX/XLS/XLSX/HTML；PPTX 按文本拆页，表格输出为文本单元格，不承诺复杂版式、公式计算或任意文件保真转换。 |
| AI 可视化网页设计 | 工作台「任务 → 网页设计」；`components/workbench/WebDesigner.tsx`、`webDesignerOutput.ts` | `WebDesigner.test.tsx` 与 `npm run verify:ai-workbench`：布局、主副色、组件色、六类滚动示例、文字/图片、沙箱预览和下载 | 浏览器流程使用模拟模型且模型请求为 0；真实生成质量需由部署者连接模型后验收。导出 HTML 需人工检查再部署。 |
| 参考资料复用 | 文档/Markdown 任务内的本机资料库；`ReferenceLibrary.tsx`、`LocalMarkdown.tsx`、`workbenchStore.ts` | `LocalMarkdown.test.tsx` 与 `workbenchStore.test.ts` 77 项通过；浏览器流程覆盖清空后载回和加密检查 | 保存的是解析后的文本，不是原文件；最多 20 份。载回本身不发送资料，执行云端任务时仍需逐次授权。 |
| 笔记、待办与提醒 | 工作台「笔记与待办」；`PersonalItems.tsx`、`ServerReminders.tsx`；后端 `personal.py` | `PersonalItems.test.tsx`、`PersonalImport.test.tsx`、`test_personal.py` | 提醒队列/调度代码不等于生产邮件已投递；Resend、真实收件箱和 Celery 部署仍待联调。 |
| 本机文件整理 | 工作台「文件整理」；`FileOrganizer.tsx`、文件历史与 Rust 文件桥 | `FileOrganizer.test.tsx`、`FileHistory.test.tsx`、文本编辑/批量编辑测试 | 仅在用户选择和授权的目录执行受限操作；跨卷、进程中断、原生 WebView2 和低配设备需目标机器验收。 |
| 可视化工作流 | 工作台任务中的工作流页；`Workflows.tsx`、`workflows/`、加密任务存储 | `Workflows.test.tsx`、workflow 定义/布局/可移植性测试 | 支持当前定义的 DAG、条件和触发能力；循环与任意插件未实现。客户端关闭后的持续执行能力按具体触发方式和运行环境限制。 |
| 监控、部署与供应商 | 后端 `/health`、`/ready`、可配置 `/metrics`；部署模板和 GitHub Actions | `test_review_observability.py`、配置/工作流静态检查；CI `39046967856` 的依赖审计、前端测试/构建、LangChain 合约和 secret scan 通过 | 后端 698 项通过、1 项 Redis 路由源码路径回归失败、1 项跳过；后端失败使容器构建/Trivy 跳过。路径已修正，待下一轮 CI。阿里云/DeepSeek/Resend 真实调用、目标迁移、容器部署及运营/数据区域/保留/跨境说明均未验收。 |
| FAQ 答案缓存 | 无用户入口或问答读写路径；旧 `FAQ_CACHE_TTL` 配置不启用功能 | 代码接线检查；管理员操作文档已明确未接入 | 未实现，不应描述为命中缓存、减少模型调用或可用功能。 |

## 证据口径

- “测试通过”只适用于工作记录中标注的日期、命令和隔离条件；历史全量测试不代表本次重跑。
- 浏览器模拟模型、SQLite/合成数据及隔离 PostgreSQL 不能替代真实 provider、生产数据库、Redis 部署、真实收件箱或桌面 WebView2 验收。
- 逐项整改状态与最新待办以 [修复跟踪](REVIEW_REMEDIATION_2026-10-10.md) 和 [工作记录](WORK_LOG.md) 为准；网页/Office 的格式边界见 [AI 办公工作台说明](AI_OFFICE_WORKBENCH.md)。
- 原 [知识库项目功能清单](../kb_qa_system/docs/知识库项目功能清单.md) 是历史详细稿，包含过时技术与数量描述，已不再作为当前功能清单。
