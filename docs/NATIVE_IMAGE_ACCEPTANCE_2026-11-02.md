# 桌面生图立即失败修复与验收（2026-11-02）

用户使用模型连接中的自购 API/本机直连，点击生图后立即收到通用失败提示。旧 dev.72 的真实 WebView2 调用返回 `Command generate_local_image not allowed by ACL`，合成模型服务收到 **0 次**请求。`generate_local_image` 已在 Rust 注册，但遗漏在主窗口启用的 `allow-local-model` 命令列表中。前端又将该权限错误替换成了模型名称/密钥/接口兼容性的通用提示。

本轮将生图命令加入既有权限，不扩大远程页面能力或子框架权限；前端安全区分权限拒绝、旧宿主缺少命令和并发上限。上一轮修复了阿里云临时图片 URL 响应，但只做 Rust 内 HTTP 测试和后端供应商联调，遗漏真实桌面入口，不能视为此前桌面生图可用的证据。

## 本次结果

| 检查 | 本次结果 |
| --- | --- |
| 旧 dev.72 基线 | 真实 WebView2 复现 ACL 拒绝；模型 HTTP 请求数 0。 |
| dev.73 原生 URL 路径 | 实际 WebView2 → Tauri IPC/ACL → 本机合成图像 API → 图片 URL 下载成功。API 收到合成密钥，图片 GET 不携带密钥；合成 HTTP 服务没有 CORS 放行头，客户端通过 Rust 完成请求。 |
| 实际界面 | 新建隔离密钥库、保存合成模型连接，点击图片生成按钮，显示可解码 PNG（检查 naturalWidth），无页面异常。 |
| 预览隔离 | 实际沙箱预览框架尝试调用相同命令，返回 `Desktop commands are unavailable in previews`，没有新增模型请求。 |
| 阿里云直连 | `.env` 主生图配置，`direct: true`，经最终 dev.73 WebView2 的同一原生命令完成一次真实合成请求；`qwen-image-3.0-pro` 返回有效 PNG，443,476 字节。凭据仅在验收进程和页面内存中使用，没有写入隔离密钥库、日志或报告；真实生成图片没有写盘。 |
| 回归 | 前端 workbenchModel **22 passed**；Node IPC/权限 **4 passed**（Windows/非 Windows 已注册命令均有启用权限）；Rust **25 passed**；TypeScript、ESLint、脚本语法与 diff 检查通过。 |
| 构建 | Windows dev.73 TypeScript/Vite/Rust release/NSIS 构建完成，保留已有动态/静态导入提示。未安装、签名、发布或部署。 |

上述合成 UI 图片只用于证明调用和展示链路，不评价图片效果。真实阿里云调用通过主页面直接触发与 UI 相同的原生命令，未读取或使用用户密钥库中的连接。前端/后端全量、Office 排版、数据库与线上服务未在本轮重跑；10/29 后端生图 37 项结果按原日期保留。

## 产物与证据

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `kb_qa_system/frontend/src-tauri/target-dev/release/geiit-workbench.exe` | 16,906,752 | `E42169492BFBA86D351AB0F022D39465E6816B8EB9AD0039BD54213F1532132B` |
| `kb_qa_system/frontend/src-tauri/target-dev/release/bundle/nsis/GeiIt Agents Dev_0.1.0-dev.73_x64-setup.exe` | 14,179,632 | `7B2AD69F606EE59F392361DBE91C4F4D75DEFAAD28D841994DA0D389AA6730BE` |

忽略目录 `.tools/native-image-20261102/run-OjN6nF/result.json` 保存 dev.72 基线，`run-uoq0HP/result.json` 保存最终 dev.73 结果和二进制哈希，同目录 `native-image.png` 为合成界面截图。验收结束后仅按本轮宿主 PID 终止宿主及 WebView2 子树；合成 HTTP 服务关闭，没有本轮原生进程残留。用户原有安装文件和密钥库未改动，没有使用 Docker、邮件或目标数据库。

在 `kb_qa_system/frontend` 中可运行：

```powershell
node scripts/verify-native-image.mjs
node --test scripts/native-ipc-check.mjs
```

只有明确需要付费供应商验收时，才加 `--provider-env ../backend/.env`，该选项额外执行一次真实请求。复现旧版拒绝可指定旧 EXE 并加 `--expect-denied`；默认脚本只访问本机合成模型，使用全新 WebView2 profile。

浏览器直接请求供应商图片 URL 仍受 CDN 的 CORS 约束；此次修复并验证的是桌面原生路径。安装 dev.73 后应退出旧进程再启动更新后的程序，旧 dev.72 进程中的权限不会因替换前端文件而改变。
