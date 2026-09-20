# 客户端轻量向量模型评估（2026-09-17）

2026-09-19 决策更新：客户端本地知识库默认采用 `intfloat/multilingual-e5-small` 的 Xenova ONNX 转换版（仓库 `Xenova/multilingual-e5-small`），取代此前 BGE 优先候选的建议。仅当终端用户明确启用本地知识库时添加/下载，允许用户单独配置其他兼容向量模型。云端知识库继续使用现有服务端模型，配置、文档和索引与客户端本地库分开。

当前完成在线资料核验与实施规格，尚未实现客户端下载/推理/索引，也未在低配机器上做性能与检索质量测试。模型不随基础安装包默认捆绑，不能承诺“绝大多数设备”的速度。详见 [实施约定](LOCAL_KNOWLEDGE_BASE_SPEC.md) 和 [当前工作记录](WORK_LOG.md)。

## 候选与体积

| 模型 | 适用场景 | 向量维度 / 输入上限 | 已核验的单个量化 ONNX 文件 |
| --- | --- | --- | --- |
| intfloat/multilingual-e5-small，Xenova ONNX 转换版 | 已确定为本地库默认，中英及多语言 | 384 维 / 512 tokens | model_int8.onnx：118,054,593 字节，约 118 MB（112.6 MiB） |
| BAAI/bge-small-zh-v1.5，Xenova ONNX 转换版 | 中文优先，可选自定义候选 | 512 维 / 512 tokens | model_int8.onnx：23,903,394 字节，约 23.9 MB（22.8 MiB） |

两者原模型卡均标为 MIT。上述只是权重文件，不含 tokenizer、配置、ONNX Runtime/WASM 文件、缓存与向量索引，也不是推理内存占用。生产发布应固定模型版本和文件哈希，核对转换版本许可证与附带声明，避免每次启动拉取浮动 main。

## 本应用的建议接入方式

1. 默认不装大体积 PyTorch/Python 环境。首次启用“本地知识库”再下载量化 ONNX、tokenizer 和运行时，显示进度、可取消、可删除缓存。
2. 优先以 Transformers.js + ONNX Runtime Web 在 Worker 中验证 CPU/WASM 路径；WebGPU 是可选加速，不作为依赖。有原生性能需求再考虑 Tauri Rust 调用 ONNX Runtime。Windows WebView2 的具体 WASM/WebGPU 支持需要实测。
3. 索引任务单独排队，小批量、可暂停/恢复、文件未变不重复计算，避免模型推理阻塞聊天和 UI。增量处理文档，限制最大文件与并发。
4. 本地保存分块、文本元数据和向量（例如 SQLite + sqlite-vec，或先小规模余弦搜索）。默认 E5 的 384 维 float32 单向量 1,536 字节，1 万条原始向量约 15.36 MB；另需文本、索引与数据库开销。具体存储方案尚未确定。
5. 按模型 tokenizer 切分，不能把 512 tokens 当成 512 字。BGE 使用 CLS pooling 和 L2 归一化，检索 query 按模型卡添加中文指令；E5 使用 attention-mask-aware mean pooling、L2 归一化及 query:/passage: 前缀。不要统一用一套默认 pooling。
6. 索引记录模型 ID/版本、量化版本、维度、pooling、归一化及切块规则。文档向量和查询必须处于同一模型空间；切换模型必须重建或并存独立本地索引。云端模型和索引不受本地设置影响，不需要因启用本地库而重建。

本地向量只解决检索的一部分。要完全离线，还需本地文档解析/切块/索引/检索，以及本地生成模型；调用云端大模型回答时，相关文档片段仍会随请求发送到云端。扫描 PDF 的 OCR 是另一项开销。当前服务端 pgvector 知识库不会因为安装一个本地 embedding 模型就自动离线。

建议以普通 8 GB 内存、无独显机器做验收：冷启动下载大小、峰值内存、每百段索引耗时、查询 P50/P95 延迟、中英业务题库 Recall@5、索引中断续传与 UI 响应。本地关键词检索可作为后续降级选项；本地模型失败不自动上传文件或调用云端向量服务。用户可另外选择使用已有云端知识库。

## 核验来源

- [BGE 原模型与使用说明](https://huggingface.co/BAAI/bge-small-zh-v1.5)
- [BGE 配置：512 维、4 层、512 tokens](https://huggingface.co/BAAI/bge-small-zh-v1.5/blob/main/config.json)
- [BGE ONNX 文件](https://huggingface.co/Xenova/bge-small-zh-v1.5/tree/main/onnx)
- [BGE 文件大小 API](https://huggingface.co/api/models/Xenova/bge-small-zh-v1.5?blobs=true)
- [E5 原模型与前缀/pooling 说明](https://huggingface.co/intfloat/multilingual-e5-small)
- [E5 ONNX 文件](https://huggingface.co/Xenova/multilingual-e5-small/tree/main/onnx)
- [E5 文件大小 API](https://huggingface.co/api/models/Xenova/multilingual-e5-small?blobs=true)
- 后续实现参考：[Transformers.js](https://github.com/huggingface/transformers.js)、[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/)、[sqlite-vec](https://github.com/asg017/sqlite-vec)。
