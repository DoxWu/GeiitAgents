# 开发版本与隔离约定

更新：2026-09-20。此次审查发现此前新增功能均在 main 未提交工作区中；已有 Git 历史，但开发流程的分支隔离不足。现已保存完整改造检查点 `99cca69`，后续按功能提交。

## Git

- 原 `main` 保留在 `674d11a`（旧 Web 知识库基线）。当前工作使用 `develop/geiit-agents`；独立功能可从它创建 `feature/...` 分支，完成检查后合回开发分支。
- `origin` 保留为旧仓库 `https://github.com/DoxWu/SmallKnowladgeBase.git`；新 `agents` 为 `https://github.com/DoxWu/GeiitAgents.git`。已设置本机 `remote.pushDefault=agents`、`push.default=current`。
- 用户要求功能较完善后再推送，目前仅本地提交。后续推送开发分支应显式指定 `git push -u agents develop/geiit-agents`，先核查新远程历史，不强推、不直接覆盖远程 main；正式发布经验证后再合并/打标签。
- 2026-09-20 GitHub 443 连接超时，尚未确认新仓库可访问性、分支历史或写入权限。没有执行 push。当前配置是推送目标记录，不是已同步远程的证据。
- Git 分支隔离提交历史，不会隔离同一路径中的 node_modules、数据库或运行服务。本轮继续在现有工作目录开发，没有额外 worktree。未来并行版本需要 `git worktree` 与独立端口/数据库/环境文件一起使用。
- `.tools`、模型/用户数据、构建产物、真实 `.env.*`、本地备份文件均忽略；`.env.example` 和仅含本机默认地址的 `frontend/.env.desktop` 是明确例外。初次检查点保留旧项目历史；未来首次远程推送前仍需审计整个历史，不能把本次工作区检查当作历史凭据审计。

## 客户端与构建目录

| 用途 | 命令 | 标识与产物 |
| --- | --- | --- |
| 日常开发运行 | `npm run desktop:dev` | `com.geiit.agents.dev`、开发版窗口标题，Vite 固定端口 1420 |
| 开发测试包（默认） | `npm run desktop:build` | 同一 dev 标识；`src-tauri/target-dev`；`dist-desktop-dev` |
| 原正式通道构建 | `npm run desktop:build:release` | `com.geiit.workbench`；`src-tauri/target`；`dist`，需明确调用 |

独立应用标识让默认 Tauri 数据目录与旧测试包/未来正式通道分开；开发 NSIS 产品名也独立。旧包仍为 `GeiIt Workbench`，不能自动迁移其本地数据；可通过本地知识库加密备份有选择地迁移。备份检查点为 `0.1.0-dev.1`，回答功能为 `0.1.0-dev.2`，模型表单与回答导出/加密只读保存为 `0.1.0-dev.3`；首个持久办公文档任务为 `0.1.0-dev.4`，成果版本与本地 DOCX 导出为 `0.1.0-dev.5`，版本对比/恢复为 `0.1.0-dev.6`，后续发包继续递增。dev.6 尚未完成原生 DOCX 分页渲染验收，不能当作正式发布版。

开发/正式 Web 仍按 origin 隔离存储，不能把两者挂在同一 origin 下不同 URL 路径就视为数据隔离。桌面 `tauri dev` 使用 localhost，与打包版 origin 也不相同；这两个开发入口不会自动共享浏览器存储。

## 数据与环境边界

2026-09-23：新增版本对比与恢复为新版本，最新本地开发包为 `0.1.0-dev.6`。已构建未签名 Windows NSIS；原生 DOCX 分页渲染仍未验收，未推送或发布。

- 本地知识库、云端知识库独立；但同一客户端数据目录内的账号共享本地库，本地 IndexedDB 原文/向量暂未加密。备份文件加密不等于本地存储加密。
- 构建通道不会自动创建独立服务端数据库。后端开发必须使用专用 `.env`、数据库/Redis/备份目标，不能连线上生产库。当前按用户要求不检查或修改实际部署环境。
- 自动化浏览器/原生验证使用 `.tools` 内独立数据目录，不使用个人 WebView 数据。已运行的服务、凭据、端口不能由 Git 分支自动隔离。
- 本地提交是回滚点，不是发布。测试记录、源码提交、Web/桌面构建及部署状态在 WORK_LOG 分别记载。
