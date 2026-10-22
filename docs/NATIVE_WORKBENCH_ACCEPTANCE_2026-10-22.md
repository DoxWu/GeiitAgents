# 浏览器与 Windows 工作台业务验收（2026-10-22）

本轮修复网页预览的实际脚本执行问题，并使用最终 dev.70 独立 EXE、Windows WebView2 `155.0.4283.62` 与 Chromium 完成合成文档任务验证。用户对 A12 selected-30 的定性人工验收保持通过，不追加推算逐题分数或准确率。本轮业务任务使用模拟模型和合成账号，没有真实模型、邮件或目标数据库请求。

## 实际修复

原 `iframe srcDoc` 会继承主应用的严格 CSP，生成网页虽然可显示内容，内联动画脚本却被拦截。Web 改用 `/web-preview.html` 独立静态响应，Nginx 对该入口单独设置 CSP；桌面注册 `geiit-preview` 协议，只允许获取固定预览 HTML，其他路径和方法返回 404。主应用没有开放内联脚本权限。

预览 iframe 只授予 `allow-scripts`，没有同源、弹窗或表单权限；响应 CSP 另加沙箱与禁止网络连接的约束。父页面仅响应当前预览框架、opaque origin `null` 的就绪消息。模型 HTML 通过消息写入该框架；图片占位符展开前累计预算，超过约 8 百万字符时拒绝预览，避免大量重复素材膨胀内存。

WebView2 会在子框架注入不可重定义的 Tauri 桥接对象，不能用删除对象作为隔离保证。本轮改用自定义 JSON IPC 初始化脚本：仅顶层页面闭包持有 invoke key 并发送原生命令，子框架命令立即走错误回调。保留 Channel、Unicode 和字节数组序列化。该修改影响桌面命令传输，因此另用真实打包程序完成模型列表、文本连接测试和九个流式请求场景，不能仅凭网页预览通过判断 IPC 可用。

## 本次验证

| 验证 | 实际结果与边界 |
| --- | --- |
| 最终前端回归 | **137 文件 / 1303 项通过**；ESLint、TypeScript 通过。Node VM 直接执行最终 IPC 源脚本，**3 项通过**，覆盖主页面序列化、子框架拒绝和脱敏错误。 |
| Rust | 仓库本地工具链运行 `cargo test --locked --bin geiit-workbench`，**22 项全部通过**，含固定预览响应、流式协议、端点和文件整理已有回归。 |
| 构建 | 最终 Web TypeScript/Vite 与 dev.70 Windows TypeScript/Vite/Rust release/NSIS 构建通过；保留两条已有 workflow 导入提示。产物未签名、未安装、未发布。 |
| 浏览器完整任务 | 采用实际生产 app/preview CSP 响应，模拟模型；资料加密保存/载回而无需重开原文件，版本编辑/对比/恢复、取消、重载解锁、DOCX/PPTX/XLS/XLSX 下载解析、公式文本安全、图表 SVG/PNG、网页颜色/布局/六动画示例、图片和 390px 检查通过。 |
| dev.70 完整任务 | 同一业务链在真实 WebView2 和最终 EXE 通过；生成脚本执行，访问父页/localStorage 失败，Tauri 命令被错误回调拒绝，外网和 IPC fetch 被 CSP 阻止。页面异常和外网请求尝试均为 0。 |
| 生产前端 Nginx 镜像 | 当前工作树构建的 Docker 镜像 `sha256:12d1ae10d8cad8571a730e839c048a1a1d6692d9d49c1af5dd800a846df05caf` 中，实际 GET `/`、`/workbench`、`/index.html`、`/runtime-config.js` 和 `/web-preview.html`，核对 app/preview CSP、MIME、no-store、nosniff、runtime config 与 source-map 404。随后以真实 Nginx 响应头运行完整浏览器文档任务，通过，无 JS 错误或外网尝试。Web 模型为合成 mock；不是后端/Redis/数据库联调。 |
| dev.70 原生流式 | 模型目录和一次非流式连接测试通过，**9 个流式请求**覆盖 UTF-8 跨块、并行对话、取消与锁库关闭连接、终止标记、无结束标记 EOF 不持久化、JSON fallback、供应商错误脱敏、加密重载、停止原因和 Markdown 导出；无页面异常。上游为回环合成 HTTP 服务。 |

完整任务中的 Office 产物只做本次下载与结构/内容解析，没有重跑 Word/PowerPoint/Excel COM 原生排版验收；此前 36 页 Word 和 COM 证据按原日期保留。六个动画示例的控件/示例界面有检查，生成页面脚本已执行，但不承诺模型会忠实实现任意动画或设计。

最终报告位于忽略目录：

- 原生完整任务：`.tools/native-document-task-20261022-ipc-final/run-iPt17b/result.json`，含受测 EXE 哈希、WebView2 版本与检查清单。
- 浏览器完整任务：`.tools/document-task-csp-20261022-accepted/result.json`。
- 原生模型流式：`.tools/model-stream-qa/native/native-result.json`，本轮成功重跑结果。
- 构建日志：`.tools/native-preview-20261022/desktop-build-ipc.log`、`web-build-accepted.log`。
- 当前工作树的生产 Nginx HTTP/CSP 检查：`.tools/frontend-preview-qa-20261022/result.json` 和 `browser/result.json`。镜像 SHA 如上，最后已移除本次 QA 镜像及容器。此前首次构建意外把 Rust `target*` 编译目录一并传送（进度达到 2.24 GB），已中断；加入 Docker 忽略规则后重新构建 context 仅 **95.33 MB**，减少约 96%。CI 加入该排除项的回归。本地不保留下载的 Node/Nginx base 镜像标签、测试容器或最终镜像；没有执行全局 prune。原有三张镜像和卷未变。

中途曾复现 srcdoc 与继承 CSP 导致脚本不执行；Windows 自定义协议路径编码错误已修正。首次 IPC 方案未能删除只读桥接对象，改为子框架拒绝命令后重建并完整通过。流式脚本先因旧提示文字、随后因持久消息与尚未移除的流式消息短暂重复而失败；更新提示断言，并等待流式节点消失后检查持久消息，最终重跑通过。Node 测试最初命名为 `.test.mjs` 被 Vitest 误收集而失败，改为单独 `native-ipc-check.mjs` 后全量和 Node 测试均通过。中间失败不计为验收成功。

## 最终产物与复现

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `src-tauri/target-dev/release/geiit-workbench.exe` | 15,456,256 | `9E7C504B7D6BF0548A264139885A4071F72D0A183527A6BFD0E86D643BE45124` |
| `src-tauri/target-dev/release/bundle/nsis/GeiIt Agents Dev_0.1.0-dev.70_x64-setup.exe` | 12,732,442 | `A887909504FFF6F2907F6F7A0EEABB37CF871275D1B3BA198959A65F62F910D6` |

从 `kb_qa_system/frontend` 运行，Web 模式另需已构建的本机 Vite preview 服务：

```powershell
node scripts/verify-document-task.mjs --native-exe src-tauri/target-dev/release/geiit-workbench.exe --output ../../.tools/native-document-task-qa
node scripts/verify-native-stream.mjs
node --test scripts/native-ipc-check.mjs
$env:DOCUMENT_TASK_BASE_URL='http://127.0.0.1:1424'
node scripts/verify-document-task.mjs --output ../../.tools/document-task-csp-qa
```

脚本为本轮新建隔离 profile，不读取用户实际密钥库。用户日常安装仍为 dev.68；dev.69 安装/升级/回退实验是另一次历史验收，没有因 dev.70 构建而重复执行。最终宿主及 WebView2 测试进程均退出，本轮启动的 `127.0.0.1:1424` 预览进程已按精确 PID 和命令核对后停止，端口关闭。Docker 服务保持 Stopped、引擎管道不存在，无本轮新建镜像/容器或待删资源，没有全局 prune。

## 仍开放

本轮运行了前端生产 Docker 镜像和 HTTP/CSP/浏览器验收，但没有运行后端全量。最新成功 GitHub CI `39723490636` 对应此前 `1802bdb`，不能覆盖新改动；本地 Nginx 通过不替代新 SHA 的 CI Trivy/Redis/镜像清理结果。预览/IPC 修复为 `516df4b`，Nginx CI 门禁、95 MB Docker context 排除及镜像检查代码为 `3e328bb`，本机报告/矩阵/工作记录变更待单独文档提交。普通 Git smart HTTP 对 `github.com:443` 超时，API 仍可访问并有 push scope；之后核实 SHA/祖先关系再走 non-force fast-forward，旧 main 未变。真实目标部署恢复、卷/Secret/队列/RPO/RTO/回滚、目标向量库迁移、目标邮件链及部署隐私事实仍待对应环境。实际 8 GB、Safari/移动真机、物理断电/磁盘满、安装器中断、独有格式降级与签名/正式更新、更多复杂业务模板、分发许可及无修复容器漏洞继续跟踪。
