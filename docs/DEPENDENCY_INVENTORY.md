# 依赖审计与许可证清单

CI 的 `dependency-sbom-and-licenses` artifact 保存本次运行解析得到的依赖，不代表当前线上镜像或用户已安装版本。前端清单只含生产 npm 依赖；Python 清单覆盖 runtime、optional ML 和测试 requirements 的解析结果；Rust 清单面向 Windows x64 桌面依赖。它们的范围不同，不能简单相加当成生产软件包总数。

- `frontend-production.cdx.json`：由 npm 锁文件生成的 CycloneDX，包含包标识与许可证元数据。
- `python-dependencies.cdx.json`：先由 pip-audit/OSV 解析并审计，随后按精确名称/版本向 PyPI JSON 查询发布者元数据，补充 PURL、可用许可证声明及元数据来源。原有 `bom-ref`、依赖关系和漏洞引用保留。
- `python-licenses.json`：同一 Python 集合的完整发布者 `license_expression`、旧 `license` 字段和 License classifiers，附精确版本 PyPI URL、响应 SHA-256 与采集时间。缺声明的包列入 `unknown_licenses`；不能将“文件已生成”描述成“许可证已全部审查”。
- `rust-dependencies.cdx.json`：cargo-cyclonedx 基于 Windows 目标生成的组件与许可证清单。

Python 优先原样使用发布者 SPDX 表达式，其次保留短许可证名称或具体 classifier。通用的 `License :: OSI Approved` 无具体许可证，不推测为 MIT/BSD；长许可证正文保存在 sidecar，避免把整段正文当作 SBOM 的许可证名称。无法取到精确版本元数据、版本不匹配或网络错误时该步骤失败，不发布虚假成功的完整清单；不安装/执行待查包，也不自动接受许可条款。

这些是上游声明和取证入口，不能替代审阅分发文件中的 LICENSE/NOTICE、双许可证选择、传递依赖义务或法律判断。未知项、长文本、自定义条款和重新分发义务由发布者在交付前复核。PyPI 元数据摘要用于记录本次响应，不是 wheel/sdist 内容校验；需要交付证明时应另行固定实际构建 artifact 的哈希与许可证文本。

复现 Python 清单（Python 3.11+、`httpx` 和 `packaging`，输入是本次 pip-audit 的 JSON）：

```sh
python .github/scripts/enrich_python_sbom.py \
  --input python-dependencies.cdx.json \
  --output python-enriched.cdx.json \
  --licenses python-licenses.json
```

2026-10-21 对 CI `39541985913` 已上传的 160 项原始 Python SBOM 做本机补充演练：全部 160 项得到 PURL，154 项有上游许可证声明，6 项未知。版本身份采用 PEP 440 等价比较以兼容上游规范化（例如审计记录 `13.0.3.0`、发布元数据返回 `13.0.3`）；输出 PURL 和 sidecar 保留原始审计版本。此演练没有改写该 CI artifact；实现修正将在后续 CI 生成新 artifact。

工具最多 24 个并发 HTTPS 请求，校验证书、不跟随重定向，服从 runner 明确设置的 HTTP(S) 代理，每个版本最多一次有限重试，有响应大小上限。请求只含公开包名/版本，不读取应用 `.env`、供应商凭据或业务数据。

容器 Trivy 原始报告在另一个 `container-image-vulnerability-reports` artifact，包含无修复 HIGH/CRITICAL；门禁只在存在可修复高危/严重项、报告缺失或报告格式无效时失败。门禁通过不等于零漏洞。安全与许可证必须分别复核。
