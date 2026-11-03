# 桌面本机 MCP 验收记录

日期：2026-11-03
版本：Windows x64 桌面开发版 `0.1.0-dev.80`
验收方式：独立 WebView2 用户数据目录，运行本地构建的 dev.80 桌面程序；MCP 包安装与工具调用通过实际界面及桌面 IPC 执行。

## 验收结果

最终运行 12 项检查，全部通过。原始结果为 `.tools/local-mcp-20261102/run-GVvpbS/result.json`，同目录保留深浅色桌面/移动截图。

1. 界面调用桌面命令安装精确版本 npm 包 `@modelcontextprotocol/server-filesystem@2.1.0`。
2. 从本机 stdio 服务发现工具，选择工具并加密保存。
3. 智能体工作流在合成模型回复下完成授权、调用 npm stdio 工具并结束。
4. 每次本机工具调用都要求匹配当前任务的授权和环境。
5. 锁定密钥库后撤销已连接的本机 MCP 工具。
6. 界面通过阿里云 PyPI 镜像 `https://mirrors.aliyun.com/pypi/simple` 安装 `mcp-server-time==2026.10.28`，并成功启动、发现和调用 Python stdio 工具。
7. 并发安装请求明确返回忙碌；取消安装会移除暂存目录。
8. 深浅主题下，390px 与 1280px 视口的提示气泡均在视口内可读。
9. 提示气泡支持键盘聚焦、鼠标悬停和 Escape 关闭。
10. 网页预览 iframe 不能调用本机安装或启动命令。
11. 测试包移除后，原有安装包清单保持不变。
12. 仅在安装互斥锁空闲时，包清单回收没有清单的中断暂存目录。

除原生验收外，前端全量 **153 个测试文件 / 1388 项通过**；Rust **36 项**、Node IPC/权限 **4 项**通过，`cargo check`、TypeScript、ESLint 和本次新增 MCP Rust 文件的 `rustfmt --check` 通过。全 crate `cargo fmt --check` 仍报告本轮未修改的既有 Rust 文件格式差异，没有批量重排无关文件。dev.80 构建过程中的前端类型检查和生产构建通过。

## 产物

- EXE：`kb_qa_system/frontend/src-tauri/target-dev/release/geiit-workbench.exe`，17,115,648 字节，SHA-256 `DA4A1AE8E79C3A9D8CF4F80D045D3C7E4687F6D77C12FE9823CA676A66B89913`。
- NSIS：`kb_qa_system/frontend/src-tauri/target-dev/release/bundle/nsis/GeiIt Agents Dev_0.1.0-dev.80_x64-setup.exe`，14,258,677 字节，SHA-256 `089736CDED1239CBD3E1B0CC2949CAFD5B1CF3CBA6DDBA3CBB6FC17CC7E19709`。

产物是未签名的本地构建，仅用于验收；没有安装到用户日常环境、发布或部署。

## 清理与边界

验收使用两个合成模型回复，真实模型请求为 **0**。没有读取 `.env` 或真实凭据，没有连接业务数据库、发送邮件或启动 Docker。安装的验收包和暂存目录已清理，原有包清单保持不变，隔离 MCP 包目录为空；验收宿主已退出。测试 JSON、截图和日志保留于忽略目录 `.tools/local-mcp-20261102/`。

Python 包安装实际使用用户提供的阿里云 PyPI 镜像；界面同时保留默认 PyPI 选项。npm 使用 npm 官方 registry。包版本必须精确指定；安装目录独立管理，Python 使用独立 venv 且只安装 wheel，npm 禁用生命周期脚本。源由界面固定选择，不接受任意 URL。

本机 MCP 进程以当前 Windows 用户权限运行，**不构成沙箱**，仍可能访问该用户可访问的文件、网络和服务。精确版本和依赖安装限制不能证明包可信。需要编译或安装脚本、依赖额外运行环境，或要求 sampling、roots、交互式授权等 MCP 能力的服务仍可能无法使用。此验收不代表任意第三方 MCP 包或非 Windows 平台兼容。

本机 MCP 能力保存在当前加密密钥库中，不发布到共有/组织仓库；备份默认不包含其参数和环境变量。使用说明见[桌面本机 MCP](LOCAL_MCP_DESKTOP.md)。本地构建和验收不代表远程 CI、签名、线上部署或其他机器的安装结果。
