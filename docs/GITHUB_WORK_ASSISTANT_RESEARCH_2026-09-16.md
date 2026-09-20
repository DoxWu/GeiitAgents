GitHub 办公客户端参考项目调研（2026-09-16）

本次已在线读取主要候选项目的仓库首页或 README、许可证、部分依赖文件以及发布订阅。GitHub 公共 API 返回匿名额度耗尽，通用搜索页返回 429；改用可正常访问的 [Cowork 主题页](https://github.com/topics/cowork)、项目页面、原始文件和发布订阅完成候选发现与核验。没有安装或运行这些项目，也没有进行性能和生成文件质量测试。

结合 GeiIt 当前 React 18 + Zustand + FastAPI + Celery + PostgreSQL 的基础，最值得优先看的项目变为 **AionUi、Eigent、AnythingLLM、Langflow**。它们分别对应办公文件流程、相近技术栈的桌面任务应用、知识库与自动化的结合、可嵌入的可视化 AI 工作流。Cherry Studio 仍适合参考客户端体验；Dify 和 n8n 适合研究工作流与自动化设计，但直接嵌入对外产品前需要处理各自的许可条件。

这里的“已核验能力”表示上游当前文档或代码明确列出，不代表所有功能都包含在表内某个已发布安装包中。默认分支可能领先稳定版本；实际选型时应锁定 tag/commit，再验证目标功能。上游营销性性能和保真度承诺不作为本项目的测试结论。

**优先参考的产品与框架**

| 优先级 | 项目 | 已核验的相关能力 | 对本项目的具体价值 | 根许可证 |
|---|---|---|---|---|
| 最高 | [AionUi](https://github.com/iOfficeAI/AionUi) | Word/Excel/PPT 助手，PDF 等成果预览，文件修改与差异展示，独立并行会话，自配模型，MCP，定时任务 | 直接研究“对话提出需求→执行工具→右侧预览→修改文件→重复执行”的产品流程 | Apache-2.0 |
| 最高 | [Eigent](https://github.com/eigent-ai/eigent) | 桌面任务执行、本地文件整理、浏览器/终端工具、模型配置、定时自动化；React、Zustand、FastAPI、Electron、React Flow | 技术栈与现有项目很接近，研究前后端边界、运行状态、工具和成果展示 | Apache-2.0 |
| 高 | [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) | 工作区、文档问答、Agent、无代码 Agent Flows、MCP、记忆、Scheduled Tasks、模型路由 | 研究怎样让已有知识库成为任务工具，以及怎样隔离工作区与上下文 | MIT |
| 高 | [Langflow](https://github.com/langflow-ai/langflow) | 可视化搭建、Python 自定义组件、逐步调试、流程导出 JSON、API/MCP 服务、桌面发行版 | 当前 Python 后端做工作流时，优先对照它的组件接口和运行/调试方式 | MIT |
| 高 | [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | Windows/macOS/Linux 桌面、多供应商和本机模型、多会话、Office/PDF 输入、MCP、备份 | 研究模型设置、会话侧栏、文件输入、桌面体验；区分社区版与企业版能力 | AGPL-3.0 |
| 高 | [Dify](https://github.com/langgenius/dify) | 工作流、RAG、Agent、模型管理、插件和运行可观测性 | 参考画布、变量/节点配置、运行记录；整体接入会引入另一套平台 | 修改后的 Apache-2.0，另有条件 |
| 高 | [n8n](https://github.com/n8n-io/n8n) | 可视化自动化、连接器、模型接入、工具调用、人工节点和自托管 | 研究定时触发、邮箱/日历连接器、凭据和失败处理 | Sustainable Use License；EE 文件另有许可 |
| 中 | [LibreChat](https://github.com/danny-avila/LibreChat) | 多模型、Agents、MCP、Artifacts、代码工具、可恢复流；当前文档另列实验性工作区 | 对照本项目“切换对话中断”“断线恢复”“工具执行卡片”等改造 | MIT |
| 中 | [OpenWork](https://github.com/different-ai/openwork) | 桌面工作区、技能/MCP 复用、连接服务和团队能力分配 | 研究“可复用能力”如何分享与管理；当前默认分支是 dev，架构为 React + Electron | ee/ 外 MIT；ee/ 使用单独 EE 许可 |
| 中 | [QwenPaw](https://github.com/agentscope-ai/QwenPaw) | 个人记忆、文件工作区、文档处理、定时任务、多渠道和模型接入；Tauri 桌面测试版 | 研究个人事项、记忆、调度及 Python 服务打包；原 CoPaw URL 当前重定向到该仓库 | Apache-2.0 |

**对办公文件最值得深入看的：AionUi + OfficeCLI。** AionUi 的当前 README 明确列出 Word、Excel、PPT 助手以及相应技能，并链接到 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)。后者当前文档描述了 DOCX/XLSX/PPTX 的创建、读取、结构查询、元素修改、格式问题分析、图表操作和 HTML/PNG 预览；根 [LICENSE](https://github.com/iOfficeAI/OfficeCLI/blob/main/LICENSE) 为 Apache-2.0。

可以把 OfficeCLI 作为 `document.inspect`、`document.edit`、`document.render` 的候选实现，与现有 python-docx 和计划中的 docxtpl/LibreOffice 做样本对比。重点测试中文字体、分页、页眉页脚、目录、合并单元格、公式重算、图表与复杂原文件往返保存。CLI 的存在不等于自动解决格式保真，也不等于一个可直接调用的托管 API；接入时仍需封装任务、限制运行目录和资源，并保存文件版本。

AionUi 的定时任务文档明确区分 cron（含时区）、固定间隔和一次性触发，还允许继续原会话或每次新建会话。这非常适合借鉴用户所说的“用不同对话隔开任务”。其本机任务还涉及防休眠和唤醒后的漏触发处理；不能据此承诺电脑关机后仍然执行。GeiIt 的邮件提醒仍建议放在持续在线的服务端。

**对现有代码迁移最值得看的：Eigent。** 实际读取的 [package.json](https://github.com/eigent-ai/eigent/blob/main/package.json) 包含 React 18.3.1、Zustand 5、Electron 和 `@xyflow/react`；[backend/pyproject.toml](https://github.com/eigent-ai/eigent/blob/main/backend/pyproject.toml) 包含 FastAPI、Uvicorn、CAMEL，Python 范围为 `>=3.11,<3.12`。它与你的技术栈接近，理解和对照成本较低。

优先研究会话如何绑定运行、前端如何展示执行步骤、Python 工具如何返回成果、模型设置如何传到执行器。React Flow 依赖本身不能证明任意用户拖拽流程均已成熟可用，需要再看对应功能和测试。其多 Agent 设计也不是首版必须复制的能力；单任务执行器先稳定，再按真实任务需要加入并行执行。

**对已有 RAG 的扩展最值得看的：AnythingLLM。** 本次当前 README 已列出 Scheduled Tasks、自动/用户管理记忆、Dynamic Model Routing、Agent Flows 和 MCP，参考范围比仅“文档聊天”更广。注意 README 明确把多用户权限列为 Docker 版功能，不能把桌面版、Docker 版和托管版能力混为一谈。

**对可视化工作流的实现建议更新：Langflow 与 Dify 一起比较。** Langflow 当前根许可为 MIT，并提供 Python 组件定制、逐步控制、API 和 MCP 发布方式，对当前 FastAPI 项目更容易做技术对照。Dify 的产品完成度和工作流交互值得研究，但是否整体接入，要同时评估其多租户限制、前端品牌条件、部署成本和现有账户/知识库体系的整合成本。

本项目仍可采用 React Flow 自己实现精简画布，并复用 TaskRun/ToolRun。如果短期必须提供成熟画布，可先对 Langflow 的“通过 API 调用流程”做隔离验证；业务会话、文件成果和提醒记录继续由 GeiIt 统一管理，避免两边各有一套不可同步的事实记录。

**维护状态有近期发布记录支持。** 下表日期取自各仓库 `releases.atom` 的 `updated` 字段，按 UTC 日期展示；它是发布条目更新时间，不一定等于首次发布日期。列出的只是本次观察到的近期条目，不一概代表最新稳定版，也没有用 Star 数代替质量评估。

| 项目 | 观察到的近期条目 | 条目更新时间（UTC） | 解释 |
|---|---|---|---|
| AionUi | [v2.2.2](https://github.com/iOfficeAI/AionUi/releases/tag/v2.2.2) | 2026-09-09 | 有近期版本活动 |
| Eigent | [v1.0.4](https://github.com/eigent-ai/eigent/releases/tag/v1.0.4) | 2026-09-04 | 有近期版本活动 |
| AnythingLLM | [v1.16.1](https://github.com/Mintplex-Labs/anything-llm/releases/tag/v1.16.1) | 2026-08-27 | 有近期版本活动 |
| Cherry Studio | [v2.0.14](https://github.com/CherryHQ/cherry-studio/releases/tag/v2.0.14) | 2026-09-09 | 有近期版本活动 |
| Dify | [v1.17.1](https://github.com/langgenius/dify/releases/tag/1.17.1) | 2026-09-10 | 有近期版本活动 |
| n8n | [n8n@2.40.1](https://github.com/n8n-io/n8n/releases/tag/n8n%402.40.1) | 2026-09-16 | 订阅中另有 stable、v1 等滚动条目，不混作同一版本 |
| Langflow | [1.12.2](https://github.com/langflow-ai/langflow/releases/tag/v1.12.2) | 2026-09-16 | 另观察到 1.13.0.dev14 开发版 |
| LibreChat | [v0.8.8-rc3](https://github.com/danny-avila/LibreChat/releases/tag/v0.8.8-rc3) | 2026-09-15 | RC 候选版；实验性工作区不按稳定功能承诺 |
| OpenWork | [v0.18.48](https://github.com/different-ai/openwork/releases/tag/v0.18.48) | 2026-09-15 | 许可表取当前 dev 分支，不直接推断历史 tag 许可 |
| QwenPaw | [v2.2.1](https://github.com/agentscope-ai/QwenPaw/releases/tag/v2.2.1) | 2026-09-11 | README 同时明确桌面应用处于 Beta |

**许可证会影响“参考”之后怎么用。** 这是本次直接读取许可原文后，与当前可能面向多个用户、需要自身品牌的产品最相关的区别。

- AionUi、Eigent、QwenPaw、OfficeCLI 根许可为 Apache-2.0；AnythingLLM、Langflow、LibreChat 根许可为 MIT。适合作为优先代码评估对象，但应核对具体目录、依赖、模型权重与素材，并保留适用通知。
- Cherry Studio 社区版采用 AGPL-3.0，README 明确允许遵守该协议的商业使用，也提供商业授权联系入口。直接修改分发或涉及协议覆盖的网络使用需要履行相应源码义务；不能把 AGPL 理解为禁止商用，也不能当作 MIT 集成。
- Dify 许可明确允许商业用途及作为后端，但未经书面授权不可使用其源码运营多租户环境，tenant 定义为 workspace。使用其前端时不得移除或修改所列 LOGO/版权信息；不涉及该前端的使用不适用该前端条件。企业知识库未来面向多组织时，这与部署方案直接相关。
- n8n 的 Sustainable Use License 限定自身内部业务或非商业/个人用途，对外提供/分发也有限制；`.ee.` 文件或 `.ee` 目录适用企业许可。内部辅助自动化和把编辑器嵌入收费产品是不同使用情形，后者不能默认由社区许可覆盖。
- OpenWork 当前按目录划分：ee/ 外 MIT；ee/ 的组织控制层采用 EE 许可。其原文列出最多 5 用户组织的有限生产使用豁免（不含定义的 Enterprise Features）、30 天内部评估和开发测试豁免，以及每个版本发布两年后转 MIT；既有历史版本仍按其原许可。不可只看仓库标题断言整个产品都是 MIT。

**可拆出来评估的底层组件**

| 组件 | 适合的模块 | 本次核验范围 |
|---|---|---|
| [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) | Office 读写、检查、编辑、渲染预览 | 项目页面和 Apache-2.0 原文；未实测质量 |
| [React Flow / xyflow](https://github.com/xyflow/xyflow) | React 工作流画布 | 根 LICENSE 为 MIT；执行引擎需另实现 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 有状态任务编排、暂停恢复 | 根 LICENSE 为 MIT；不代表其所有托管产品都采用相同条款 |
| [Docling](https://github.com/docling-project/docling) | 复杂文档结构解析 | 根 LICENSE 为 MIT；模型依赖另核对 |
| [Gotenberg](https://github.com/gotenberg/gotenberg) | 文档/PDF 转换服务 | 根 LICENSE 为 MIT；镜像内第三方依赖另核对 |
| [Tauri](https://github.com/tauri-apps/tauri) | 复用 Web 界面的桌面应用 | 仓库声明代码按适用范围采用 MIT 或 MIT/Apache-2.0；品牌图形另有条款 |

桌面路线维持“先用同一页面实测 Tauri 与 Electron”。多个相似办公项目选用 Electron，说明其生态值得考虑，不构成性能比较结论；QwenPaw 提供 Tauri 桌面测试版，也不能直接证明 Python 全量打包成本已经解决。本项目优先保留在线/内网后端，让桌面端承担界面和受限本地能力的方案仍成立。

推荐用三条真实任务比较候选实现：把带中文表格和页眉的 Word 改成公司模板并导出 PDF；从 Excel 检查数据、生成图表并写入周报；保存待办后改期/取消提醒，同时切换会话继续另一个任务。记录成功率、原文件保留、结果是否可编辑、耗时、Token 成本、内存峰值和错误恢复。没有这些样本结果前，不建议替换现有后端或绑定一个完整平台。

主要功能与许可来源（访问日期均为 2026-09-16）：

| 项目 | 功能/代码来源 | 许可来源 |
|---|---|---|
| AionUi | [readme.md](https://github.com/iOfficeAI/AionUi/blob/main/readme.md)、[package.json](https://github.com/iOfficeAI/AionUi/blob/main/package.json) | [LICENSE](https://github.com/iOfficeAI/AionUi/blob/main/LICENSE) |
| Eigent | [README](https://github.com/eigent-ai/eigent/blob/main/README.md)、[后端依赖](https://github.com/eigent-ai/eigent/blob/main/backend/pyproject.toml) | [LICENSE](https://github.com/eigent-ai/eigent/blob/main/LICENSE) |
| AnythingLLM | [README](https://github.com/Mintplex-Labs/anything-llm/blob/master/README.md) | [LICENSE](https://github.com/Mintplex-Labs/anything-llm/blob/master/LICENSE) |
| Langflow | [README](https://github.com/langflow-ai/langflow/blob/main/README.md) | [LICENSE](https://github.com/langflow-ai/langflow/blob/main/LICENSE) |
| Cherry Studio | [README](https://github.com/CherryHQ/cherry-studio/blob/main/README.md) | [LICENSE](https://github.com/CherryHQ/cherry-studio/blob/main/LICENSE) |
| Dify | [README](https://github.com/langgenius/dify/blob/main/README.md) | [LICENSE](https://github.com/langgenius/dify/blob/main/LICENSE) |
| n8n | [README](https://github.com/n8n-io/n8n/blob/master/README.md) | [LICENSE.md](https://github.com/n8n-io/n8n/blob/master/LICENSE.md) |
| LibreChat | [README](https://github.com/danny-avila/LibreChat/blob/main/README.md) | [LICENSE](https://github.com/danny-avila/LibreChat/blob/main/LICENSE) |
| OpenWork | [README](https://github.com/different-ai/openwork/blob/dev/README.md) | [根 LICENSE](https://github.com/different-ai/openwork/blob/dev/LICENSE)、[ee/LICENSE](https://github.com/different-ai/openwork/blob/dev/ee/LICENSE) |
| QwenPaw | [README](https://github.com/agentscope-ai/QwenPaw/blob/main/README.md) | [LICENSE](https://github.com/agentscope-ai/QwenPaw/blob/main/LICENSE) |

上述发布证据来自相应仓库的 `/releases.atom`，每条版本已链接到具体发布页面。来源 URL 大多指向会继续变化的分支；本报告描述本次观察结果，采用代码时应重新核对所选版本。
