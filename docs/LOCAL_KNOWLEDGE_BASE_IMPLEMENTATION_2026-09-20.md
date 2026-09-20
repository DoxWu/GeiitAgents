# 本地知识库首版实现与验证

日期：2026-09-20。状态：代码、浏览器和 Windows 本地验证、Windows 验证包已完成；未部署线上。此文描述已实现范围，不代表完整办公助手或大规模本地 RAG 已完成。

## 使用方式

工作台 → 本地知识库（`/local-knowledge`）→ 启用模型 → 选择 Markdown/TXT → 本地检索。无需登录云端账号或解锁聊天密钥库。首次下载需要联网；关闭模型或重新进入页面后必须主动再次启用。此页只显示来源片段，不调用生成模型、不上传查询/文档/向量。云端知识库仍是 `/documents`，不改变其模型配置。

首版限制：UTF-8 文件，单文件 2 MiB，最多 100 文件、10 MiB 原文、2000 个片段。多个文件一次导入全部成功后才保存；同名文件可以分别导入，不自动覆盖。删除文件同步删除对应向量。失败/取消保留上一次完成的索引；本次未提交的文件需重新导入。

## 运行时与固定资源

- `@huggingface/transformers` 固定 3.8.1；其 ONNX Runtime Web 为 `1.22.0-dev.20250409-89f8206ba4`，锁文件固定依赖。
- 原生 ES Worker，CPU/WASM 单线程，不要求 WebGPU、跨域隔离、Python 或 PyTorch。只有明确启用才构造 Worker；路由访问不会加载 Worker、WASM 或模型。
- 默认仓库 `Xenova/multilingual-e5-small`，commit `761b726dd34fb83930e26aab4e9ac3899aa1fa78`，q8 实际使用 `onnx/model_quantized.onnx`，**不是 `model_int8.onnx`**。
- 384 维、最大 512 tokens（含特殊 token 与前缀）、`query: ` / `passage: `、attention-mask mean pooling、L2 归一化。初始化分别探测查询/文档编码，验证形状、维度和有限数值。配置上限不得超过 tokenizer 上限。
- 分块按真实 tokenizer 计算前缀后的长度；连续 Unicode 字符分段，保存准确 UTF-16 起止位置，不通过截断或 decode/re-encode 丢弃原文。首版没有片段重叠；更复杂的段落切分仍待评估。

| 默认文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| config.json | 658 | cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1 |
| tokenizer_config.json | 443 | a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b |
| tokenizer.json | 17,082,730 | 0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39 |
| onnx/model_quantized.onnx | 118,308,185 | f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193 |

合计 **135,392,016 字节，约 129.1 MiB**；不含运行时、HTTP 开销、内存和文档索引。默认文件逐个校验，完整文件才写入独立 Cache Storage；每次重新启用检查缓存哈希，损坏时拒绝加载并移除坏文件。取消会终止 Worker，保留已完成文件；不支持单文件 HTTP Range 续传。

推理 Worker JS 约 0.883 MB、运行时 mjs 约 44 KB、WASM 21.596 MB 随应用分离打包，以支持桌面断网重载；**模型权重不在安装包中**。Web 端这些独立资源同样在启用时才请求。未实现把运行时本身做成独立可安装插件。Nginx 源配置补充 mjs/WASM MIME、WASM gzip 和模型域名 CSP；Tauri 只增加 `wasm-unsafe-eval` 与同源 Worker，没有开启普通 `unsafe-eval`。

## 独立存储与自定义模型

- IndexedDB：`geiit-local-knowledge-v1`，单个 `active` 快照含配置、原文、片段和向量。**当前未加密**，与聊天 AES-GCM 密钥库不同；同一客户端数据目录/浏览器 origin 的账号共享此本地库。不同 Web origin、浏览器配置与桌面端之间不自动同步。
- Cache Storage：`geiit-local-models-v1`。清除模型缓存和删除文档索引是两个独立操作；启用时持有 Web Lock，其他窗口不能同时启用/删除缓存。完整默认缓存支持离线重新初始化。
- 配置、runtime、分块规则组成指纹。变更模型配置后完整重建，成功时以 IndexedDB 事务和 revision 比较交换激活；失败、空间不足或取消保留旧索引。相同指纹的已有文档可复用片段，新增文件增量计算。
- 每次启用即保存独立配置（空库也保存）；禁用只结束 Worker，不删除文档。浏览器持久存储申请仅 best effort，不能代替备份；原文件应保留。
- 高级 JSON 配置仅支持公开 Hugging Face ONNX 仓库：仓库 ID、40 位 commit、64 位权重 SHA-256、q8/fp32、维度 1–2048、最大 tokens 16–512、mean/cls、查询/文档前缀。L2 固定启用，单资源上限 300 MiB，权重单文件。自定义 metadata 固定 commit，但暂不要求其独立 SHA 清单；不执行远程模型脚本。
- 首版未支持私有仓库凭据、任意下载 URL、本地文件模型包、Ollama embedding、多分片/外置 ONNX 权重。兼容性探测不能自动判断用户是否填对语义前缀；其他架构仍须逐一评估。

## 本次验证

1. Vitest **47 项通过**：26 项新增本地库测试（分块/指纹/非法配置/向量/资源哈希/离线缓存/配额/原子存储/取消/页面 opt-in 和重建），以及工作台与备份管理页面相关回归 21 项。没有重跑后端测试或前端全量测试。
2. TypeScript、Web/desktop Vite 生产构建、相关源码 ESLint、`git diff --check` 通过。
3. `scripts/verify-local-knowledge.mjs`：真实 Chromium/E5/CPU/WASM，套用 Nginx 源配置中的 CSP；未启用无模型请求，中英 3 文件实际导入、来源排序、索引重载、外网屏蔽后重新加载缓存、多窗口互斥、长文档中途取消保留原索引；1200px/390px 截图检查无横向溢出；未请求云端业务 API。Nginx 容器本身未启动，本次 MIME 配置未在容器实测。
4. `scripts/verify-local-knowledge-desktop.mjs`：实际 **Windows release exe / WebView2**，独立测试数据目录，真实下载、导入/检索；浏览器网络设为 offline 后刷新完整页面、再次启用缓存模型并检索成功，未请求云端业务 API。

| 本机一次样本 | 耗时 |
| --- | ---: |
| Chromium 清空模型缓存后首次启用（含联网下载） | 28,298 ms |
| Chromium 3 个短文档索引（含 UI/存储） | 217 ms |
| Chromium 中文查询（含 UI） | 81 ms |
| Chromium 外网屏蔽后缓存启用 | 2,372 ms |
| Windows WebView2 首次启用（含联网下载） | 25,708 ms |
| Windows WebView2 全网 offline + 页面刷新后缓存启用 | 1,889 ms |

这些是当前开发机、小语料、单次自动化流程的观测值，**不是**低配 8 GB 验收、P50/P95、吞吐、峰值内存或检索质量基准。证据位于 `.tools/local-knowledge-qa/`：`metrics.json`、`native-metrics.json`、桌面/窄屏/原生截图；这些本机临时产物不提交版本库。

## 构建产物与下一步

2026-09-20 重新构建了 Windows 未签名验证包（版本仍为开发版本 0.1.0），包含本地知识库与此前管理界面：

- `kb_qa_system/frontend/src-tauri/target/release/geiit-workbench.exe`：9,777,152 字节。
- `kb_qa_system/frontend/src-tauri/target/release/bundle/nsis/GeiIt Workbench_0.1.0_x64-setup.exe`：7,137,002 字节。

大小不含系统 WebView2 和按需模型。未做安装/卸载向导实测、签名或发布。构建仍沿用开发 `.env.desktop` 的本机后端地址；云端功能发布时需要对应服务端与地址配置。没有变更线上部署、创建外部备份数据库或发送邮件。

后续优先：低配/大语料性能和 Recall@5；更友好的模型表单/预设；知识库导出备份与可选加密；本地检索片段经明确授权后交给独立生成模型。其他待做：PDF/Office 解析、分段重叠、向量索引优化、索引任务断点续建、Web 离线应用壳、下载镜像可达性、多库管理。现有 Web 页面已打开时缓存检索可用；尚无 PWA/service worker，不能承诺 Web 网站在离线时从关闭状态首次打开。

随后推进办公任务 TaskRun/ToolRun/Artifact、文档生成/转换、笔记待办与邮件调度、可视化工作流。备份恢复接口按上一批实现保留，本轮未修改或重新验证服务端。
