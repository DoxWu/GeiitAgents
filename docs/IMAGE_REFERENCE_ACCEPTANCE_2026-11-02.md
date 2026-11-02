# 生图参考原图传输修复与验收

日期：2026-11-02。范围为正式应用代码和本地验证，不代表安装或线上部署。

## 根因与实现

dev.74 的参考图只在点击“视觉整理”时进入视觉模型。图片生成按钮只发送提示词和尺寸，没有把参考原图交给图片生成模型。上传成功、预览正常并不等于生图请求携带原图。

本次贯通 ImageStudio → ImageGenerator → store → 桌面原生命令/浏览器直连/BYOK转发/服务端配置生图的参考图参数。每次最多2张，保持上传顺序；只接受内容签名和MIME一致的PNG/JPEG/WebP Base64，每张最多1,500,000字节，不接收由服务端抓取的任意输入图片URL。接口请求体限制从64 KiB调整为5 MiB，容纳两张Base64图片，仍逐块执行上限；既有Nginx 50 MiB上限无需调整。

- 没有参考图：保留原有 `/images/generations` 文字生图请求。
- 官方百炼域名（原DashScope域名、北京/新加坡业务空间专属域名）且有参考图：同一配置来源域名的 `/api/v1/services/aigc/multimodal-generation/generation`，通过 `input.messages[0].content[].image` 发送原图，文字位于同一消息。宽高转换为 `宽*高`，不修改用户指定的模型名。
- 其他兼容端点且有参考图：`/images/edits` 标准multipart文件上传；单图字段为 `image`，多图为 `image[]`。不会把原图只作为未识别的JSON字段附在文生图请求中。
- 兼容OpenAI响应和DashScope `output.choices[].message.content[].image`；保留结果URL下载的HTTPS、公网、限额、禁止重定向及不转发模型密钥等限制。BYOK继续固定解析后的公网IP并保留Host/TLS SNI。
- 服务端主备切换保持每张参考图，不会通过丢弃参考图重试文字生图。错误只映射固定错误码，区分认证、速率、免费额度限制与不支持编辑，不显示供应商任意响应文本。
- 界面说明直接发送的原图数量和图1/图2顺序；云端逐次授权覆盖提示词和原图。参考图改变后取消旧请求并撤销授权，迟到结果仍受任务/账号隔离保护。视觉整理为可选步骤。

## 本次验证

| 验证 | 结果 |
| --- | --- |
| 前端相关组合 | 11文件/141项通过；涵盖三条连接路径的原图参数、浏览器multipart实际文件字节、DashScope请求/结果、失败不丢图重试、更换参考图撤销授权/取消、图片任务/加密库/备份/构图回归。补充官方新加坡域名后所属10项再通过，不重复累加。 |
| 后端隔离 | 60项通过：既有私有模型与服务端生图、12项参考图回归、实际路由验证。核对BYOK公网IP固定、Host/SNI、单图/双图文件字节和顺序、主备协议切换保留图片、认证和no-store、超64 KiB有效请求/5 MiB限额/错误不回显输入。邮件关闭，DB/Redis指向不可连接的隔离地址。 |
| Rust | 30项通过，包括multipart原图字节、同源DashScope JSON和结果、非法/超限参考图、固定错误映射及既有原生功能。 |
| IPC/权限 | 4项通过，主窗口命令与权限一致，预览子框架拒绝原生命令。 |
| 静态检查 | TypeScript、ESLint、Python关键错误规则、单文件rustfmt、验收脚本语法及diff检查通过。构建保留已有静态/动态混合导入chunk提示。 |
| 最终安装包/原生界面 | Windows dev.75 EXE/NSIS构建完成。真实WebView2中20项合成检查通过、12次合成HTTP请求、页面异常0；实际按钮上传原图并生成，接收端逐字节核对PNG，双图multipart/不支持编辑不重试、任务隔离/恢复/取消、390–1600px深浅主题/横竖构图和PPT 16:9回归通过。已查看参考图发送说明、桌面暗色、移动浅色截图。 |

没有重跑前后端全量测试、目标数据库、Office原生排版、线上部署或真实用户图片效果评估。参考图和文字布局约束不等于蒙版或逐像素控制。

## 真实供应商限制

使用项目`.env`主生图配置和合成的512×512红色方块作输入，官方百炼原生编辑接口返回HTTP 403、固定错误码 `AllocationQuota.FreeTierOnly`。同源OpenAI兼容 `/images/edits` 返回404，不支持以该路径替代原生编辑；探测时对该404共请求两次，其中第一次在解析非JSON错误体时失败。探测没有成功生成图片，不能据此认定当前 `qwen-image-3.0-pro` 已支持或通过图片编辑验收。

需要在百炼控制台检查对应业务空间/模型的免费额度与“仅使用免费额度”设置。是否允许付费调用由用户决定；本次没有自动更改供应商账户、`.env`、模型名或用户保存的连接。解除限制后还需确认所选模型支持编辑接口；如果需要独立的编辑模型，可以在模型连接中新建对应连接后选择它。

最终dev.75通过WebView2原生命令另发送一次512×512合成红色方块，明确携带1张参考原图；仍返回固定 `IMAGE_EDIT_QUOTA`（对应上述供应商免费额度错误）。本次真实编辑未通过，报告 `liveProvider.ok=false`；该失败不计入20项合成本地检查。原图进入图片编辑请求不代表供应商已允许生成，也没有对真实编辑保真度作评价。没有继续重复真实计费探测。

参考接口文档：[千问图片编辑](https://help.aliyun.com/zh/model-studio/qwen-image-edit-api)、[千问图片生成](https://help.aliyun.com/zh/model-studio/qwen-image-api)。此次读取到的编辑文档参数表主要列出2.0系列，页面另链接3.0编辑体验，不用未验证的模型名替换用户配置。

## 复现与产物

前端目录运行合成验收：

```powershell
node scripts/verify-native-image.mjs --output ../../.tools/image-reference-20261102/native
```

若要额外运行一次真实供应商参考图调用，显式加 `--provider-reference-env ../backend/.env`。脚本仅创建全新测试密钥库，真实Key与合成输入/真实结果只留在进程内存；如果返回已知免费额度限制，报告把 `liveProvider.ok=false` 与合成检查通过分开记录。默认不访问真实供应商。

| 最终dev.75产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `kb_qa_system/frontend/src-tauri/target-dev/release/geiit-workbench.exe` | 16,926,208 | `066F6A8DFE2DA3F632CB77D34BAF95CBCFE2AB3A00A0BB4FDE0819F3023455C7` |
| `kb_qa_system/frontend/src-tauri/target-dev/release/bundle/nsis/GeiIt Agents Dev_0.1.0-dev.75_x64-setup.exe` | 14,187,692 | `51926EA55DBBABFB86E0D92C879F1A9C5CCA2BE8307A17B9BED038C8FB7065CD` |

带一次真实供应商尝试的原生报告在忽略目录`.tools/image-reference-20261102/native/run-6LZ9Hg/result.json`。补充参考图发送说明截图后，仅重跑合成验收，最终报告在`final-native/run-7RjNni/result.json`；两次EXE哈希一致，不重复累加检查数或真实供应商调用数。中间两次候选构建未作为最终产物交付；最终包包含空HTTP错误体提示和官方业务空间域名识别修正。

本轮测试宿主/WebView2子树与HTTP服务均退出，仅保留用户原有`C:\testKB\GeiIt Agents Dev\geiit-workbench.exe`，未读取或修改用户实际密钥库。没有启动Docker、发送邮件、连接目标数据库、安装、签名、发布或线上部署。
