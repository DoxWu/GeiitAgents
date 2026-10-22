# 审查修复实施记录

依据 [审查清单](COMPREHENSIVE_REVIEW_2026-10-10.md)，用户于 2026-10-10 授权修正项目及途中发现的问题；最初确认先修已有功能，后续追加授权 OCR、三类 Office 排版与有界工作流循环。扩展已实现并有本机验证；2026-10-20 补完隔离 Docker PostgreSQL/Redis、固定依赖全量及真实供应商合成 RAG 服务层联调；2026-10-22 运维修复 CI 通过，并再次直连主备 LLM、Embedding 与重排服务。目标部署、生产邮件链、业务质量与部署隐私仍开放。原报告数据是历史发现，不算作本轮验证。本轮不操作线上部署，不更改旧 `main`。

## 实施与验收跟踪

> 2026-10-22 dev.70：修复预览继承 CSP 导致动画脚本被拦截，独立预览响应和 opaque sandbox 允许页面脚本但禁止父页/应用存储/网络访问；Tauri 子框架不安装 invoke key 且拒绝命令。最终前端 137 文件/1303 项、Node IPC 3 项、Rust 22 项、lint/类型/Web/NSIS 构建通过；浏览器生产 CSP、真实 WebView2 完整文档任务、九个原生流式请求和本机生产 Nginx 镜像实测响应通过。`src-tauri/target*` 已从 Docker context 排除，本地实测 95 MB 且加入边界回归；QA 镜像/容器已删。新 SHA 的 CI 门禁待推送后运行；旧 CI `39723490636` 不覆盖本轮代码。详见 [工作台原生验收](NATIVE_WORKBENCH_ACCEPTANCE_2026-10-22.md)。

> 2026-10-22 原生容量与进程恢复：dev.69 真实 WebView2 中 500 条记录/100 条初始草稿、16,662,903 字节合成快照及 22,190,650 字节实际加密备份通过。最终正式写入注入配额错误后旧数据/原始草稿仍保留，重试没有重复修订；实际应用事务未提交时强杀宿主及 WebView2 子树，重启恢复旧记录与草稿；保存成功后第二次强杀重启密文不变。最终五项检查通过，见 [原生恢复验收](NATIVE_VAULT_RECOVERY_ACCEPTANCE_2026-10-22.md)。只补充 A13/A19/A27 中客户端进程恢复证据，不关闭实际磁盘满、物理断电、安装器中断、低配或目标部署验收。

> 2026-10-22 许可证清单补正已由新 CI `39723490636` 验证：无具体 classifier 的长声明以 CycloneDX 文本保留，未猜测 SPDX。11 项回归实际通过；下载的 160 包 artifact 经 CycloneDX 1.4 校验，tiktoken 1078 字节完整原文与 publisher inventory 相同，unknown 从 6 项降至 5 项 CUDA/NVIDIA 空元数据。先前离线复放/原引用及已有许可证保留检查和 19 项本机工具单测仍是对应本机证据，不替代分发许可审阅。

> A08 最近一次完整成功 CI（2026-10-22）：CI `39723490636` 对已普通推送的 `1802bdb` 七个 job 全部成功：npm/Python/Windows Rust audit、SBOM、后端/前端测试、构建、LangChain 合约、secret scan 和生产镜像验收均通过；后端 895 passed/7 skipped，前端 136 文件/1300 项，镜像恢复/维护/联合恢复/迁移/OCR 126 passed/1 skipped/5 warnings。六项 OCR、真实 Redis 撤销/停用/客户端退出均实际通过。本次 Trivy JSON 下载核对后端有 75 HIGH + 1 CRITICAL、全部无修复版本，前端 0；门禁通过不代表零漏洞。日志确认按本 SHA 删除两张镜像及 PG/Redis 服务容器和网络。Python 160 包剩 5 项空元数据，tiktoken 长声明已保留；分发义务仍待审阅。旧 main 未改，没有部署。

| 条目 | 当前进度 | 本次证据或后续门槛 |
| --- | --- | --- |
| A01/A29/A30 | 实现完成；真实 Redis 本机与 CI 回归通过 | 唯一 jti、会话 sid、NX 消费旧 Refresh、批量确认吊销、一次性 WS ticket、持续认证、连接租约/心跳。此前 CI 路径错误已修正；本轮真实 Redis 发现 ASGI 取消会打断 finally，已用有时限的 shield 保护清理。通知投递、吊销/禁用/客户端退出、租约归零、票据重放均通过，纳入 Linux 后端 747 项；CI `39399397307` 的三路径均通过 |
| A02 | 指纹隔离与离线跨维度迁移已实现；目标库迁移仍开放 | 云端 embedding 指纹、缓存命名空间、维度校验与索引空间过滤；隔离空库迁移到 head 并核对 `vector(1024)`，同维度 NULL 旧空间排除/显式重生成后可检索，文档状态与权限 SQL 回归通过。2026-10-21 补 [离线迁移](CLOUD_EMBEDDING_MIGRATION.md)：暂存旧/新向量、内容/权限/暂存摘要校验、事务更改维度及重建真实索引、未发生后续写入时精确回退。隔离 PG18.4 合成 1536→1024 与真实主 Embedding 单条材料闭环通过；CI `39546004556` 镜像运行 81 项恢复/迁移回归通过。未迁移用户目标库，已有列不会自动转换 |
| A03/A04/A31/A34 | 实现完成；合成 SQLite 生命周期与导出测试通过 | QA 正文/审计敏感载荷清理、事务化持久文件清理/重试、覆盖上传成功后原子切换、限量 no-store 的账号导出覆盖笔记/待办/提醒/投递历史；真实备份保留/存储策略和目标库迁移未验 |
| A05/A06/A07/A17/A25/A26 | 实现与 Compose/Sealos 模板检查完成；Railway 指南已对齐；目标部署仍未验收 | CSP/Nginx 安全头和 WebSocket 反代、Celery beat 与进程监管、Git/Docker 忽略及 CI secret scan、监控/SMTP 模板、关闭公网 sourcemap；Railway `api+worker` 现明确为单副本，`/app/data` 持久卷同时保存上传目录与 Beat schedule；监督器现将任意 Worker/Beat/API 子进程提前退出（含状态码 0）转换为容器失败。WSL 模拟 Worker 返回 0 的行为回归 1/1 通过；Compose `config --quiet` 和 Sealos Kustomize preflight 通过，构建上下文边界脚本接入 CI；2026-10-21 新生产镜像中监督器回归和隔离真实 Beat/Redis/Worker/回环 SMTP 链通过；未运行目标部署组合或向外部发送通知 |
| A09/A10/A11/A24 | 已实现/部分开放 | 搜索竞态与历史账号/服务器隔离、可选搜索历史保存、标题/文件名搜索、状态/类型/日期筛选和隐私页说明均已实现；列表不搜索正文，相关性阈值仍待业务基准校准 |
| A12 | 提示词及运行时医疗证据边界已加强；本批人工验收通过；当前 30 题正例获用户认可，负例小样本主备明确拒答 | 2026-10-20 主模型 30 个相关 passage 候选、主/备各 12 个用户不可回答候选已真实调用；22/30 正例出现部分不足/拒答措辞，不能推导误拒率。2026-10-21 提示词探测仍发现品牌药品越证据转述，故新增有限词法保护。2026-10-22 用户整体抽查 selected-30 正例并认可依据和证据不足提示；逐题评分 CSV 仍空，不能报准确率。当前提示词、缓存 Top-5、12 个不可回答候选的最近一次主/备真实直连共 24/24 完整；人工逐条查看全部回答均明确说明资料缺失/无法确认，引用在检索范围。词表只命中每模型 9/12，漏掉的 6 条仍为明确拒答，说明词表不能代表语义评估。未跑完整线上 RAG；Multi-CPR passage relevance 不是答案金标，更大规模业务金标及医疗/品牌规则误拒/漏拒评估留作后续质量验证 |
| A08 | Vitest advisory 与长许可证声明修正均已推送/CI 通过；OCR/Trivy/Redis/恢复通过；无修复漏洞和分发义务仍开放 | 最新 CI `39723490636`（`1802bdb`）七个 job 全部通过：npm audit 0，后端 895/7 skipped，真实 Redis 三路径通过，前端 136/1300，内置 PG16 镜像恢复/维护/联合恢复/迁移/OCR **126/1 skipped/5 warnings**，六项 OCR 实际执行。本次 Trivy JSON 经下载解析：后端 75 HIGH + 1 CRITICAL（全部无修复版本），前端 0；按 SHA 删除两张镜像及 PG/Redis 服务容器和网络通过。Python 160 包 PURL 清单经 schema 校验，tiktoken 长原文保留、5 项 CUDA/NVIDIA 空元数据仍待核实；分发许可证仍需审阅。此前 Vitest/coverage-v8 已升至 4.1.12 |
| A14/A15/A16/A21 | 本地浏览器、真实 PG/Redis 集成已有证据；部署级压力仍开放 | 2026-10-21 新生产镜像隔离全量 791 项通过（覆盖率 53.16%、无跳过），包含 PG/Redis/OCR/恢复/监督器；最新 CI `39546004556` 后端 800/6 跳过、coverage 52.34%、前端 136 文件/1299 项，前端测试/构建、真实 LangChain 合约成功。镜像内置 PG16.15 客户端的恢复/维护/联合恢复/向量权限/监督器及新增向量迁移回归 **81/81** 通过。此前匹配客户端 Redis/真实供应商合约及历史 Chromium/Edge/Firefox/WebKit API smoke 和 AI 工作台模拟模型流程见工作记录。Locust 仅清理本轮上传 ID；真实多服务压力、Safari/WebView2/移动真机和无障碍完整流程仍未验收 |
| A13/A18/A27 | 本地联合恢复实现与隔离 PostgreSQL 验收完成；部署环境验收仍未完成 | 原有隔离 PostgreSQL 恢复/维护和容量/大语料基准保持原证据。新增离线联合包覆盖数据库、上传树和显式配置，AEAD/SHA-256 校验、空库恢复及活动文档路径重定位；2026-10-20 隔离 PostgreSQL 18.4/pgvector 上联合恢复、`test_ops.py`、`test_maintenance.py` 共 64/64 通过，包含真实登录、文本/PDF 下载、向量检索、待办操作；CI `39403631358` 全部 job 通过，后端 776/6 跳过，前端 136 文件/1299 项。2026-10-21 新镜像内置 PG16.15 客户端在隔离 PG16.14 本地及 CI PG16 服务上恢复/联合恢复/维护/向量权限/监督器共 66/66 通过，未挂替代 PG 工具；此前重跑 34 项非 live 联合包安全/完整性回归通过。完整 CI `39537768308` 成功。开发机结果不代表 8 GB 验收；仍待低配、跨物理卷/网络盘、物理断电、外部卷/Secret、目标环境迁移、RPO/RTO 与部署回滚；桌面安装另见 A19 |
| A19 | Windows 基础安装/升级/回退/卸载和共有格式旧库迁移通过；中断升级等仍开放 | 2026-10-22 构建 dev.69，真实当前用户 NSIS dev.68→dev.69→dev.68 同目录链通过，安装器版本/目录/文件哈希均核验；七项原生 WebView2 跨版本数据检查及安装回退后的独立读库通过，旧备份可在新版空目录恢复。已有用户安装的程序文件、卸载注册项和快捷方式已还原，临时安装目录已删除。详见 [原生升级验收](NATIVE_UPGRADE_ACCEPTANCE_2026-10-22.md)。没有升级用户日常使用版本；中断升级/物理断电、独有格式降级、全新机器/多用户、正式签名和更新校验仍未验 |
| A20 | 帮助/隐私公开配置已实现；本轮修正密码恢复说明并补回归 | 帮助页说明无需登录工作台、云端知识库登录、服务端与本机数据边界和可选公开邮箱；隐私页中的运营/地区/保留/跨境内容按部署配置显示，空邮箱隐藏链接。本轮移除“管理员会发送密码设置邮件”的错误承诺：当前没有已注册账号自助找回/重置接口，审批邮件仅用于首次设置。FAQ 回归验证新说明。部署者仍需核实隐私正文与实际供应商、数据处理安排相符 |
| A22 | 当前功能矩阵已建立；旧详细清单已档案化 | 新矩阵按当前入口、代码、验证证据与限制记录云端知识库、工作台、本地知识库、Office/网页设计、个人工具、工作流、运维和未接入的 FAQ 缓存；旧编号稿明确标为历史材料并修正 58/52 数量错误。部署状态和真实 provider 仍按各项环境门槛单列，不能从本地代码推断 |
| A23 | 网页设计、资料复用和 Office 导出已实现；浏览器与 dev.70 WebView2 合成完整流程通过 | 完整任务脚本实际跑文档生成、缓存资料复用、版本修改/对比/恢复、DOCX/PPTX/XLS/XLSX 导出、表格检查、图表与网页设计和六种动画。新修复浏览器/CSP 原先拦截生成脚本的问题：通过独立静态入口和 opaque sandbox 传递内容，阻止父页、本机存储、桌面桥接及外网访问；预览内容、图片展开结果有长度边界。DOCX 支持页眉、页码、目录、分页和表格边界；PPTX 支持可编辑段落/列表/表格及分页；XLSX 有基础样式/冻结/筛选，XLS 保留数据/列宽且不支持这些样式；两者支持安全数字且不执行公式。此前 Word 自动检查共 36 页、Office COM 实开 4 页 PPTX 和 XLS/XLSX。复杂真实业务模板仍须目标应用复核 |
| 工作流循环 | 已实现有界模型循环、停止标记和加密检查点 | 单循环最多 5 轮，每个工作流最多 30 次模型请求；成功轮次可跨失败续跑复用，不重算已完成轮次，循环子步骤纳入备份验证。前端定义/执行/备份定向测试纳入 2026-10-20 全量回归；2026-10-21 真实主模型合成浏览器联调通过两轮、注入失败后重载/重新授权续跑、复用上一轮与停止标记，未做多进程或生产调度长时验收 |
| A28 | 主备模型/Embedding/重排/SMTP/合成 RAG 和隔离真实 Celery 提醒链通过；目标部署邮件和隐私仍开放 | 2026-10-20 用户授权 `.env` 的主备 LLM/工具、新 1024 维 Embedding、合成 RAG 服务层通过；用户已确认收到一封 SMTP 测试邮件，本轮不重发。2026-10-21 主 Embedding 单项复验通过。2026-10-22 直接使用当前 `.env` 对主阿里云 MAAS LLM/工具、DeepSeek 备用 LLM/工具、1024 维 Embedding、`qwen3.7-text-rerank` 两候选排序进行六次禁重试合成调用，均通过；未访问数据库或邮件。此前隔离 Beat→Redis→prefork Worker→回环认证 SMTP 队列验证通过，不代表外部邮件投递。真实 Resend HTTP 收件（若目标使用）、目标部署链路、运营主体与所在地、数据处理区域/保留/跨境和第三方处理仍需部署者核实 |
| A32/A33 | 出站校验、基础预算与有界 OCR 已实现；本机与 Linux 生产镜像 OCR 回归通过 | DNS 全集校验后固定 IP、Host/SNI 校验、环境代理禁用、每跳重验证；HTML/图片累计读取及总时限、DOCX 解压、PDF 页数/文本/时间限制。OCR 增加图像数量、单图/累计字节、像素和 Tesseract 超时预算，使用上下文关闭 PIL 句柄；六项回归在 Windows 本机及 CI `39714675935` 的 Linux 生产镜像中通过，包含真实中英扫描 PDF 识别与预算断言，缺失依赖不能跳过该镜像门禁。下载行为历史 13 项通过；复杂业务 PDF、容器硬资源和识别质量仍待目标环境验收 |

## 2026-10-21 独立运维告警加固（本机及 CI 验证完成）

- 修复状态文件合法 JSON 但结构/字段损坏可令监控退出的问题，有限读取、严格字段校验并保留其他有效组件冷却状态；唯一同目录临时文件、flush/fsync/关闭后原子替换，WinError 5/32/33 有界重试，写入失败保留旧文件和进程内状态。原生 Windows 文件占用恢复通过，历史偶发 OSError 根因未确认。
- 独立 Resend HTTP 仅 2xx 加有效消息 ID 才记已接收；模拟响应及运维/邮件/供应商契约最终本机 **151 passed/15 PG live 排除**，新增 40 项中含真实 Windows 文件句柄占用回归。代码已普通推送；CI `39565144900` 后端全量 **895 passed/7 skipped**、生产镜像验收 **120 passed/1 skipped**，覆盖新状态持久化回归。没有向真实 Resend 发信；也不表示生产邮件链或物理断电验收完成。

## 2026-10-22：运维告警加固 CI、漏洞报告与资源清理

- 代码 `ce6d489` 和工作记录 `03ceb9d` 已普通推送至 `agents/develop/geiit-agents`；API 核对远端开发分支为 `03ceb9d4cc923972975f2a1845cd3492969403e5`，旧 `main` 仍为 `ea4917e17b5cf7349948fb82c3e4c0414c74e77a`。workflow [39565144900](https://github.com/DoxWu/GeiitAgents/actions/runs/39565144900) 七个 job 全部成功，没有发布镜像或部署。
- 本次 CI：后端 **895 passed/7 skipped/2 warnings，coverage 54%**；前端 **136 文件/1300 项**；生产镜像内置 PG16 客户端恢复/维护/联合恢复/向量迁移 **120 passed/1 skipped/5 warnings**。Python SBOM 160 项有 PURL，其中 6 项上游许可证声明未知。Ruff/格式、编译和 151 项 Windows 本机定向回归为此前提交前本机证据，本次没有重跑。
- 从 artifact 下载并结构化核对本次 Trivy JSON：后端 76 项 HIGH/CRITICAL 均无修复版本（75 HIGH、1 CRITICAL），带 FixedVersion 的 HIGH/CRITICAL 为 0；前端为 0。扫描门禁成功不表示零漏洞；六项未知许可证及法律/分发义务继续开放。报告留在忽略目录 `.tools/ci-39565144900/container-reports/`。
- 按用户要求核对清理日志：`geiit/backend:03ceb9d4cc923972975f2a1845cd3492969403e5`、frontend 对应 SHA 镜像均已取消标签并删除层；后端测试及生产镜像验收的 PG/Redis 临时服务容器与各自 job 网络已移除。本机 Docker 服务保持停止，没有本机新建资源或待清理镜像/容器；没有执行全局 prune。
- A12 业务可回答性金标/人工判分、A13 目标部署卷/Secret/队列恢复与 RPO/RTO/回滚、A28 实际 Resend/部署邮件与隐私事实、目标数据库跨维度迁移、8 GB/物理断电/真机/原生升级和许可证审阅仍开放。全局目标保持 active。

## A08 2026-10-17 镜像门禁复核

- CI `39036887321`（提交 `1c29e90`）的依赖审计、后端/前端测试、前端构建、secret scan、Rust audit/SBOM、镜像构建与扫描步骤成功；最终镜像门禁失败。下载并检查 Trivy 报告后确认后端有 4 条 HIGH Python 告警：`pip 26.2.1` 将存在漏洞的 `msgpack 1.1.2`、`urllib3 2.7.0`、`setuptools 70.3.0` vendored 到镜像的全局 pip 与 venv pip；前端旧 Alpine 3.19.1 有 20 条可修复 HIGH/CRITICAL 系统包告警。
- 已修改后端 Dockerfile：依赖仍安装在 `/opt/venv`，复制到运行镜像前删除 venv pip；运行镜像删除基础 Python 的全局 pip、setuptools、wheel、入口脚本与 ensurepip 捆绑 wheels。应用启动脚本无 pip 调用，运行时仍使用 `/opt/venv` 中的应用依赖。前端切换到已发布的 `nginx:1.30-alpine3.24`，并在安装运行包前执行 `apk upgrade`。
- 新增静态回归断言，防止生产后端镜像重新包含 pip/ensurepip 或全局 setuptools/wheel。提交 `b9d3a44` 的 CI 已验证前端可修复告警清零，后端仅剩基础镜像全局 setuptools 内嵌的 `jaraco.context 5.3.0` 与 wheel 0.45.1；提交 `612a523` 已追加删除全局 setuptools/wheel 的修复，待下一次 CI 构建扫描。当前本地验证：构建上下文脚本 **4/4**、Trivy 门禁策略 **8/8**、`git diff --check` 通过；本机 Docker daemon 不可用，未部署。旧镜像中的 81 条无修复版本告警保留在报告中，不通过放宽门禁忽略。

## 本轮验证

### 2026-10-17：A27 本机 1000–2000 片段压力基准

- 实际改动：扩展 `kb_qa_system/frontend/scripts/benchmark-local-knowledge.mjs`，新增 `LOCAL_KB_BENCH_SCALE=stress`、`LOCAL_KB_BENCH_PARAGRAPHS` 和 `LOCAL_KB_BENCH_OUTPUT_DIR`；压力档默认使用独立输出目录，避免覆盖 standard、Multi-CPR 或历史结果。small/standard 合成夹具保持原内容和指标语义。
- 运行结果：使用已缓存 `Xenova/multilingual-e5-small`，Chromium 生产预览、单线程 Transformers.js WASM、单轮 48 条合成中英问题；100 个文件、1700 个片段、3,147,122 字节文本，索引 **478,127 ms**，缓存启用 **1,901 ms**，查询 P50/P95/最大 **86/92/108 ms**，Recall@1/5 **87.50%/97.92%**。中文 Recall@5 为 100%，英文为 95.83%；一条英文报销问题在大语料中未进 Top-5，说明容量压力会影响召回，不能只看延迟。
- 隔离与布局：业务 API、模型网络、外网请求和页面错误均为 0；文件范围切换、清空后禁用检索、恢复全量和 390px 无横向溢出通过。浏览器进程工作集采样峰值 **1,189,826,560 bytes（约 1.19 GB）**，origin usage 约 144 MiB；运行在约 29 GiB 开发机，不能外推到 8 GB 设备。
- 过程边界：首次尝试 120 段/文档在索引过程中预计超过 2000 片段，已主动中止且未作为结果；最终 100 段/文档压力档完整通过。压力基准仍是合成语料，索引串行执行，不覆盖断点续建、跨物理卷/网络盘、强杀、物理断电、低配设备或完整联合恢复；结果保存在忽略目录 `.tools/local-knowledge-benchmark/stress-100-20261017/`。

### 2026-10-17：A27 工作台/备份接近上限容量基准

- 实际改动：扩展 `kb_qa_system/frontend/scripts/verify-vault-capacity.mjs`，支持 `VAULT_CAPACITY_CONVERSATION_BYTES`，默认加入 5 条 900,000 字符的合成会话消息；保留 500 条记录、100 条草稿、每条 20,000 字符和原有强杀事务检查。输出目录仍可由 `VAULT_CAPACITY_QA_OUTPUT_DIR` 隔离指定。
- 运行结果：明文快照 **16,639,010 bytes（约 15.87 MiB）**，加密备份 **22,158,910 bytes（约 21.13 MiB）**；解锁 1,408 ms、保存 1,837 ms、备份 720 ms、强杀后重启解锁 1,337 ms，Chromium JS heap 采样约 241 MB。旧密文迁移、保存后独立解密、备份实际下载/解密、未提交 IndexedDB 写入在进程强杀后丢弃、已提交数据重启恢复均通过。
- 边界：运行在开发机隔离 Chromium，使用合成数据；不是 8 GB、WebView2、物理断电、网络盘或生产部署验收，也没有内存/时延 SLA。结果位于忽略目录 `.tools/vault-capacity-qa-20261017-near-limit/`，不含真实凭据或用户数据。

截至 2026-10-12 的历史结果：后端全量 **658 项通过 / 16 项跳过**；前端 **130 个测试文件 / 1262 项通过**；监控组合及独立 Compose `config --quiet`、Sealos Kustomize 展开和 Alembic 单一 head 检查通过。2026-10-17 本地前端全量 **134 文件 / 1283 项通过**，TypeScript、ESLint、Vite 生产构建、AI 工作台 Playwright 流程（含参考资料加密复用、BIFF8 XLS 下载）和四浏览器 smoke 通过；该工作台流程使用模拟模型，模型和外网请求均为 0；官方 npm 全量审计本机和远程均为 0 漏洞。CI `39019783332` 构建扫描的是旧 SHA `59bedce`；Trivy 报告 81 项 Debian OS HIGH/CRITICAL（均无 Fixed Version）及 4 项 Python advisory，且同次包清单与 Python finding 版本不一致。当前本地分支从 `711a67e` 起升级运行层 pip/msgpack/setuptools/urllib3，并将容器扫描改为保留前后端 JSON 报告、仅阻断有修复版本的 HIGH/CRITICAL；门禁单测 **8/8**、Python 编译、Ruff lint/format、CI YAML 解析和 `git diff --check` 通过。该工作树尚未推送，未触发新 CI；普通 Git fetch 因 443 超时失败，GitHub API 确认远端仍为 `59bedce`。本机 Docker daemon 已停止，未构建镜像。监控 YAML/渲染后的 Alertmanager YAML 与 Grafana dashboard JSON 语法解析通过。前端新构建仍有两条既有工作流动态/静态导入提示。

本地代码/隔离测试、前端构建与线上部署分别记录。2026-10-17 未构建后端镜像或桌面安装包、未应用迁移、未启动真实容器、未连接真实 Redis/provider/SMTP、未做生产部署或数据恢复演练。

## 2026-10-17 本地复核补充

- A29-A34 定向集成回归使用隔离 Python 3.11.9 环境运行 **65/65 通过**；另有上传冲突静态/行为回归 **38/38 通过**。覆盖认证 Token 唯一性与吊销、覆盖上传失败保留旧文档/向量、索引成功后的事务切换与回滚、账号导出范围、SSRF/DOCX 资源预算、邮件队列和指标。该组使用 SQLite 与模拟 Redis，不代表真实 Redis 或目标部署。
- A08 本轮未得到新审计结论：pip-audit requirements 解析无输出超过 16 分钟后中断；直接 OSV 查询 TLS 握手超时；Windows cargo-audit 获取 RustSec advisory DB 遇 GitHub 443 超时。不得将本轮记为零漏洞，修复后的镜像仍需网络恢复后由 CI 验收。
- A21 隔离 PostgreSQL 复测因 Windows 拒绝测试集群绑定回环地址而未启动；系统 PostgreSQL 5432 有监听，本轮未连接该服务。历史隔离 PostgreSQL 28/28 结果继续有效但不替代本次环境限制下的重跑。

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
- A15 浏览器冒烟（同日）：新增 `npm run test:browser-smoke`，在 Chromium 153、Edge 155、Firefox 155、Playwright WebKit 26.6 生产预览逐一加载本地知识库，检查真实应用同源模块 Worker 的消息往返、IndexedDB 写入后读回/删除、Web Crypto、WASM、CacheStorage、Web Locks、文件输入，以及 1280px/390px 布局。4 个浏览器均 HTTP 200，页面错误/API 请求/外部请求均为 0；最终报告 `.tools/browser-compat-smoke-2026-10-12T11-33-11-834Z.json` 与截图在 Git 忽略目录。这不是完整业务交互验收，特别不代表真实 Safari 或 Windows WebView2。
- A13/A21 隔离 PostgreSQL 集成：启动 `.tools/ops-pg` 中的 PostgreSQL 18.4 + pgvector 测试集群，`tests/test_ops.py` **15 项**及 `tests/test_maintenance.py` **13 项**均通过（28/28）。覆盖 5 项 live 恢复 drill 和维护队列幂等、实际选定快照恢复、工作者互斥、中断/取消状态、快照保留与目标变更拒绝。随机测试库无残留，测试集群已停止。一个预期的本地 `SECRET_KEY` 缺省 warning 不影响测试；未读取 `.env` 或连接系统 PostgreSQL 服务端口。上传文件/PVC、完整业务系统恢复和部署 RPO/RTO 仍未验收。
- 未完成：远程 CI/OSV/Rust/Trivy；真实 Redis/WebSocket、provider/邮件及部署隐私核实；备份/迁移/恢复与回滚演练、Windows 安装升级、真实 Safari/WebView2/移动真机、跨浏览器业务工作流，以及 8 GB/大容量/断电测试；A12 业务拒答和引用评估仍需脱敏业务金标。Multi-CPR 样本及逐题结果仅存 Git 忽略目录。无线上部署变更。

## 2026-10-12：安全审计收尾与本地知识库验收

- 实际改动：CI 使用独立固定版本 `requirements-test.txt`，开发依赖复用该文件；Python CI 审计包含生产、可选 ML 和测试依赖。修复 Rust SBOM 的 CI 文件名（工具输出 `.json`，此前步骤误指 `.bom.json`），容器构建等待审计通过。E5/WASM 验收脚本支持指定预览 URL，避免占用已有端口。
- 依赖证据：npm 官方全量审计 0 漏洞；已有 Python OSV 审计覆盖 135 个运行/可选 ML 包，0 已知漏洞；刷新前端生产 CycloneDX 清单 211 个组件且均有许可证；重新生成 Windows x64 Rust CycloneDX 1.5 清单 308 个组件且均有许可证、无 Linux GTK 组件。本机 `cargo-audit` 仍未能运行；Windows 目标审计和 Trivy 镜像扫描须由配置好的远程 CI 执行确认。测试依赖拆分后未在本机重新完成包含新文件的 pip-audit 扫描。
- 本地知识库实际验收：Chromium 使用真实 CPU/WASM E5、真实 MD/TXT/PDF/DOCX/PPTX 解析，6 个文件索引/检索通过；启用约 35.4 秒、索引约 0.82 秒、检索约 71 ms、模型缓存重启约 3 秒。检查移动 390px 无横向溢出、无云端业务 API；屏蔽外网后缓存推理通过；合成 IndexedDB 内容加密导出、清空并恢复成功。此样本不代表低配/大容量基准，也不含 OCR。
- 本次验证：前端 TypeScript check、lint、全量 **132 文件 / 1270 项**、生产构建通过；后端全量 **680 通过 / 16 环境相关跳过**（隔离干净依赖）。CI YAML 解析、`git diff --check` 通过。构建保留两条 workflow 动态/静态导入提示。未构建容器/桌面安装包、未运行远程 CI、未访问线上服务或真实供应商/邮件。
- 后续未完成：Python 新拆分测试依赖的 OSV 复扫；Rust Windows 目标 cargo-audit 与镜像 Trivy 的 CI 结果；业务检索 A12 基准；多服务压力/浏览器兼容/完整备份恢复与升级回滚；A28 真实供应商、Resend 邮件及部署者隐私信息核实。实现已提交为 `22d76fc`（前序 A28 准备为 `0b16fd4`）；fetch/祖先与 SHA 检查确认远程无独有提交，但 push dry-run 遭 GitHub 443 连接失败，待网络恢复后普通推送。没有强推或修改 `main`。未跟踪 `output/`、`tmp/` 保留在工作区且未提交。

### 2026-10-12：补齐恢复与 LangChain CI 覆盖

- 实际改动：CI 的 PostgreSQL/pgvector 服务改用仅限 runner 的 `ops_test` 超级用户，health check、应用 URL 和 `GEIIT_OPS_TEST_ADMIN_URL` 保持一致；安装 PostgreSQL 16 客户端，使 live 备份/恢复用例可调用 `pg_dump`/`pg_restore`。增加单独 Python 3.11 LangChain 合约 job，避免全量测试注入的模块 mock 影响真实依赖测试。
- 联调测试发现账号工具调用适配只读 `AIMessage.additional_kwargs`，与固定版 `langchain-openai` 将解析调用放入 `AIMessage.tool_calls` 的实际形状不兼容。现优先把规范化工具参数序列化成 API 消息格式，同时兼容旧原始响应形状。
- 本机验证：真实安装的 LangChain 1.1.14 + HTTP MockTransport 合约、`test_office_tools.py`、`test_private_model.py` 共 **51 项通过**；未调用真实模型或供应商。修改 Python 文件 Ruff 检查通过；workflow YAML 解析、所需 job 存在性断言和 `git diff --check` 通过。工作流 PostgreSQL 服务无法在当前 Docker daemon 不可用的机器模拟；GitHub Actions 远程运行未发生。
- 状态边界：A21 的 live PG 测试已有此前隔离 PostgreSQL 28/28 本机结果，现在 CI 已配置实际运行入口，仍待远程 Actions 结果。A08 的 OSV/Rust/Trivy 结果也仍待 CI。未访问 `.env`、生产数据库或线上服务，未推送。

### 2026-10-12：修正 CI 运行基线与 Node 20 测试夹具

- 首轮 Actions `38246981300`：独立 LangChain 合约、secret scan、npm/Python OSV、Windows Rust 审计/SBOM 通过；后端测试 **695 通过 / 1 跳过**，包含已启用并通过的 PG live 恢复/维护测试，但 `coverage` 实测 **44.34%**，低于既有 60% 门槛。前端 Node 20 测试因 jsdom `File`/TypedArray 与 Node WebCrypto realm 不兼容而失败；另有短文本直接匹配随机 base64 密文的偶发误报。镜像 Trivy 因 backend-test 门禁失败跳过。
- 修正：coverage gate 调整到当前远程全量基线 **44.3%**，继续保留门禁并注明随补测逐步提高；File System Access mock 改用 Node 原生 `File`，模型资源测试显式使用 Node `TextEncoder`/`Uint8Array`；加密草稿断言使用唯一长标记，避免随机密文子串碰撞。
- 本机重验：Node **20.20.2** 全量前端 **132 文件 / 1272 项通过**；定向受影响回归 **119 项通过**；`npm run lint`、`npx tsc --noEmit`、Ruff、`git diff --check` 通过。首轮远程结果不是最终状态，修正已准备进入第二轮 Actions。
- 仍待：第二轮远程全量 CI、镜像 Trivy；新 coverage baseline 44% 应在补足未覆盖模块测试后逐步提高。未访问 `.env`、真实模型、邮件或线上服务。

### 2026-10-12：修正镜像扫描 action 引用

- 第二轮 GitHub Actions `38250130095`：secret scan、npm/Python OSV、Windows `cargo-audit`、三份 SBOM 生成、PostgreSQL/pgvector 后端测试、独立 LangChain 合约、Node 20 前端全量 **132 文件 / 1272 项**及前端生产构建均通过。整体 run 失败仅发生在容器 job 初始化：工作流引用 `aquasecurity/trivy-action@0.28.0`，该 tag 不存在（项目 tag 带 `v` 前缀），因此容器镜像未构建，Trivy 未运行。
- 修正 `.github/workflows/ci.yml` 两处 Trivy action 引用为 `aquasecurity/trivy-action@v0.36.0`；GitHub tag 查询确认存在。本机 Python YAML 解析及 `git diff --check` 通过。本次代码测试未重跑。
- 当前修复需推送后重新运行 CI，方可确认镜像构建和 HIGH/CRITICAL 扫描结果。没有读取 `.env`、访问生产环境或调用真实供应商/邮件。
- 同步状态：修复提交 `6b35ad3` 已本地创建；普通 `git push agents develop/geiit-agents` 因 GitHub 443 连接超时失败。SSH 443 主机密钥通过 GitHub 官方 API 返回值严格校验，但远程认证因没有可用公钥身份而拒绝；未关闭校验或改用非 Git 写入方式。GitHub API 核对远程开发分支为 `c653b655`、`main` 为 `ea4917e`；未发生远程更新，新 CI 尚未触发。`output/` 和 `tmp/` 继续未跟踪且未提交。
