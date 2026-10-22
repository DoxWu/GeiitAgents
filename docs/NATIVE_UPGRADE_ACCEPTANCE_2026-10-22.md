# Windows 开发版升级验收（2026-10-22）

本批使用真实 Windows NSIS 安装器及 WebView2 `155.0.4283.62`，验证 `0.1.0-dev.68 → 0.1.0-dev.69 → 0.1.0-dev.68`。数据均由旧版 UI 写入全新的隔离 WebView2 目录，不读取用户实际密钥库、模型密钥、知识库或业务资料。没有发布、部署或真实供应商调用。

## 已通过的范围

| 检查 | 本批结果与证据 |
| --- | --- |
| 当前代码构建 | `npm run desktop:build` 通过 TypeScript、Vite、Rust release 编译及 NSIS 打包；开发版号为 `0.1.0-dev.69`，正式通道未变。保留两条已有 workflow 动态/静态导入提示。 |
| 安装、升级、回退 | 实际安装 dev.68，再用 dev.69 安装器覆盖同一隔离目录，最后用 dev.68 安装器回退；每次核对卸载注册项的版本/目录及实际可执行文件版本/哈希。 |
| 旧库保留 | 旧 UI 创建模型连接、空对话、中文笔记、未提交草稿和图表任务。新版使用原口令打开；独立解密器逐字段核对原有完整数据，继续编辑、重启后保留。 |
| 回退读库 | 新版修改的共有格式数据能由旧可执行文件读取；安装器回退后再用实际安装的旧程序解锁，笔记和草稿内容正确。未承诺新版独有格式可降级。 |
| 旧备份恢复 | 旧版真实下载的加密备份可独立解密，与旧库数据一致；新版在另一空目录恢复并使用新口令解锁，恢复内容正确。 |
| 卸载与清理 | 隔离安装的程序与卸载注册项移除；本次安装目录删除；既有 dev.68 程序文件、原卸载注册项和两条快捷方式已恢复并核对相同。未读取或删除真实应用数据。 |

可重复的可执行文件兼容性检查位于 `kb_qa_system/frontend/scripts/verify-native-upgrade.mjs`，五个启动阶段、七项数据检查通过。安装器回退后的独立读库检查也通过，捕获的页面异常与外网请求尝试均为 0。

本批安装器总结果为忽略目录 `.tools/native-upgrade-20261022/installer-result.json`；最终安装 payload 的跨版本报告为 `run-O2xWET/result.json`，安装回退后的读库报告为 `run-43EmFz/result.json`。构建目录的 standalone 可执行文件另有 `run-HaJQRj/result.json`。不能将 standalone 二进制哈希当作安装 payload 的哈希，两者均独立记录。

## 构建产物

| 产物 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| dev.68 既有 NSIS | 9,196,245 | `05277331213A304F287ED4DCED4ABA00996BD00734E0508BB4447C7F7BA84AF8` |
| dev.69 未签名 NSIS | 12,732,822 | `2C408E10A95EDCA7C8E759CC04EC2890A9A2B7121372DC72ACE8C063F887B281` |
| dev.69 standalone EXE | 15,450,112 | `A8AEF9F1B9C66DAF495B82F7AA25D785FDC63C83D48A6D78F092EAC5B3BFE0F2` |

安装包位于 `kb_qa_system/frontend/src-tauri/target-dev/release/bundle/nsis/GeiIt Agents Dev_0.1.0-dev.69_x64-setup.exe`。它是本机未签名开发产物，不是已发布或已安装到用户日常目录的新版本；用户既有安装仍为 dev.68。

## 重复可执行文件兼容性检查

先保留旧 EXE，防止新构建覆盖它。从 `kb_qa_system/frontend` 运行，旧、新路径都必须指向真实的不同构建：

```powershell
node scripts/verify-native-upgrade.mjs --old-exe ../../.tools/native-upgrade-20261022/geiit-dev68.exe --new-exe src-tauri/target-dev/release/geiit-workbench.exe --output ../../.tools/native-upgrade-20261022
```

脚本自动新建测试目录，仅使用合成数据，不安装或卸载应用。安装器回退后，可以对该脚本创建的 `shared-profile` 执行独立读库检查：

```powershell
node scripts/verify-native-upgrade.mjs --verify-exe <回退后安装的EXE> --profile-dir <本批shared-profile目录> --output ../../.tools/native-upgrade-20261022
```

这不是任意个人数据的核验器，检查内容和口令固定为合成 fixture。真实安装器测试另需隔离其卸载登记、快捷方式和安装目录；本批一次性执行器仅保存在上述忽略目录，没有给自动化添加修改用户既有安装的默认入口。

安装器测试的两个中间问题已修正并重跑：NSIS 的 `/D=目录` 必须放在末尾且不额外加引号，否则本批会采用原默认目录；路径检查及时中止并由备份恢复原程序。卸载时必须等待实际卸载进程，本批以 `/S _?=隔离目录` 在原进程运行，避免临时子进程在恢复原注册项后继续删除它。另修正独立读库模式访问空 binaries 数组的测试脚本错误。前两次中间失败不计通过，最终全链返回成功后又独立核对原程序/登记/快捷方式与清理结果。

## 仍未完成

- 安装过程中强杀、物理断电、磁盘满、重启恢复，以及升级中断后的自动修复。
- 新版独有记录/工作流格式在旧版中的完整降级，不以共有格式的本批回退读库推断。
- 正式签名、更新服务与更新包校验；管理员/多用户安装、缺失 WebView2 的新机器。
- 真实 8 GB 设备、Safari/移动设备，以及目标部署、卷/Secret/队列恢复和 RPO/RTO。

本批没有启动 Docker，无新增镜像/容器；CI 镜像清理沿用其对应已核对记录。A19 基础安装/升级/回退/卸载与共有格式旧库/备份迁移已有真实本机证据，其余边界继续开放。
