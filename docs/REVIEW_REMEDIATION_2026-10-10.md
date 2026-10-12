# 审查修复实施记录

依据 [审查清单](COMPREHENSIVE_REVIEW_2026-10-10.md)，用户于 2026-10-10 授权修正项目及途中发现的问题；确认先修已有功能，OCR、复杂排版、工作流循环等可选扩展暂缓，真实供应商/邮件/公开联系方式验收留到最后。原报告数据是历史发现，不算作本轮验证。本轮不操作线上部署，不更改旧 `main`。

## 实施与验收跟踪

| 条目 | 当前进度 | 本次证据或后续门槛 |
| --- | --- | --- |
| A01/A29/A30 | 实现完成；隔离与全量测试通过 | 唯一 jti、会话 sid、NX 消费旧 Refresh、批量确认吊销、一次性 WS ticket、持续认证、连接租约/心跳；真实 Redis 和 WebSocket 通知端到端仍待补验 |
| A02 | 实现完成；隔离测试通过 | 云端 embedding 指纹、缓存命名空间、维度校验与索引空间过滤；迁移 `20261010_0010` 是单一 Alembic head，但未应用到目标库。来源不明的旧向量保留为未验证并从语义检索排除，需显式重处理 |
| A03/A04/A31/A34 | 实现完成；合成 SQLite 生命周期与导出测试通过 | QA 正文/审计敏感载荷清理、事务化持久文件清理/重试、覆盖上传成功后原子切换、限量 no-store 的账号导出覆盖笔记/待办/提醒/投递历史；真实备份保留/存储策略和目标库迁移未验 |
| A05/A06/A07/A17/A25/A26 | 代码、模板与本地配置检查完成 | CSP/Nginx 安全头和 WebSocket 反代、Celery beat 与进程监管、Git/Docker 忽略及 CI secret scan、监控/SMTP 模板、关闭公网 sourcemap；Compose 配置通过，未构建/启动生产容器或投递真实通知 |
| A09/A10/A11/A24 | 已实现/部分开放 | 搜索竞态与历史账号/服务器隔离、可选搜索历史保存、标题/文件名搜索、状态/类型/日期筛选和隐私页说明均已实现；列表不搜索正文，相关性阈值仍待业务基准校准 |
| A12 | 已完成公开样本补充评估和本地筛选浏览器验收；业务校准仍开放 | Multi-CPR 30 条正例是 passage 相关性标签，不等同问答可回答标签；用户提供的 12 条无答案候选只表示 selected-30 中证据不足。真实 E5 检索 Recall@1/5 为 96.67%/100%，MRR 0.983、nDCG@5 0.988；无答案候选相似度 0.841–0.906。仅描述两类分数分布，不混算最佳分类阈值，也不调整产品拒答阈值。文件筛选实测通过：空范围禁用搜索、限定单文件、范围变更清旧结果和 390px 无横向溢出。仍需脱敏业务问答/证据标注来校准拒答与引用质量；Multi-CPR 归档无数据许可 |
| A08 | 本地测试依赖审计完成；CI/镜像审计仍开放 | 测试依赖审计发现 `pytest==8.3.3` 的 CVE-2025-71176，已升至修复版 `9.0.3`，`pytest-asyncio` 升至 `1.4.0` 并固定函数级 fixture loop；隔离后端全量 680 通过/16 跳过，PyPI 漏洞服务审计 8 个测试依赖（含解析出的传递依赖）为 0 漏洞。npm 官方全量审计 0 漏洞；此前 Python OSV 135 个运行及可选 ML 包未报漏洞。前端 CycloneDX 211 组件、Windows x64 Rust SBOM 308 crate 均有许可证。OSV API 本地请求超时；本机无 cargo/cargo-audit 且 Docker daemon 未运行，CI OSV、Rust Windows 目标 cargo-audit 和镜像 Trivy 仍待远程 CI 结果 |
| A14/A15/A16/A21 | 部分完成 | Locust 隔离/并发/超时脚本和 SSE 生命周期指标已有测试；CI 配置 PostgreSQL/pgvector、Redis、secret scan、依赖审计和镜像扫描。新增 Playwright 本地生产 UI 冒烟脚本，Chromium、Edge、Firefox、WebKit 4 个运行时均通过页面加载、IndexedDB/Worker/Crypto/WASM/CacheStorage/Web Locks、1280px/390px 布局与出站隔离检查；报告/截图在 `.tools/`。该冒烟不覆盖实际文件导入/E5 推理、Safari、WebView2、移动真机或无障碍全流程。真实多服务压力和远程 CI 尚未完成 |
| A13/A18/A19/A20/A22/A27 | 文档/代码准备完成，环境验收未完成 | 新增恢复与 schema 安全说明、功能/隐私/帮助文档更新；本地 E5/WASM 知识库真实推理、六类文件、移动窄屏、缓存离线重启及加密备份恢复已验收；尚无完整服务端业务联合恢复、回滚演练、dev.68 安装升级、8 GB/大容量/断电/跨卷测试或正式新安装包 |
| A23 | 本轮保持现有功能范围 | 用户确认可选扩展另行安排，不添加 OCR/循环等新产品模块 |
| A28 | 代码、验收脚本和隔离测试完成；真实联调待部署运行时配置 | 用户已确认阿里云 OpenAI 兼容主 LLM/Embedding、DeepSeek OpenAI 兼容 LLM 备用、Resend HTTP API，以及按实例配置管理员邮箱、未配置时隐藏。真实验收还需部署者提供模型 ID/地域端点/向量维度、运行环境凭据、已验证发件人和明确测试收件箱；运营主体、所在地、数据区域/保留/跨境/第三方处理须部署者核实。不得把代码准备描述为供应商或隐私合规验收 |
| A32/A33 | 出站校验和基础资源预算已实现；隔离测试通过 | DNS 全集校验后固定 IP、Host/SNI 校验、环境代理禁用、每跳重验证；HTML/图片累计流式读取及总时限、DOCX 解压预算、PDF 页数/文本/时间、图片像素限制。下载行为 11 项通过；未执行真实复杂 PDF/压缩响应集成和硬时限/容器资源测试 |

## 本轮验证

后端全量 **658 项通过 / 16 项跳过**；前端 **130 个测试文件 / 1262 项通过**；TypeScript check、lint、Web build、改动 Python 文件 Ruff 检查通过。监控组合及独立 Compose `config --quiet`、Sealos Kustomize 展开、Alembic 单一 head 检查和 `git diff --check` 通过。Web build 有两条既有动态导入分包提示。前后端全量结果均为本轮重跑。

本地代码/隔离测试、前端构建与线上部署分别记录。本轮未构建后端镜像或桌面安装包、未应用迁移、未启动真实容器、未连接真实 Redis/provider/SMTP、未做生产部署或数据恢复演练。

## A28 收尾追加验证（2026-10-11）

- 用户确认的供应商及公开联系方式已写入配置、部署说明和隐私/帮助页：阿里云 OpenAI 兼容端点负责主 LLM 与 Embedding；DeepSeek 仅作文本 LLM 备用；Resend 用单次 HTTP 请求；每个前端实例可公开一个有效管理员/反馈邮箱，空值或无效值不生成 `mailto:`。运营主体、所在地和实际数据处理说明保持待部署者核实。
- 增加只读/合成 provider 验收命令，覆盖配置预检、数据库 pgvector 维度读取、主备 LLM、工具调用、Embedding 与一次显式 Resend 邮件。邮件投递结果不确定时不会自动重发；并发 Celery 消息由数据库条件更新原子领取。功能停用时邮件保持 pending，不虚报 sent。
- 本次验证：后端全量 **678 通过 / 16 跳过**；前端 **131 个测试文件 / 1264 项通过**，TypeScript check、lint、Web production build 通过；改动 Python 文件 compileall、前端 shell `bash -n`、Sealos `kubectl kustomize` 和 `git diff --check` 通过。Web build 保留两条动态/静态导入分包警告。Ruff 本机二进制不可用，本次未声称 Ruff 重跑通过。
- 联调边界：运行时 provider/数据库/邮件变量未配置，`--preflight` 正确拒绝进入；没有读取后端 `.env`、没有发起真实供应商/数据库/邮件请求。真实模式应由部署者在 API 容器的密钥环境运行，并提供已验证 `EMAIL_FROM` 与明确测试收件地址；模型 API 会产生用量，邮件命令只发一封合成测试邮件。未构建容器、未部署或修改线上服务。
- 未完成：真实阿里云/DeepSeek 模型 ID、地域兼容端点及向量维度/现存数据库列核对；真实供应商工具调用与 Embedding 探测；Resend 发件域和测试收件箱投递；部署实例公开邮箱显示验收；运营主体、数据区域、保留、第三方处理及跨境说明核实。其他未完成项见上表 A08、A09/A10/A11/A12、A14/A15/A16/A21、A13/A18/A19/A20/A22/A27 和 A30/A31/A32/A33/A34。

## 2026-10-12：本地筛选浏览器验收补充

- 基准脚本补正：selected-30 使用独立 fixture 版本标识；默认合成集逐题检查证据原文；等待稳定的完成状态与检索按钮恢复；Playwright 阻止 Service Worker 和非预览源站访问，并记录业务 API/外部请求尝试。
- Chromium 浏览器验收：筛选范围清空后检索禁用；仅选一个文件时结果限定于该文件；改变范围后旧结果消失；可恢复全部文件检索。390px 下 document/body 宽度均为 390px。两种基准模式均为 0 业务 API、0 外部请求、0 模型网络请求、0 页面错误。
- selected-30 重跑：30 文档/30 片段，索引 1,371 ms；84 次查询 P50/P95/最大 77/91/96 ms；正例 Recall@1/5 96.67%/100%、MRR 0.983、nDCG@5 0.988；无答案候选分数范围 0.841–0.906。指标语义和限制见本地知识库基准文档。
- 默认合成 `standard` 重跑：100 文档/334 片段，96 次查询 P50/P95/最大 91/109/124 ms，Recall@1/5 91.67%/95.83%；48 条 gold evidence 对应文本全部匹配。峰值浏览器进程工作集样本约 1.21 GB；当前设备为高内存开发机，不替代 8 GB 验收。定向 28 项、前端全量 132 文件/1272 项、TypeScript、lint 和生产构建通过。构建保留两条既有 workflow 动态/静态导入提示。
- A08 状态：CI YAML 已配置 OSV、Windows cargo-audit、SBOM、Docker 构建及 Trivy 扫描；本机 Docker CLI 无法连接 daemon，未安装 cargo/cargo-audit，因此没有本机构建/扫描镜像，也没有新 Rust 审计结果。Python 测试依赖 PyPI 审计上轮为 0 已知漏洞；远程 CI 结果仍待确认。
- A15 浏览器冒烟（同日）：新增 `npm run test:browser-smoke`，在 Chromium 153、Edge 155、Firefox 155、Playwright WebKit 26.6 生产预览逐一加载本地知识库，检查 IndexedDB 写读/删除、Worker 消息、Web Crypto、WASM、CacheStorage、Web Locks、文件输入，以及 1280px/390px 布局。4 个浏览器均 HTTP 200，页面错误/API 请求/外部请求均为 0；报告与截图在 Git 忽略目录 `.tools/`。这不是完整业务交互验收，特别不代表真实 Safari 或 Windows WebView2。
- 未完成：远程 CI/OSV/Rust/Trivy；真实 Redis/WebSocket、provider/邮件及部署隐私核实；备份/迁移/恢复与回滚演练、Windows 安装升级、真实 Safari/WebView2/移动真机、跨浏览器业务工作流，以及 8 GB/大容量/断电测试；A12 业务拒答和引用评估仍需脱敏业务金标。Multi-CPR 样本及逐题结果仅存 Git 忽略目录。无线上部署变更。

## 2026-10-12：安全审计收尾与本地知识库验收

- 实际改动：CI 使用独立固定版本 `requirements-test.txt`，开发依赖复用该文件；Python CI 审计包含生产、可选 ML 和测试依赖。修复 Rust SBOM 的 CI 文件名（工具输出 `.json`，此前步骤误指 `.bom.json`），容器构建等待审计通过。E5/WASM 验收脚本支持指定预览 URL，避免占用已有端口。
- 依赖证据：npm 官方全量审计 0 漏洞；已有 Python OSV 审计覆盖 135 个运行/可选 ML 包，0 已知漏洞；刷新前端生产 CycloneDX 清单 211 个组件且均有许可证；重新生成 Windows x64 Rust CycloneDX 1.5 清单 308 个组件且均有许可证、无 Linux GTK 组件。本机 `cargo-audit` 仍未能运行；Windows 目标审计和 Trivy 镜像扫描须由配置好的远程 CI 执行确认。测试依赖拆分后未在本机重新完成包含新文件的 pip-audit 扫描。
- 本地知识库实际验收：Chromium 使用真实 CPU/WASM E5、真实 MD/TXT/PDF/DOCX/PPTX 解析，6 个文件索引/检索通过；启用约 35.4 秒、索引约 0.82 秒、检索约 71 ms、模型缓存重启约 3 秒。检查移动 390px 无横向溢出、无云端业务 API；屏蔽外网后缓存推理通过；合成 IndexedDB 内容加密导出、清空并恢复成功。此样本不代表低配/大容量基准，也不含 OCR。
- 本次验证：前端 TypeScript check、lint、全量 **132 文件 / 1270 项**、生产构建通过；后端全量 **680 通过 / 16 环境相关跳过**（隔离干净依赖）。CI YAML 解析、`git diff --check` 通过。构建保留两条 workflow 动态/静态导入提示。未构建容器/桌面安装包、未运行远程 CI、未访问线上服务或真实供应商/邮件。
- 后续未完成：Python 新拆分测试依赖的 OSV 复扫；Rust Windows 目标 cargo-audit 与镜像 Trivy 的 CI 结果；业务检索 A12 基准；多服务压力/浏览器兼容/完整备份恢复与升级回滚；A28 真实供应商、Resend 邮件及部署者隐私信息核实。实现已提交为 `22d76fc`（前序 A28 准备为 `0b16fd4`）；fetch/祖先与 SHA 检查确认远程无独有提交，但 push dry-run 遭 GitHub 443 连接失败，待网络恢复后普通推送。没有强推或修改 `main`。未跟踪 `output/`、`tmp/` 保留在工作区且未提交。
