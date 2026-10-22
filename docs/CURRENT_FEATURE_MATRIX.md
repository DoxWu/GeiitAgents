# 当前功能矩阵

更新日期：2026-10-22。本矩阵按当前路由、界面组件、服务实现和测试入口整理。代码存在或本地测试通过，不等于目标部署已启用，也不等于真实供应商、数据恢复或业务质量验收通过。

| 功能域 | 用户入口与实现 | 当前验证证据 | 限制与未验收项 |
| --- | --- | --- | --- |
| 云端文档管理 | Web `/documents`；前端 `kb_qa_system/frontend/src/pages/DocumentsPage.tsx`、`components/documents/`；后端 `kb_qa_system/backend/app/api/routes/documents.py` | 文档页、列表、预览、筛选组件测试；后端 `test_upload_conflict.py`、`test_review_lifecycle.py`、`test_review_downloads.py` | 需要已迁移且可连接的目标数据库/文件卷。过滤搜索不扫描正文；远程部署和用户数据恢复未验收。 |
| 文档解析与导入 | 云端上传/URL 导入；后端 `document_tasks.py`、`services/document_pipeline/`。桌面参考导入见 `frontend/src/officeTasks/` | `test_review_downloads.py` 与前端 DOCX/PPTX/PDF 导入测试；2026-10-20 OCR 6 项包含本机 Tesseract 合成扫描 PDF 与资源预算 | OCR 取决于 Tesseract、语言包和运行配置，不保证扫描件识别；复杂版面、图表、批注和原始 Office 排版不保真。 |
| 云端问答与检索 | Web `/chat`；`frontend/src/pages/ChatPage.tsx`；后端 `chat.py`、`document_chat.py`、`services/rag_chain.py`、`services/vector_store.py` | 2026-10-21 主 Embedding 单次合成请求 HTTP 200、1024 维与配置一致；2026-10-20 主备 LLM/工具、pgvector 权限及真实 Embedding/Qwen/流式与非流式合成 RAG 服务层已有通过证据；selected-30 真实模型复核。2026-10-21 增强提示词并新增运行时医疗证据边界，覆盖常见个人症状/历史问答和未完整匹配药名的疗效查询 | 运行时规则只覆盖明确列出的问法和剂型，不是通用语义审查。选定医疗问法强制检索，空证据不降级通用医疗答复；历史个案事实和已明确药品事实保留模型路径。本批仅模拟检索/模型回归及缓存证据离线重放，未重跑真实 RAG、数据库或重排；业务金标、人工评分和目标库迁移仍开放。 |
| 云端重排方案 | `/settings` → 云端知识库检索；`services/rerankPreference.ts`、后端 `services/qwen_reranker.py` | 默认/持久化/账号与服务器隔离/三类请求测试；后端重排 27 项；真实 Qwen 请求及 Docker 合成 RAG 服务层联调通过 | 默认沿用服务端现状；可选主供应商 `qwen3.7-text-rerank`，失败使用原检索顺序。保留主配置区域，不影响本地库；高级开关和业务质量边界见 [重排说明](RERANKING.md)。 |
| 云端向量离线迁移 | 后端 `python -m app.ops.embedding_migration`；操作见 [迁移与回退](CLOUD_EMBEDDING_MIGRATION.md) | 隔离 PostgreSQL 18.4/pgvector 合成 1536→1024 事务切换、IVFFlat 查询和精确回退；真实主 Embedding 单条合成材料闭环通过；新回归已接入生产镜像 CI，远程结果待确认 | 需停写和已验证联合备份；只重建现有 completed/low_quality 未删除文档分块。回退要求数据未变化，恢复写入后应按备份/迁移计划回滚；无自动续传。未迁移用户目标库，不代表生产停写/RPO/RTO或业务质量验收。 |
| 账号、权限与公开页面 | `/login`、`/register`、`/set-password`、`/settings`、`/admin/applications`、`/help`、`/privacy`；后端 `auth.py`、`registration.py`、依赖与权限服务 | 认证/删除/公开页面测试；2026-10-20 真实 Redis 通知投递、吊销/禁用/客户端退出、租约释放与票据重放回归通过，纳入后端 747 项 | 修复 ASGI 取消中断清理导致租约延迟释放；CI `39399397307` 已通过。当前无已注册账号自助密码重置接口；实例隐私声明和生产邮件流程仍待验收。 |
| 管理备份与恢复 | 管理员 `/admin/backup-recovery`；`BackupRecoveryPage.tsx`、后端 `ops/` API 与独立 ops worker；离线联合恢复见 `docs/JOINT_RECOVERY_BUNDLE.md` | 2026-10-20 隔离 PostgreSQL 18.4/pgvector 上联合恢复、原有运维备份与维护队列共 64/64 通过；2026-10-21 PG16.15 内置镜像工具在 PG16.14/CI PG16 上恢复/维护/联合恢复/权限/监督器 66/66 通过（本机和完整 CI）；本轮另有 **34 项非 live 联合包安全回归**通过 | 在线数据库快照不包含上传文件/PVC、Redis、对象存储或运行配置；离线联合包是独立 CLI，本地隔离恢复不代表目标部署、RPO/RTO 或回滚演练完成；本轮未运行 PG live 联合恢复；其他主版本需按构建参数匹配客户端/源库/目标库。 |
| 本机工作台与密钥库 | `/workbench`，由 `WorkbenchPage.tsx` 提供对话、模型连接、任务、记录和本机加密库；核心实现位于 `frontend/src/store/workbenchStore.ts` | 工作台、存储、备份及模型连接测试；2026-10-17 Playwright 工作台流程 | 本机库与服务端账号数据分开。导出的 Office/HTML 文件是明文副本；Windows WebView2 真机验收仍开放。 |
| 本地知识库 | `/local-knowledge`；`frontend/src/localKnowledge/`、`pages/LocalKnowledgePage.tsx` | `LocalKnowledgePage.test.tsx`、本地 E5 浏览器基准、四浏览器 API smoke，证据见工作记录和 `LOCAL_KNOWLEDGE_BENCHMARK_2026-09-22.md` | 用户主动启用后才下载 E5。运行中的原文/向量未加密；加密备份不改变此边界。低配设备、Safari/WebView2 和目标容量仍未完整验收。 |
| AI 文档与 Office 生成 | 工作台「任务」页；`components/workbench/OfficeTasks.tsx`、`DocumentTasks.tsx`、`officeTasks/` | 前端全量 135 文件/1298 项通过，Playwright 使用模拟模型；Word 36 页自动版面检查通过，人工抽看；PowerPoint 和 Excel COM 实开产物，另核验 XLS 的数字/长中文/公式文本 | DOCX 支持目录、页眉页码、手动分页和受限表格布局；PPTX 有可编辑表格及长内容分页；XLSX 有样式/冻结/筛选，XLS 只保留数据/列宽。两者支持安全数值、只转换首张 Markdown 表格、不计算公式，不承诺任意文件保真。 |
| AI 可视化网页设计 | 工作台「任务 → 网页设计」；`components/workbench/WebDesigner.tsx`、`webDesignerOutput.ts` | `WebDesigner.test.tsx` 与 `npm run verify:ai-workbench`：布局、主副色、组件色、六类滚动示例、文字/图片、沙箱预览和下载 | 2026-10-17 流程使用模拟模型；2026-10-21 真实主模型合成网页生成通过选色/示例文字、沙箱/CSP/下载及 390px 检查，不能推导所有网页设计质量。导出 HTML 需人工检查再部署。 |
| 参考资料复用 | 文档/Markdown 任务内的本机资料库；`ReferenceLibrary.tsx`、`LocalMarkdown.tsx`、`workbenchStore.ts` | `LocalMarkdown.test.tsx` 与 `workbenchStore.test.ts` 77 项通过；浏览器流程覆盖清空后载回和加密检查 | 保存的是解析后的文本，不是原文件；最多 20 份。载回本身不发送资料，执行云端任务时仍需逐次授权。 |
| 笔记、待办与提醒 | 工作台「笔记与待办」；`PersonalItems.tsx`、`ServerReminders.tsx`；后端 `personal.py` | `test_personal.py`；历史单封合成 SMTP 已由用户确认收件；2026-10-21 新镜像真实 Beat→Redis→prefork Worker→回环认证 SMTP 通过，一次投递、重复两条消息不重发 | 隔离合成链不代表 Resend HTTP、真实收件箱或目标部署调度/持久卷/重启验收；本批未向外部发信。 |
| 本机文件整理 | 工作台「文件整理」；`FileOrganizer.tsx`、文件历史与 Rust 文件桥 | `FileOrganizer.test.tsx`、`FileHistory.test.tsx`、文本编辑/批量编辑测试 | 仅在用户选择和授权的目录执行受限操作；跨卷、进程中断、原生 WebView2 和低配设备需目标机器验收。 |
| 可视化工作流 | 工作台任务中的工作流页；`Workflows.tsx`、`workflows/`、加密任务存储 | `Workflows.test.tsx`、workflow 定义/布局/便携备份及全量前端回归；2026-10-21 真实主模型两轮合成联调通过故障重载/授权续跑、复用上轮和停止标记 | 支持 DAG、条件、触发和最多 5 轮有界模型循环；每个工作流模型请求预算最多 30 次，成功轮次可加密检查点续跑。没有后台常驻执行或任意插件；多进程及生产调度长时运行仍待验。 |
| 监控、部署与供应商 | 后端 `/health`、`/ready`、可配置 `/metrics`；部署模板和 GitHub Actions | 完整 CI `39565144900` 对 `03ceb9d` 七个 job 全部成功：backend 895 passed/7 skipped、coverage 54%，frontend 136 文件/1300 项，生产镜像 PG16 恢复/维护/联合恢复/向量迁移 120 passed/1 skipped。npm/Python/Rust audit、160 项 Python PURL enrichment/SBOM、生产镜像构建和 Trivy 门禁通过；运维告警本机定向回归 **151 passed/15 live 排除**，新增 JSON 损坏、持久化故障及 Windows 文件占用恢复均进入后端与生产镜像回归。此前本机生产镜像全量 791/791、coverage 53.16%、110 个 Python 包 OSV 结果见历史记录。历史模型/合成 RAG/SMTP 收件证据见工作记录 | Trivy 后端仍有 76 项无修复 HIGH/CRITICAL（75 HIGH、1 CRITICAL），前端 0；可修复高/危漏洞为 0。Python SBOM 有 6 项未知许可证，仍需审阅。旧库迁移、Resend 实际 HTTP 投递/生产链和部署隐私仍待验收。其他 PostgreSQL 版本须在构建参数匹配客户端。CI 已删除本次 SHA 测试镜像，并移除 PG/Redis 容器及网络；未部署。 |
| FAQ 答案缓存 | 无用户入口或问答读写路径；旧 `FAQ_CACHE_TTL` 配置不启用功能 | 代码接线检查；管理员操作文档已明确未接入 | 未实现，不应描述为命中缓存、减少模型调用或可用功能。 |

## 证据口径

- “测试通过”只适用于工作记录中标注的日期、命令和隔离条件；历史全量测试不代表本次重跑。
- 浏览器模拟模型、SQLite/合成数据及隔离 PostgreSQL 不能替代真实 provider、生产数据库、Redis 部署、真实收件箱或桌面 WebView2 验收。
- 逐项整改状态与最新待办以 [修复跟踪](REVIEW_REMEDIATION_2026-10-10.md) 和 [工作记录](WORK_LOG.md) 为准；网页/Office 的格式边界见 [AI 办公工作台说明](AI_OFFICE_WORKBENCH.md)。
- 原 [知识库项目功能清单](../kb_qa_system/docs/知识库项目功能清单.md) 是历史详细稿，包含过时技术与数量描述，已不再作为当前功能清单。
