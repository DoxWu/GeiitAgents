# SVG/GIF 生图接入记录（2026-11-05）

OpenAI官方资料确认GPT Image 2.6支持SVG和动画GIF，具体模型为 `gpt-image-2.6-sunburst`、`gpt-image-2.6-flare`。这不是对泛称 `gpt-image-2.6` 模型ID的确认，也不证明当前账号已经获得使用权限。

- [官方生图指南](https://developers.openai.com/api/docs/guides/image-generation)：SVG/GIF章节及请求参数。
- [Sunburst模型页](https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst)。
- [Flare模型页](https://developers.openai.com/api/docs/models/gpt-image-2.6-flare)。

## 实现范围

独立图片工作室增加普通图片/SVG/GIF格式选择。浏览器直连、桌面Rust直连、自购API服务端转发与服务端配置路径都传递格式；GIF另传 `frame_count`、`frame_duration_ms`，可用 `size: auto`。SVG/GIF使用 `/images/generations`、`n: 1`；不进入参考图编辑接口，不静默忽略已有参考图。GPT Image请求省略不适用的旧 `response_format` 字段，保持该系列原生Base64返回；其他兼容服务维持既有协议。不发送流式、压缩或提示重写参数。

GIF模板描述主体动作、方向/速度/镜头、首尾衔接和场景稳定性，避免生成分镜拼图。默认9帧、200毫秒、自动帧尺寸，允许2–64帧、20–2000毫秒。指南没有给出本次可引用的固定总像素预算，因此没有凭空增加总像素硬上限；实际尺寸与帧数组合由供应商接受范围决定。单次叙事是提示词约束，不承诺文件只播放一次。

生成结果使用独立类型，保持上传/视觉/参考图输入仅允许PNG/JPEG/WebP。GIF保留原始字节；SVG检查静态XML和本地片段引用，允许常规样式、渐变和滤镜，拒绝脚本、事件属性、外部引用、嵌入位图及活动内容。使用 `<img>` 隔离预览，下载不会内联到应用DOM或转为PNG。生成结果仍使用64 MiB单图、88 MiB响应、128 MiB全库图片预算；草稿、手工最终提示词和动画设置纳入既有加密任务、备份与恢复。PPT/网页内嵌生图保持普通图片模式。

## 本次验证与边界

- 前端完整套件158文件/1431项通过；之后补齐静态CSS接受、数字暂存和任务切换回归，最终相关5文件/45项通过。没有在最后两项补充后重跑完整套件。
- 后端隔离生图/自购API/参考图/新格式78项通过，含合成HTTP传参和原字节返回；没有连接业务数据库或真实供应商。
- Rust39项通过，含SVG/GIF参数与参考图格式隔离；此次没有构建新桌面EXE/安装包或重跑WebView2。
- TypeScript生产构建、ESLint、修改范围Ruff检查及Rust单文件格式检查通过。生产构建保留既有静态/动态重复导入提示。
- `frontend/scripts/verify-image-formats.mjs` 使用合成SVG和4帧GIF，浏览器完成格式选择→模板参数→手工最终提示词→请求→解码预览→原文件下载→任务切换→锁库恢复→再次下载。两次HTTP模型请求均为拦截的合成响应，真实供应商请求0；三个下载文件均与原始字节相同。
- 390/1280px、深浅主题共8组布局检查通过，0页面异常、0页面级横向溢出。报告和截图位于忽略目录 `.tools/image-formats-20261105/`。测试Vite与浏览器已退出，未启动Docker。

本次遵循用户已确认的协议/接收验收标准，没有收费调用指定GPT Image模型，也没有验证供应商动画质量、账号权限、最大帧数与尺寸组合。模型服务、CDN跨域条件及视觉遵循能力仍由实际连接决定；未安装、发布或部署。
