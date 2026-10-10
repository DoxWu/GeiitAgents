# GeiIt企业知识库 - Sealos 部署指导文档

> **文档版本**：v2.0（详细版）
> **更新日期**：2026-07-19
> **适用对象**：首次使用 Sealos 部署本项目的用户

***

## 目录

1. [Sealos 平台简介](#一sealos-平台简介)
2. [部署架构总览](#二部署架构总览)
3. [部署前准备](#三部署前准备)
4. [资源规划与成本预估](#四资源规划与成本预估)
5. [Step 1：注册 Sealos 账号并充值](#step-1注册-sealos-账号并充值)
6. [Step 2：创建阿里云镜像仓库](#step-2创建阿里云镜像仓库)
7. [Step 3：部署 PostgreSQL 数据库](#step-3部署-postgresql-数据库)
8. [Step 4：部署 Redis 缓存](#step-4部署-redis-缓存)
9. [Step 5：构建并推送后端镜像](#step-5构建并推送后端镜像)
10. [Step 6：部署后端 API 服务](#step-6部署后端-api-服务)
11. [Step 7：构建并推送前端镜像](#step-7构建并推送前端镜像)
12. [Step 8：部署前端服务](#step-8部署前端服务)
13. [Step 9：配置自定义域名与 SSL](#step-9配置自定义域名与-ssl)
14. [Step 10：初始化超级管理员](#step-10初始化超级管理员)
15. [Step 11：验证部署](#step-11验证部署)
16. [常见问题排查](#常见问题排查)
17. [附录 A：环境变量完整说明](#附录-a环境变量完整说明)
18. [附录 B：Sealos 常用操作](#附录-bsealos-常用操作)
19. [附录 C：部署完成检查清单](#附录-c部署完成检查清单)

***

## 一、Sealos 平台简介

### 1.1 什么是 Sealos

Sealos 是一个基于 Kubernetes 的云操作系统，提供类 PaaS 的使用体验：

- **国内访问快**：机房在国内，国内访问延迟低（通常 < 50ms）
- **按量付费**：资源按秒计费，用多少付多少，适合中小项目
- **K8s 原生**：底层是 K8s，可部署任意容器化应用
- **自带数据库服务**：一键创建 PostgreSQL、Redis、MySQL、MongoDB 等
- **自动 HTTPS**：自定义域名自动签发 Let's Encrypt 证书

### 1.2 与 Railway 的对比

| 对比项       | Railway          | Sealos                   |
| --------- | ---------------- | ------------------------ |
| 机房位置      | 海外               | 国内                       |
| 国内访问延迟    | 200-500ms        | 20-50ms                  |
| 计费方式      | 月费/按量            | 按量（CPU/内存/存储）            |
| 数据库服务     | PostgreSQL/Redis | PostgreSQL/Redis/MySQL 等 |
| Docker 支持 | ✅                | ✅                        |
| 自定义域名     | ✅                | ✅                        |
| 自动 HTTPS  | ✅                | ✅（Let's Encrypt）         |
| 学习曲线      | 低                | 中（K8s 基础）                |
| 国内浏览器兼容   | 需 CDN 加速         | 原生支持                     |

### 1.3 官方资源

- **Sealos Cloud 官网**：<https://sealos.io>
- **官方文档**：<https://sealos.io/docs/>
- **官方社群**：通常有微信/Discord 群，可在官网找到入口

***

## 二、部署架构总览

> 可复用的应用层 Kustomize 模板见 [`../deploy/sealos/README.md`](../deploy/sealos/README.md)。本指南仍保留 Sealos 控制台和数据库应用的逐步操作；模板中的 Secret 只作占位示例，不能直接用于生产。

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    用户浏览器                                │
│              (Chrome / Edge / 夸克 / QQ / 百度)              │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                  geiit.online (域名)                         │
│                   DNS → Sealos                              │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Sealos Cloud (国内机房)                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           kb-qa-frontend (nginx 容器)                │   │
│  │  - 静态资源服务 (/)                                  │   │
│  │  - API 反向代理 (/api/v1/...)                        │   │
│  └──────────┬──────────────────────────┬────────────────┘   │
│             │                          │                     │
│             ▼                          ▼                     │
│  ┌─────────────────────┐  ┌─────────────────────────┐       │
│  │  kb-qa-api 容器     │  │  PostgreSQL 数据库      │       │
│  │  - FastAPI (8000)   │  │  - pgvector 扩展        │       │
│  │  - Celery Worker    │◄─┤  - pg_trgm 扩展         │       │
│  │    (后台运行)        │  │  - kb_qa 数据库         │       │
│  └──────────┬──────────┘  └─────────────────────────┘       │
│             │                                                │
│             ▼                                                │
│  ┌─────────────────────┐  ┌─────────────────────────┐       │
│  │  Redis 缓存         │  │  持久化存储              │       │
│  │  - DB 0: 缓存       │  │  - /app/uploads (1GB)   │       │
│  │  - DB 1: Celery     │  │  - /app/data (1GB)      │       │
│  │  - DB 2: Results    │  │  - PG数据 (5GB)         │       │
│  └─────────────────────┘  └─────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据流向

1. **用户访问**：浏览器 → `geiit.online` → Sealos → frontend 容器
2. **API 请求**：浏览器 → `geiit.online/api/v1/...` → nginx 反代 → backend 容器
3. **数据库访问**：backend → PostgreSQL（内网服务名 `kb-qa-postgres`）
4. **缓存访问**：backend → Redis（内网服务名 `kb-qa-redis`）
5. **异步任务**：backend → Celery Worker（同容器后台进程）→ Redis Broker → PostgreSQL

### 2.3 关键设计决策

| 决策点               | 方案                               | 原因                       |
| ----------------- | -------------------------------- | ------------------------ |
| API + Worker 部署模式 | 合并部署（`ROLE=api+worker`）          | 省一个容器费用，文件路径天然一致         |
| 前端访问 API          | nginx 反向代理（同源）                   | 消除 CORS，解决国产浏览器兼容性       |
| 数据库               | 自建 `pgvector/pgvector:pg16`      | Sealos 默认 PG 不含 pgvector |
| 数据库迁移             | 启动时执行（`MIGRATE_ON_STARTUP=true`） | Sealos 无 releaseCommand  |

***

## 三、部署前准备

### 3.1 账号准备清单

部署前需要准备以下账号：

| 账号          | 用途               | 获取地址                         |
| ----------- | ---------------- | ---------------------------- |
| Sealos 账号   | 部署平台             | <https://sealos.io>          |
| 阿里云账号       | 镜像仓库（ACR）        | <https://aliyun.com>         |
| 域名服务商账号     | DNS 解析管理         | 阿里云/腾讯云/Cloudflare           |
| Resend 账号   | 邮件发送服务           | <https://resend.com>         |
| DeepSeek 账号 | LLM API 服务       | <https://deepseek.com>       |
| 阿里云百炼账号     | Embedding 降级 API | <https://bailian.aliyun.com> |

### 3.2 本地环境要求

#### 3.2.1 必装软件

| 软件     | 版本要求          | 验证命令               |
| ------ | ------------- | ------------------ |
| Docker | 20.0+         | `docker --version` |
| Git    | 2.0+          | `git --version`    |
| Python | 3.11+（仅生成密钥用） | `python --version` |

#### 3.2.2 验证 Docker 可用

```bash
docker info
# 应输出 Docker 相关信息，无报错
```

如果 Docker 未安装：

- Windows/Mac：安装 Docker Desktop
- Linux：`curl -fsSL https://get.docker.com | sh`

#### 3.2.3 克隆项目代码

```bash
git clone https://github.com/DoxWu/GeiitAgents.git
cd GeiitAgents
```

确认项目结构：

```
GeiitAgents/
├── kb_qa_system/
│   ├── backend/              # 后端代码
│   │   ├── Dockerfile        # 后端镜像构建文件
│   │   ├── entrypoint.sh     # 容器启动脚本
│   │   ├── requirements.txt  # Python 依赖
│   │   ├── .env.example      # 环境变量示例
│   │   └── app/              # 应用源码
│   ├── frontend/             # 前端代码
│   │   ├── Dockerfile        # 前端镜像构建文件
│   │   ├── nginx.conf        # nginx 配置（反代模式）
│   │   ├── start.sh          # 启动脚本
│   │   └── src/              # 前端源码
│   └── docker-compose.yml    # 本地开发编排（参考）
└── docs/                     # 文档
```

### 3.3 生成密钥和密码

#### 3.3.1 生成 JWT SECRET\_KEY

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

**输出示例**：

```
aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9d
```

记录此密钥，后续配置 `SECRET_KEY` 环境变量时使用。

#### 3.3.2 生成 PostgreSQL 密码

```bash
python -c "import secrets; print(secrets.token_urlsafe(16))"
```

**输出示例**：

```
K8mN2pQ4rS6tU8vW0xY2zA4bC6d
```

#### 3.3.3 生成 Redis 密码

```bash
python -c "import secrets; print(secrets.token_urlsafe(16))"
```

#### 3.3.4 准备外部 API 密钥

确保已获取以下 API 密钥：

| 密钥                           | 获取方式                                    |
| ---------------------------- | --------------------------------------- |
| `OPENAI_API_KEY`             | DeepSeek 控制台 → API Keys                 |
| `LLM_FALLBACK_API_KEY`       | 阿里云百炼控制台 → API Keys                     |
| `EMBEDDING_FALLBACK_API_KEY` | 阿里云百炼控制台 → API Keys（与 LLM\_FALLBACK 相同） |
| `RESEND_API_KEY`             | Resend 控制台 → API Keys（格式：`re_xxxxx`）    |

### 3.4 域名准备

确保已拥有域名（如 `geiit.online`），并能管理 DNS 解析。

**域名 DNS 管理位置**：

- 阿里云：<https://dns.console.aliyun.com>
- 腾讯云：<https://console.dnspod.cn>
- Cloudflare：<https://dash.cloudflare.com>

***

## 四、资源规划与成本预估

### 4.1 资源需求

| 服务              | CPU    | 内存    | 存储  | 说明                   |
| --------------- | ------ | ----- | --- | -------------------- |
| PostgreSQL      | 0.5 核  | 512MB | 5GB | 含 pgvector 扩展        |
| Redis           | 0.25 核 | 256MB | 1GB | AOF 持久化              |
| 后端 API + Worker | 1 核    | 1GB   | 2GB | 合并部署（uploads + data） |
| 前端 nginx        | 0.25 核 | 256MB | 1GB | 静态资源 + 反代            |

**合计**：约 2 核 CPU，2GB 内存，9GB 存储

### 4.2 成本预估

> 实际价格以 Sealos 官网为准，新用户通常有免费额度。

Sealos Cloud 按量计费，大致费率：

| 资源  | 费率             |
| --- | -------------- |
| CPU | 约 ¥0.05/核/小时   |
| 内存  | 约 ¥0.02/GB/小时  |
| 存储  | 约 ¥0.001/GB/小时 |

**月度估算**（24小时×30天运行）：

- CPU：2 核 × 24h × 30 天 × ¥0.05 ≈ ¥72
- 内存：2GB × 24h × 30 天 × ¥0.02 ≈ ¥29
- 存储：9GB × 24h × 30 天 × ¥0.001 ≈ ¥7

**合计约 ¥108/月**

> Sealos 常有优惠活动，实际可能更低。建议关注官方活动。

***

## Step 1：注册 Sealos 账号并充值

### 1.1 注册账号

1. 打开浏览器访问 <https://sealos.io>
2. 点击页面右上角「注册」或「Sign Up」
3. 输入邮箱和密码完成注册
4. 登录后会进入 Sealos Cloud 桌面（类似操作系统的桌面界面）

### 1.2 充值余额

Sealos 按量付费，需先充值：

1. 在 Sealos 桌面点击「费用中心」图标
2. 点击「充值」
3. 建议首次充值 ¥50-100 用于测试
4. 支付完成后返回桌面

### 1.3 熟悉 Sealos 桌面

Sealos Cloud 桌面包含以下常用应用：

| 图标      | 名称             | 用途        |
| ------- | -------------- | --------- |
| 📁 应用管理 | App Management | 管理所有部署的应用 |
| 🗄️ 数据库 | Database       | 创建和管理数据库  |
| 🌐 终端   | Terminal       | 命令行操作     |
| 💰 费用中心 | Billing        | 查看余额和消费   |
| ⚙️ 设置   | Settings       | 账号设置      |

***

## Step 2：创建阿里云镜像仓库

Sealos 部署应用需要 Docker 镜像，本项目使用阿里云 ACR（容器镜像服务）。

### 2.1 开通阿里云容器镜像服务

1. 登录阿里云控制台：<https://console.aliyun.com>
2. 顶部搜索框输入「容器镜像服务」
3. 点击进入，首次使用会提示开通
4. 选择「个人实例」（免费），点击开通

### 2.2 创建命名空间

1. 在容器镜像服务控制台左侧菜单 →「仓库管理」→「命名空间」
2. 点击「创建命名空间」
3. 输入命名空间名称（如 `geiit`）
   - 注意：命名空间全局唯一，需未被占用
   - 只支持小写字母、数字、下划线
4. 点击「确定」

### 2.3 创建镜像仓库

需要创建两个镜像仓库：`kb-qa-backend` 和 `kb-qa-frontend`

#### 创建后端镜像仓库

1. 左侧菜单 →「仓库管理」→「镜像仓库」
2. 点击「创建镜像仓库」
3. 填写信息：

| 字段   | 值                |
| ---- | ---------------- |
| 命名空间 | `geiit`（刚创建的）    |
| 仓库名称 | `kb-qa-backend`  |
| 仓库类型 | `私有`             |
| 代码源  | `不绑定代码源`（本地构建推送） |

1. 点击「创建镜像仓库」

#### 创建前端镜像仓库

重复上述步骤，仓库名称填 `kb-qa-frontend`。

### 2.4 设置镜像仓库密码

1. 左侧菜单 →「访问凭证」
2. 点击「设置固定密码」
3. 设置一个强密码（用于 `docker login`）
4. 记录此密码

### 2.5 记录镜像仓库地址

镜像仓库地址格式：`registry.cn-<区域>.aliyuncs.com/<命名空间>/<仓库名>`

例如：

- 后端：`registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-backend`
- 前端：`registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-frontend`

**查看方式**：镜像仓库列表 → 点击仓库名 → 右上角显示完整地址。

***

## Step 3：部署 PostgreSQL 数据库

> **重要**：Sealos 默认的 PostgreSQL 镜像**不含 pgvector 扩展**，必须使用含 pgvector 的镜像。
>
> **关键**：不要直接在 Sealos 使用 Docker Hub 的 `pgvector/pgvector:pg16` 镜像——Sealos 是国内平台，从 Docker Hub 拉取会卡在 `waiting` 状态（`ImagePullBackOff`）。必须先本地拉取再推送到阿里云 ACR。

### 3.1 方案选择

| 方案                        | 操作                 | 推荐度    |
| ------------------------- | ------------------ | ------ |
| 方案 A：Sealos 数据库服务 + 手动装扩展 | 简单，但可能不支持 pgvector | ⚠️ 视情况 |
| 方案 B：本地构建镜像推送到 ACR        | 稍复杂，但国内拉取快，确保可用    | ✅ 推荐   |

**建议直接使用方案 B**，避免 Docker Hub 拉取超时和扩展安装失败。

### 3.2 方案 B：本地构建镜像推送到 ACR（推荐）

#### 3.2.1 本地配置 Docker 镜像加速器

由于需要从 Docker Hub 拉取 `pgvector/pgvector:pg16`，先配置国内镜像加速器。

在 Docker Desktop → Settings → Docker Engine，修改配置添加：

```json
{
  "registry-mirrors": [
    "https://docker.mirrors.ustc.edu.cn",
    "https://hub-mirror.c.163.com",
    "https://mirror.ccs.tencentyun.com"
  ]
}
```

保存并重启 Docker。

#### 3.2.2 在阿里云 ACR 创建镜像仓库

1. 登录阿里云容器镜像服务控制台：<https://cr.console.aliyun.com>
2. 左侧菜单 →「仓库管理」→「镜像仓库」→「创建镜像仓库」
3. 填写信息：

| 字段   | 值                |
| ---- | ---------------- |
| 命名空间 | `geiit`          |
| 仓库名称 | `kb-qa-postgres` |
| 仓库类型 | `私有`             |
| 代码源  | `不绑定代码源`         |

1. 点击「创建镜像仓库」

#### 3.2.3 本地拉取 pgvector 镜像

```bash
# 拉取含 pgvector 扩展的 PG16 镜像（约 400MB+）
docker pull pgvector/pgvector:pg16
```

#### 3.2.4 登录 ACR 并推送

```bash
# 登录 ACR
docker login --username=你的阿里云账号 registry.cn-hangzhou.aliyuncs.com

# 重新打标签（替换为你的命名空间）
docker tag pgvector/pgvector:pg16 registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-postgres:pg16

# 推送到 ACR
docker push registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-postgres:pg16
```

推送完成后，在 ACR 控制台确认 `kb-qa-postgres` 仓库出现 `pg16` 版本。

#### 3.2.5 在 Sealos 创建应用

1. 在 Sealos 桌面点击「应用管理」图标
2. 点击右上角「部署应用」→ 选择「自定义应用」
3. 进入应用配置页面

#### 3.2.6 填写基本信息

| 字段   | 值                                                             | 说明          |
| ---- | ------------------------------------------------------------- | ----------- |
| 应用名称 | `kb-qa-postgres`                                              | 用于内网服务名访问   |
| 镜像   | `registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-postgres:pg16` | 你自己的 ACR 地址 |
| 副本数  | `1`                                                           | 单实例         |
| CPU  | `0.5` 核                                                       | <br />      |
| 内存   | `512` MB                                                      | <br />      |

> **关键**：镜像地址必须是你的 ACR 地址，不是 Docker Hub 的 `pgvector/pgvector:pg16`。

#### 3.2.7 配置环境变量

在「环境变量」部分添加以下变量：

| 变量名                    | 值                             | 说明        |
| ---------------------- | ----------------------------- | --------- |
| `POSTGRES_USER`        | `postgres`                    | 数据库用户名    |
| `POSTGRES_PASSWORD`    | `<3.3.2 生成的密码>`               | 数据库密码     |
| `POSTGRES_DB`          | `kb_qa`                       | 自动创建的数据库名 |
| `TZ`                   | `Asia/Shanghai`               | 时区        |
| `POSTGRES_INITDB_ARGS` | `--encoding=UTF-8 --locale=C` | 初始化参数     |

> **注意**：如果密码包含特殊字符（`@`、`#`、`:`、`/` 等），在数据库连接 URL 中需要 URL 编码。为避免麻烦，建议密码只用字母和数字。

#### 3.2.8 配置存储

在「存储」部分添加持久化卷：

| 挂载路径                  | 大小     | 访问模式            | 说明            |
| --------------------- | ------ | --------------- | ------------- |
| `/var/lib/postgresql` | `5` GB | `ReadWriteOnce` | PG 数据目录（挂父目录） |

> **重要**：挂载路径必须是 `/var/lib/postgresql`（父目录），**不要挂载到** **`/var/lib/postgresql/data`**。
>
> 原因：Sealos 的存储卷（ext4）挂载点根目录会自动生成 `lost+found` 目录，如果直接挂载到 `/var/lib/postgresql/data`，initdb 会报错 `directory exists but is not empty` 而拒绝初始化。挂载到父目录后，PostgreSQL 镜像的 entrypoint 会自动创建 `data` 子目录并初始化，避开该问题。
>
> 不配置存储的话，容器重启后数据会丢失。

#### 3.2.9 配置网络

| 字段   | 值                 |
| ---- | ----------------- |
| 容器端口 | `5432`            |
| 访问方式 | `内网访问`（ClusterIP） |

> 不需要对外暴露，应用通过内网服务名 `kb-qa-postgres` 访问。

#### 3.2.10 部署

1. 检查配置无误
2. 点击「部署」按钮
3. 等待状态变为 `Running`（使用 ACR 镜像后通常 30 秒内）

#### 3.2.11 验证 PostgreSQL 启动

1. 在应用详情页点击「日志」标签
2. 查看日志，应看到类似输出：

```
PostgreSQL init process complete; ready for start up.

PostgreSQL Database directory appears to contain a database; Skipping initialization

2026-07-19 10:00:00.000 CST [1] LOG:  starting PostgreSQL 16.x ...
2026-07-19 10:00:00.000 CST [1] LOG:  listening on IPv4 address "0.0.0.0", port 5432
2026-07-19 10:00:00.000 CST [1] LOG:  database system is ready to accept connections
```

### 3.3 创建 pgvector 扩展

#### 3.3.1 进入 Sealos 终端

1. 在 Sealos 桌面点击「终端」图标
2. 打开终端窗口

#### 3.3.2 连接到 PostgreSQL

```bash
# 安装 psql 客户端（如未安装）
apt-get update && apt-get install -y postgresql-client

# 连接到数据库（替换密码）
psql "postgresql://postgres:你的密码@kb-qa-postgres:5432/kb_qa"
```

> 如果 `kb-qa-postgres` 主机名无法解析，在应用详情页查看「内网 IP」替代。

#### 3.3.3 执行 SQL 创建扩展

连接成功后，在 psql 提示符下执行：

```sql
-- 创建 pgvector 扩展（向量存储和相似度检索）
CREATE EXTENSION IF NOT EXISTS vector;

-- 创建 pg_trgm 扩展（模糊检索）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 验证扩展创建成功
SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector', 'pg_trgm');
```

**预期输出**：

```
  extname  | extversion
-----------+------------
 vector    | 0.7.x
 pg_trgm   | 1.7.x
(2 rows)
```

#### 3.3.4 退出 psql

```sql
\q
```

### 3.4 记录数据库连接信息

记录以下信息，后续配置后端环境变量时使用：

```
DATABASE_URL=postgresql+psycopg://postgres:你的密码@kb-qa-postgres-0:5432/kb_qa
```

> **关键**：URL 前缀必须是 `postgresql+psycopg://`（不是 `postgresql://`），否则 SQLAlchemy 会用 psycopg2 而非 psycopg3。

***

## Step 4：部署 Redis 缓存

### 4.1 创建 Redis 实例

#### 4.1.1 选择创建方式

1. 在 Sealos 桌面点击「应用管理」
2. 点击「部署应用」→ 选择「数据库」→「Redis」

> 如果 Sealos 没有内置 Redis 服务，使用「自定义应用」部署 `redis:7-alpine` 镜像。

#### 4.1.2 填写配置

| 字段   | 值                        |
| ---- | ------------------------ |
| 应用名称 | `kb-qa-redis`            |
| 镜像   | `redis:7-alpine`（如自定义部署） |
| 副本数  | `1`                      |
| CPU  | `0.25` 核                 |
| 内存   | `256` MB                 |

#### 4.1.3 配置环境变量

如果使用自定义部署，启动命令设置为：

```bash
redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru --requirepass 你的密码
```

或通过环境变量：

| 变量名  | 值               |
| ---- | --------------- |
| `TZ` | `Asia/Shanghai` |

#### 4.1.4 配置存储

| 挂载路径    | 大小     |
| ------- | ------ |
| `/data` | `1` GB |

#### 4.1.5 配置网络

| 字段   | 值      |
| ---- | ------ |
| 容器端口 | `6379` |
| 访问方式 | `内网访问` |

#### 4.1.6 部署

点击「部署」，等待状态变为 `Running`。

### 4.2 验证 Redis

#### 4.2.1 在 Sealos 终端测试

```bash
# 安装 redis-cli（如未安装）
apt-get install -y redis-tools

# 测试连接（替换密码）
redis-cli -h default -p 6379 -a 你的密码 ping
```

**预期输出**：

```
PONG
```

> 如果出现 `NOAUTH` 错误，说明密码错误；如果连接超时，说明服务名或端口不对。

### 4.3 记录 Redis 连接信息

记录以下信息：

```
REDIS_URL=redis://default:你的密码@kb-qa-redis-redis-redis.ns-rtz8ktty.svc:6379/0
CELERY_BROKER_URL=redis://default:你的密码@kb-qa-redis-redis-redis.ns-rtz8ktty.svc:6379/1
CELERY_RESULT_BACKEND=redis://default:你的密码@kb-qa-redis-redis-redis.ns-rtz8ktty.svc:6379/2
```

> **说明**：
>
> - Redis URL 格式：`redis://:密码@主机:端口/数据库号`
> - 密码前有冒号 `:`，不要漏掉
> - 数据库 0 用于缓存，1 用于 Celery Broker，2 用于 Celery Results

***

## Step 5：构建并推送后端镜像

### 5.1 登录阿里云镜像仓库

在本地终端执行：

```bash
docker login --username=你的阿里云账号 registry.cn-hangzhou.aliyuncs.com
```

输入密码（Step 2.4 设置的固定密码）。

**成功输出**：

```
Login Succeeded
```

### 5.2 构建后端镜像

#### 5.2.1 进入项目目录

```bash
cd GeiitAgents/kb_qa_system
```

#### 5.2.2 执行构建命令

```bash
docker build \
  --build-arg INSTALL_LOCAL_ML=false \
  -t registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-backend:latest \
  -f backend/Dockerfile \
  backend/
```

**参数说明**：

| 参数                                   | 说明                      |
| ------------------------------------ | ----------------------- |
| `--build-arg INSTALL_LOCAL_ML=false` | 不安装本地 ML 依赖（节省 \~800MB） |
| `-t`                                 | 镜像完整地址（替换为你的实际地址）       |
| `-f`                                 | Dockerfile 路径           |
| `backend/`                           | 构建上下文目录                 |

#### 5.2.3 等待构建完成

构建时间约 5-10 分钟，取决于网络速度。

**构建成功输出**（末尾）：

```
Successfully built xxxxxxxxxxxx
Successfully tagged registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-backend:latest
```

### 5.3 推送后端镜像

```bash
docker push registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-backend:latest
```

推送时间约 5-15 分钟（镜像约 1-2GB，取决于网络）。

**成功输出**：

```
latest: digest: sha256:xxxxxxxxxxxx size: xxxx
```

### 5.4 验证镜像推送成功

1. 登录阿里云容器镜像服务控制台
2. 进入 `geiit/kb-qa-backend` 仓库
3. 点击「镜像版本」标签
4. 应看到 `latest` 版本，状态为「可用」

***

## Step 6：部署后端 API 服务

### 6.1 创建应用

1. 在 Sealos 桌面点击「应用管理」
2. 点击「部署应用」→「自定义应用」

### 6.2 填写基本信息

| 字段   | 值                                                              | 说明        |
| ---- | -------------------------------------------------------------- | --------- |
| 应用名称 | `kb-qa-api`                                                    | 内网服务名     |
| 镜像   | `registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-backend:latest` | 替换为你的实际地址 |
| 副本数  | `1`                                                            | 单副本       |
| CPU  | `1` 核                                                          | <br />    |
| 内存   | `1024` MB                                                      | 1GB       |

### 6.3 配置环境变量

在「环境变量」标签，点击「添加环境变量」，逐个添加以下变量。

> **重要**：所有 `密码`、`密钥` 字段需替换为你的实际值。

#### 6.3.1 角色与环境

```env
ROLE=api+worker
ENVIRONMENT=production
DEBUG=False
PORT=8000
MIGRATE_ON_STARTUP=true
TZ=Asia/Shanghai
```

| 变量                        | 说明                                  |
| ------------------------- | ----------------------------------- |
| `ROLE=api+worker`         | API 和 Worker 合并部署，省一个容器             |
| `ENVIRONMENT=production`  | 生产环境，自动关闭 DEBUG                     |
| `MIGRATE_ON_STARTUP=true` | 启动时执行数据库迁移（Sealos 无 releaseCommand） |

#### 6.3.2 数据库配置

```env
DATABASE_URL=postgresql+psycopg://postgres:你的密码@kb-qa-postgres:5432/kb_qa
```

> **关键**：
>
> - 前缀必须是 `postgresql+psycopg://`（psycopg3 驱动）
> - 密码特殊字符需 URL 编码：`@` → `%40`、`#` → `%23`、`:` → `%3A`、`/` → `%2F`
> - 建议密码只用字母数字，避免编码麻烦

#### 6.3.3 Redis 配置

```env
REDIS_URL=redis://:你的密码@kb-qa-redis:6379/0
CELERY_BROKER_URL=redis://:你的密码@kb-qa-redis:6379/1
CELERY_RESULT_BACKEND=redis://:你的密码@kb-qa-redis:6379/2
```

#### 6.3.4 CORS 配置

```env
CORS_ORIGINS=["https://geiit.online"]
```

> 反代模式下也保留 CORS 配置（兼容性，防止 nginx 配置失误时 API 仍可访问）。

#### 6.3.5 JWT 认证

```env
SECRET_KEY=<3.3.1 生成的密钥>
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=15
REFRESH_TOKEN_EXPIRE_DAYS=7
```

#### 6.3.6 邮件配置

```env
EMAIL_ENABLED=True
EMAIL_PROVIDER=http
RESEND_API_KEY=re_你的resend_key
EMAIL_FROM=GeiIt企业知识库 <noreply@geiit.online>
ADMIN_NOTIFY_EMAIL=你的管理员邮箱
FRONTEND_BASE_URL=https://geiit.online
PASSWORD_TOKEN_EXPIRE_HOURS=24
```

> **说明**：
>
> - `EMAIL_FROM` 的域名必须在 Resend 控制台完成验证
> - 默认 `onboarding@resend.dev` 只能发到 Resend 注册邮箱
> - `FRONTEND_BASE_URL` 用于邮件中的密码设置链接

#### 6.3.7 LLM 大模型配置

```env
OPENAI_API_KEY=sk-你的deepseek_key
OPENAI_API_BASE=https://api.deepseek.com
LLM_MODEL_NAME=deepseek-v4-pro
LLM_FALLBACK_MODEL_NAME=deepseek-v4-flash
EMBEDDING_MODEL_NAME=text-embedding-v4
EMBEDDING_DIMENSION=1536
VISION_MODEL_NAME=qwen3.6-plus
```

#### 6.3.8 LLM 容错配置

```env
LLM_MAX_RETRIES=3
LLM_TIMEOUT=60
LLM_STREAM_FIRST_TOKEN_TIMEOUT=30
CIRCUIT_BREAKER_THRESHOLD=10
CIRCUIT_BREAKER_RECOVERY_TIME=60
```

> `LLM_STREAM_FIRST_TOKEN_TIMEOUT=30`：推理模型首字延迟较长，不能设太小，否则熔断器误开。

#### 6.3.9 多 API 降级配置

```env
LLM_FALLBACK_API_KEY=你的阿里云key
LLM_FALLBACK_API_BASE=https://ws-fpzje8gjl9rtqogw.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
LLM_FALLBACK_ENABLED=true
EMBEDDING_FALLBACK_API_KEY=你的阿里云key
EMBEDDING_FALLBACK_API_BASE=https://ws-fpzje8gjl9rtqogw.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
```

> **重要**：DeepSeek 不支持 `/embeddings` 端点，Embedding 降级必须指向阿里云。`EMBEDDING_FALLBACK_API_KEY` 与 `LLM_FALLBACK_API_KEY` 通常是同一个阿里云密钥。

#### 6.3.10 本地 Embedding 兜底

```env
LOCAL_EMBEDDING_ENABLED=false
```

> 服务端本地 Embedding provider 默认关闭。启用前必须安装 `requirements-local-ml.txt` 对应依赖，并确认模型输出维度、数据库向量列和索引属于同一向量空间；它不是桌面客户端本地知识库的 E5 开关，也不会自动下载客户端模型。

#### 6.3.11 RAG 优化配置

```env
ENABLE_INTENT_DETECTION=True
ENABLE_CONFLICT_DETECTION=True
ENABLE_LATEX_PROTECTION=True
ENABLE_HYBRID_SEARCH=True
SEARCH_TOP_K=6
SIMILARITY_THRESHOLD=0.35
KEYWORD_SEARCH_WEIGHT=0.3
```

#### 6.3.12 限流配置

```env
ENABLE_RATE_LIMIT=True
RATE_LIMIT_GLOBAL_PER_MINUTE=100
RATE_LIMIT_LOGIN_PER_MINUTE=5
RATE_LIMIT_ASK_PER_MINUTE=20
RATE_LIMIT_UPLOAD_PER_HOUR=20
LOGIN_FAILURE_LOCK_THRESHOLD=5
LOGIN_FAILURE_LOCK_MINUTES=15
```

#### 6.3.13 记忆衰退配置

```env
CONVERSATION_HISTORY_LIMIT=5
CONVERSATION_HISTORY_MAX_TOKENS=2000
ENABLE_HISTORY_SUMMARY=True
SUMMARY_EVERY_N_TURNS=5
```

#### 6.3.14 文档处理配置

```env
CHUNK_SIZE=800
CHUNK_OVERLAP=100
DOCUMENT_QUALITY_THRESHOLD=60.0
ENABLE_OCR=True
ENABLE_VISION=True
ENABLE_TABLE_EXTRACTION=True
```

### 6.4 配置存储

在「存储」标签添加：

| 挂载路径           | 大小     | 说明                       |
| -------------- | ------ | ------------------------ |
| `/app/uploads` | `1` GB | 用户上传的文档存储                |
| `/app/data`    | `1` GB | 运行时数据（本地 embedding 模型缓存） |

> **重要**：
>
> - 不配置存储的话，容器重启后上传的文件会丢失
> - 后端入口脚本 `entrypoint.sh` 会在启动时自动修复 `/app/uploads`、`/app/data` 的目录权限
>   （K8s 的 PVC 挂载点属主为 root，脚本会 chown 给 `kbapp` 用户），因此无需手动处理权限

### 6.5 配置健康检查

故障恢复和备份配置以 [Sealos 故障恢复、异地备份与告警](SEALOS_RECOVERY_AND_BACKUP.md) 为准，包含 PVC 排查、完整三种探针 YAML 和环境变量。

在「健康检查」标签配置存活探针；就绪探针另外使用 `/ready`，依赖异常返回 503：

| 字段   | 值                       |
| ---- | ----------------------- |
| 检查类型 | `HTTP`                  |
| 检查路径 | `/live`                 |
| 端口   | `8000`                  |
| 间隔   | `30` 秒                  |
| 超时   | `10` 秒                  |
| 启动延迟 | 使用 startupProbe 留出恢复时间，详见上述指南 |
| 失败阈值 | `3` 次                   |

### 6.6 配置网络

| 字段   | 值                 |
| ---- | ----------------- |
| 容器端口 | `8000`            |
| 访问方式 | `内网访问`（ClusterIP） |

> 后端不需要对外暴露，前端通过内网服务名访问。

### 6.7 部署应用

1. 检查所有配置无误
2. 点击「部署」按钮
3. 等待状态变为 `Running`（首次启动约 1-3 分钟，需执行数据库迁移）

### 6.8 验证后端启动

#### 6.8.1 查看启动日志

1. 在应用详情页点击「日志」标签
2. 应看到以下关键日志：

```
==========================================
  GeiIt企业知识库 - 启动中
  角色: api+worker
  环境: production
==========================================
⏭️  MIGRATE_ON_STARTUP=true
📦 正在执行数据库迁移...
INFO  [alembic.runtime.migration] Running upgrade  -> 001, ...
INFO  [alembic.runtime.migration] Running upgrade 001 -> 002, ...
...
✅ 数据库迁移完成
🔧 启动 Celery Worker（后台）...
🚀 启动 FastAPI 服务（1 workers）...
INFO:     Uvicorn running on http://0.0.0.0:8000
INFO:     Application startup complete.
```

#### 6.8.2 测试健康检查

在 Sealos 终端执行：

```bash
curl http://kb-qa-api:8000/health
```

**预期输出**：

```json
{"status": "healthy", "version": "x.x.x"}
```

> 如果连接失败，检查后端应用状态是否 `Running`，以及服务名是否正确。

***

## Step 7：构建并推送前端镜像

### 7.1 构建前端镜像

在本地项目根目录执行：

```bash
docker build \
  --build-arg VITE_API_BASE_URL=/api/v1 \
  -t registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-frontend:latest \
  -f kb_qa_system/frontend/Dockerfile \
  kb_qa_system/frontend/
```

**参数说明**：

| 参数                                      | 说明                   |
| --------------------------------------- | -------------------- |
| `--build-arg VITE_API_BASE_URL=/api/v1` | 前端通过同源路径访问 API（反代模式） |
| `-f`                                    | Dockerfile 路径        |
| `kb_qa_system/frontend/`                | 构建上下文                |

### 7.2 推送前端镜像

```bash
docker push registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-frontend:latest
```

### 7.3 验证镜像推送

在阿里云 ACR 控制台确认 `kb-qa-frontend` 仓库中有 `latest` 版本。

***

## Step 8：部署前端服务

### 8.1 创建应用

1. 在 Sealos「应用管理」→「部署应用」→「自定义应用」

### 8.2 填写基本信息

| 字段   | 值                                                               |
| ---- | --------------------------------------------------------------- |
| 应用名称 | `kb-qa-frontend`                                                |
| 镜像   | `registry.cn-hangzhou.aliyuncs.com/geiit/kb-qa-frontend:latest` |
| 副本数  | `1`                                                             |
| CPU  | `0.25` 核                                                        |
| 内存   | `256` MB                                                        |

### 8.3 配置环境变量

```env
BACKEND_URL=http://kb-qa-api:8000
PORT=80
```

| 变量            | 说明                      |
| ------------- | ----------------------- |
| `BACKEND_URL` | 后端内网地址（`http://应用名:端口`） |
| `PORT`        | nginx 监听端口              |

> **关键**：
>
> - `BACKEND_URL` 使用**内网服务名**访问后端（同命名空间下应用可通过服务名直接访问）
> - 不含 `/api/v1` 后缀，不含尾部 `/`
> - 如果内网访问不通，改用后端公网域名

### 8.4 配置存储

前端无需持久化存储，跳过此步。

### 8.5 配置健康检查

| 字段   | 值      |
| ---- | ------ |
| 检查类型 | `HTTP` |
| 检查路径 | `/`    |
| 端口   | `80`   |
| 间隔   | `30` 秒 |
| 超时   | `5` 秒  |
| 启动延迟 | `10` 秒 |
| 失败阈值 | `3` 次  |

### 8.6 配置网络

| 字段   | 值                     |
| ---- | --------------------- |
| 容器端口 | `80`                  |
| 访问方式 | `外网访问`（需要公网访问，用于域名绑定） |

### 8.7 部署并验证

1. 点击「部署」
2. 等待状态变为 `Running`
3. 查看日志，应看到：

```
nginx listening on port 80, backend proxy: http://kb-qa-api:8000
```

***

## Step 9：配置自定义域名与 SSL

### 9.1 获取 Sealos 域名解析地址

1. 在 `kb-qa-frontend` 应用详情页 →「网络」标签
2. 找到「自定义域名」部分
3. 添加域名：`geiit.online`
4. Sealos 会提示需要添加的 CNAME 记录值（格式如 `xxx.cloud.sealos.io`）
5. 记录此 CNAME 地址

### 9.2 配置 DNS 解析

登录你的域名 DNS 服务商，添加 CNAME 记录：

#### 阿里云 DNS 配置示例

1. 进入阿里云 DNS 控制台：<https://dns.console.aliyun.com>
2. 选择你的域名 →「解析设置」
3. 添加记录：

| 字段   | 值                                   |
| ---- | ----------------------------------- |
| 记录类型 | `CNAME`                             |
| 主机记录 | `@`（表示根域名）                          |
| 记录值  | `xxx.cloud.sealos.io`（Sealos 提供的地址） |
| TTL  | `600`（10 分钟）                        |

1. 如果使用 `www` 子域名，再添加一条：

| 字段   | 值                     |
| ---- | --------------------- |
| 记录类型 | `CNAME`               |
| 主机记录 | `www`                 |
| 记录值  | `xxx.cloud.sealos.io` |
| TTL  | `600`                 |

#### 腾讯云 DNSPod 配置示例

类似阿里云，在 <https://console.dnspod.cn> 添加 CNAME 记录。

#### Cloudflare 配置示例

> **注意**：如果使用 Cloudflare，CNAME 记录的代理状态必须设为「仅 DNS」（灰色云朵），否则 SSL 会冲突。

1. 进入 Cloudflare Dashboard
2. 选择域名 →「DNS」
3. 添加记录：

| 字段   | 值                     |
| ---- | --------------------- |
| 类型   | `CNAME`               |
| 名称   | `@`                   |
| 目标   | `xxx.cloud.sealos.io` |
| 代理状态 | `DNS only`（灰色云朵）      |

### 9.3 验证 DNS 解析生效

等待 5-30 分钟 DNS 生效，然后在本地终端验证：

```bash
nslookup geiit.online
```

**预期输出**：

```
名称:    geiit.online
Aliases: geiit.online
Address:  Sealos的IP地址
```

> 如果仍显示旧地址（如 Railway），等待 DNS 缓存过期或刷新本地 DNS：
>
> - Windows：`ipconfig /flushdns`
> - Mac：`sudo dscacheutil -flushcache`

### 9.4 确认 SSL 证书

Sealos 会自动为自定义域名签发 Let's Encrypt SSL 证书：

1. 在应用详情页 →「网络」→「自定义域名」
2. 查看域名状态，应显示「证书已签发」或「HTTPS 已启用」
3. 证书签发通常需要 1-5 分钟

### 9.5 测试 HTTPS 访问

在浏览器访问：`https://geiit.online`

- 应看到前端登录页
- 浏览器地址栏应显示锁图标（HTTPS）
- 不应有证书错误

### 9.6 配置后端域名（可选）

> **反代模式下不需要后端域名**。只有需要直接访问后端 API（如调试、Webhook 回调）时才配置。

如需配置：

1. 在 `kb-qa-api` 应用 →「网络」→「自定义域名」
2. 添加域名：`api.geiit.online`
3. DNS 添加对应 CNAME 解析（指向 Sealos 提供的地址）

### 9.7 修改 EdgeOne CDN 配置（如使用）

如果之前使用了腾讯云 EdgeOne CDN：

1. 登录腾讯云 EdgeOne 控制台
2. 修改 `geiit.online` 的回源地址为 Sealos 提供的 CNAME 地址
3. 反代模式下可删除 `api.geiit.online` 的加速配置（不再需要）
4. 或保留 `api.geiit.online`，回源到 Sealos 后端公网地址

***

## Step 10：初始化超级管理员

> 全新部署需要创建管理员账号才能登录系统。

### 10.1 进入后端容器终端

1. 在 Sealos「应用管理」→点击 `kb-qa-api` 应用
2. 点击「终端」标签
3. 打开容器内终端

> 如果 Sealos 没有「终端」功能，可在 Sealos 桌面打开「终端」，通过 `kubectl exec` 进入容器：
>
> ```bash
> kubectl exec -it kb-qa-api-xxx -- /bin/bash
> ```

### 10.2 设置环境变量并执行创建命令

在容器终端执行：

```bash
# 设置管理员信息（替换为实际值）
export SUPERUSER_USERNAME=admin
export SUPERUSER_EMAIL=admin@geiit.online
export SUPERUSER_PASSWORD=YourSecure123

# 执行创建命令
python -m scripts.create_superuser
```

**预期输出**：

```
==========================================
  创建超级管理员
==========================================
用户名: admin
邮箱: admin@geiit.online
密码: ******（已隐藏）
✅ 超级管理员创建成功！
```

### 10.3 清除密码环境变量

创建完成后，清除密码变量避免泄露：

```bash
unset SUPERUSER_PASSWORD
exit
```

### 10.4 验证管理员账号

1. 在浏览器访问 `https://geiit.online`
2. 使用刚创建的管理员账号登录
3. 应成功登录并跳转到主页

***

## Step 11：验证部署

### 11.1 基础功能验证

访问 `https://geiit.online`，按以下清单验证：

| 序号 | 功能    | 操作步骤                         | 预期结果           |
| -- | ----- | ---------------------------- | -------------- |
| 1  | 首页加载  | 浏览器访问 `https://geiit.online` | 显示登录页，无报错      |
| 2  | 登录    | 输入管理员账号密码，点击登录               | 登录成功，跳转主页      |
| 3  | 文档列表  | 点击「文档管理」                     | 显示文档列表（空）      |
| 4  | 创建文件夹 | 点击新建文件夹，输入名称                 | 文件夹创建成功        |
| 5  | 上传文档  | 上传一个 PDF/DOCX/TXT 文件         | 上传成功，状态变为「已处理」 |
| 6  | 知识库问答 | 进入问答页面，提问                    | 流式回答正常显示       |
| 7  | 文档对话  | 上传文档进行对话                     | 流式回答正常         |
| 8  | 重新生成  | 点击 AI 回答下方的「重新生成」            | 重新生成新回答        |
| 9  | 登出    | 点击用户头像 → 登出                  | 返回登录页          |

### 11.2 国产浏览器兼容性验证

> **这是从 Railway 迁移到 Sealos 的核心目的**。

用以下浏览器测试登录和基础功能：

| 浏览器     | 测试设备  | 预期结果             |
| ------- | ----- | ---------------- |
| Chrome  | 桌面/手机 | ✅ 正常             |
| Edge    | 桌面    | ✅ 正常             |
| Firefox | 桌面    | ✅ 正常             |
| 夸克浏览器   | 手机    | ✅ 应正常（反代模式无跨域问题） |
| QQ 浏览器  | 手机/桌面 | ✅ 应正常            |
| 百度浏览器   | 手机    | ✅ 应正常            |

### 11.3 网络性能验证

#### 11.3.1 命令行测试延迟

```bash
curl -w "DNS解析: %{time_namelookup}s\nTCP连接: %{time_connect}s\nSSL握手: %{time_appconnect}s\n首字节: %{time_starttransfer}s\n总耗时: %{time_total}s\n" \
  -o /dev/null -s https://geiit.online/
```

**预期**（国内访问）：

- DNS 解析：< 0.05s
- TCP 连接：< 0.05s
- 首字节（TTFB）：< 0.5s
- 总耗时：< 1s

#### 11.3.2 API 响应测试

```bash
curl -w "\nHTTP状态: %{http_code}\n响应时间: %{time_total}s\n" \
  -s https://geiit.online/ready
```

**预期**：

```
{"status":"healthy"}
HTTP状态: 200
响应时间: < 0.5s
```

### 11.4 确认 API 走反代

打开浏览器 F12 开发者工具 → Network 面板：

1. 访问 `https://geiit.online` 并登录
2. 查看 Network 面板中的请求
3. 登录请求 URL 应为：`https://geiit.online/api/v1/auth/login`
   - ✅ 同源（`geiit.online`）
   - ❌ 不应该是 `api.geiit.online`（那是跨域模式）
4. 请求方法应为 `POST`，**不应有 OPTIONS 预检请求**

### 11.5 日志检查

#### 11.5.1 后端日志

在 Sealos `kb-qa-api` 应用 →「日志」标签，检查：

- ✅ 无 `ERROR` 级别日志
- ✅ 无 `Traceback` 错误
- ✅ 无 `CircuitBreakerOpenError`（熔断器未打开）
- ✅ 数据库连接正常（无 `could not connect to server`）

#### 11.5.2 前端日志

在 `kb-qa-frontend` 应用 →「日志」标签，检查：

- ✅ nginx 无 `502 Bad Gateway` 错误
- ✅ nginx 无 `504 Gateway Timeout` 错误
- ✅ 访问日志中 API 请求返回 200

### 11.6 浏览器控制台检查

打开 F12 → Console 面板，检查：

- ✅ 无 CSP（Content Security Policy）错误
- ✅ 无 CORS 错误
- ✅ 无 `Failed to fetch` 错误

***

## 常见问题排查

### Q0：应用一直处于 waiting 状态（镜像拉取失败）

**症状**：应用部署后一直显示 `waiting` / `Pending`，无法进入 `Running`

**原因**：Sealos 是国内平台，从 Docker Hub 拉取镜像会非常慢甚至超时，导致 Pod 卡在 `ImagePullBackOff` 状态。

**诊断**：

在 Sealos 桌面打开「终端」，执行：

```bash
kubectl get pods
kubectl describe pod <你的pod名字>
```

查看 Events 部分：

- `ImagePullBackOff` 或 `ErrImagePull` → 镜像拉取失败（最常见）
- `Insufficient cpu` 或 `Insufficient memory` → 资源不足
- `0/1 nodes are available` → 集群没有可用节点

**修复**：

1. **镜像拉取失败**（最常见）：
   - 在本地 `docker pull` 拉取镜像（本地配 Docker 加速器）
   - 重新 tag 并 `docker push` 到自己的阿里云 ACR
   - 在 Sealos 中改用 ACR 镜像地址
   - 详细步骤见 Step 3.2
2. **资源不足**：
   - 降低 CPU/内存配置
   - 或充值后申请更多配额
3. **无可用节点**：
   - 等待集群资源释放
   - 或联系 Sealos 官方

### Q1：数据库连接失败

**症状**：后端日志报 `could not connect to server: Connection refused`

**排查步骤**：

1. **检查 PostgreSQL 状态**：
   - 在 Sealos 应用管理，确认 `kb-qa-postgres` 状态为 `Running`
   - 如果不是，查看日志定位启动失败原因
2. **检查服务名**：
   - `DATABASE_URL` 中的主机名应为 `kb-qa-postgres`（应用名）
   - 不是 `localhost` 或 `127.0.0.1`
3. **检查密码**：
   - 密码是否正确
   - 密码特殊字符是否已 URL 编码
4. **测试网络连通性**：
   ```bash
   # 在 kb-qa-api 容器终端执行
   apt-get install -y postgresql-client
   psql "postgresql://postgres:密码@kb-qa-postgres:5432/kb_qa"
   ```
5. **检查命名空间**：
   - 确保后端应用和数据库在**同一命名空间**
   - Sealos 同命名空间下的应用才能通过服务名互访

### Q2：pgvector 扩展创建失败

**症状**：`CREATE EXTENSION vector` 报错 `ERROR: extension "vector" is not available`

**原因**：使用了原生 PostgreSQL 镜像，不含 pgvector

**修复**：

1. 删除当前 PostgreSQL 应用
2. 重新部署，使用镜像 `pgvector/pgvector:pg16`
3. 重新创建扩展

### Q3：前端访问 API 返回 502 Bad Gateway

**症状**：浏览器访问 `https://geiit.online/api/v1/...` 返回 502

**排查步骤**：

1. **检查后端状态**：
   - 确认 `kb-qa-api` 应用状态为 `Running`
   - 查看后端日志是否有启动错误
2. **检查 BACKEND\_URL**：
   - 前端环境变量 `BACKEND_URL` 应为 `http://kb-qa-api:8000`
   - 不含 `/api/v1` 后缀
3. **测试后端连通性**：
   ```bash
   # 在 kb-qa-frontend 容器终端执行
   curl http://kb-qa-api:8000/health
   ```
   应返回 `{"status":"healthy"}`
4. **检查端口**：
   - 后端容器端口应为 `8000`
   - `BACKEND_URL` 中的端口应与容器端口一致

**修复**：

- 如果内网服务名访问不通，改用后端公网域名
- 在 `kb-qa-api` 应用配置外网访问，获取公网地址
- 前端 `BACKEND_URL` 改为 `https://后端公网域名`

### Q4：SSE 流式问答不工作

**症状**：提问后无流式输出（打字机效果），等待后一次性返回完整内容

**原因**：nginx 或 CDN 缓冲了 SSE 响应

**修复**：

1. 确认 `nginx.conf` 中 `/api/` location 包含：
   ```nginx
   proxy_buffering off;
   proxy_cache off;
   proxy_read_timeout 300s;
   ```
   （项目已配置，如未修改应正常）
2. 如果使用 EdgeOne CDN，关闭对 `/api/` 路径的缓存：
   - EdgeOne 控制台 → 站点 → 缓存配置
   - 添加规则：路径 `/api/*` → 缓存行为「不缓存」

### Q5：文件上传失败（413）

**症状**：上传文件返回 `413 Request Entity Too Large`

**原因**：nginx 默认 `client_max_body_size` 为 1MB

**修复**：确认 `nginx.conf` 中有 `client_max_body_size 50m;`（项目已配置）

#### Q5.1：文件上传返回 500（Permission denied）

**症状**：网站能登录、文档列表正常，但上传文档返回 500，后端日志报：

```
文件上传写入失败: [Errno 13] Permission denied: './uploads/xxx.md'
POST /api/v1/documents/upload HTTP/1.1" 500 Internal Server Error
```

**原因**：Sealos 的存储卷（PVC）挂载到 `/app/uploads` 时，挂载点属主为 `root:root`（0755），
而应用以非 root 用户 `kbapp` 运行，无法在该目录写入文件。
这与本地 Docker 命名卷不同——本地 Docker 首次挂载时会继承镜像内目录的属主，
但 K8s 的 PVC 不会继承镜像权限。

**修复（推荐，长期有效）**：后端入口脚本 `entrypoint.sh` 已内置权限修复逻辑——
容器以 root 启动时先 `chown -R kbapp:kbapp /app/uploads /app/data`，再降权为 `kbapp` 运行应用。
只需**重新构建并推送后端镜像**（见 3.3 节）后重建 Sealos 后端应用即可。

**临时修复（不重新构建）**：删除后端应用上 `/app/uploads` 和 `/app/data` 两个存储挂载，
让容器使用镜像内置目录（`kbapp` 属主）。代价是容器重启后上传文件会丢失。

### Q6：本地 Embedding 模型下载失败

**症状**：后端日志报 `Failed to download model from HuggingFace`

**原因**：Sealos 容器无法访问 HuggingFace（海外）

**修复方案**：

**方案 1**：关闭本地 Embedding

```env
LOCAL_EMBEDDING_ENABLED=false
```

**方案 2**：使用 HuggingFace 镜像

```env
HF_ENDPOINT=https://hf-mirror.com
```

**方案 3**：确保在线 Embedding API（阿里云）可用，不依赖本地兜底

### Q7：邮件发送失败

**症状**：注册申请无邮件通知

**排查步骤**：

1. **检查 RESEND\_API\_KEY**：
   - 确认 Key 有效（格式：`re_xxxxx`）
   - 在 Resend 控制台查看 API 使用记录
2. **检查 EMAIL\_FROM 域名**：
   - 如果使用 `onboarding@resend.dev`，只能发到 Resend 注册邮箱
   - 发到其他邮箱需在 Resend 验证自有域名
3. **查看后端日志**：
   - 搜索 `email` 或 `resend` 相关日志
   - 查看具体错误信息

### Q8：CORS 错误

**症状**：浏览器控制台报 `Access to fetch at 'xxx' from origin 'yyy' has been blocked by CORS policy`

**修复**：

- 反代模式下**不应**出现 CORS 错误
- 如出现，检查请求 URL 是否为同源（`https://geiit.online/api/v1/...`）
- 如果仍需跨域访问，在后端 `CORS_ORIGINS` 添加前端域名

### Q9：数据库迁移失败

**症状**：后端启动时 `alembic upgrade head` 失败

**排查步骤**：

1. **确认 pgvector 扩展已创建**：
   ```sql
   SELECT extname FROM pg_extension WHERE extname = 'vector';
   ```
2. **确认 DATABASE\_URL 格式**：
   - 前缀必须是 `postgresql+psycopg://`
   - 不是 `postgresql://`（会使用 psycopg2）
3. **查看具体报错**：
   - 后端日志中搜索 `alembic` 或 `migration`
   - 常见错误：表已存在、列已存在（可忽略）、扩展缺失

### Q10：容器频繁重启（CrashLoopBackOff）

**症状**：应用状态反复在 `Running` 和 `CrashLoopBackOff` 之间切换

**排查步骤**：

1. **查看应用日志**定位启动失败原因
2. **常见原因**：
   - 环境变量缺失（如 `SECRET_KEY` 为空）
   - 数据库连接失败
   - 内存不足（OOM Killed）
   - 健康检查失败（启动太慢）
   - PostgreSQL 挂载点含 `lost+found`（见下方专项说明）
3. **修复建议**：
   - 补全缺失的环境变量
   - 增加 CPU/内存配额
   - 增加健康检查的「启动延迟」时间（如从 60s 改为 120s）

#### Q10.1：PostgreSQL 报 `directory exists but is not empty`（lost+found）

**症状**：PostgreSQL 容器日志报：

```
initdb: error: directory "/var/lib/postgresql/data" exists but is not empty
initdb: detail: It contains a lost+found directory, perhaps due to it being a mount point.
```

**原因**：存储卷挂载点根目录（ext4 文件系统）会自动生成 `lost+found` 目录，直接把卷挂载到 `/var/lib/postgresql/data` 时，initdb 认为数据目录非空而拒绝初始化。

**修复**：把存储卷挂载路径从 `/var/lib/postgresql/data` 改为父目录 `/var/lib/postgresql`。PostgreSQL 镜像的 entrypoint 会自动在挂载点下创建 `data` 子目录并初始化，避开 `lost+found` 问题。

### Q11：Redis 连接失败

**症状**：后端日志报 `redis.exceptions.ConnectionError`

**排查**：

1. 确认 Redis 应用状态为 `Running`
2. 确认 `REDIS_URL` 格式正确：`redis://:密码@kb-qa-redis:6379/0`
3. 密码前有冒号 `:`
4. 在容器终端测试：`redis-cli -h kb-qa-redis -p 6379 -a 密码 ping`

### Q12：DNS 解析未生效

**症状**：访问 `geiit.online` 仍显示旧站点（如 Railway）

**修复**：

1. 等待 DNS 缓存过期（通常 5-30 分钟）
2. 刷新本地 DNS：
   - Windows：`ipconfig /flushdns`
   - Mac：`sudo dscacheutil -flushcache`
3. 检查 DNS 记录是否正确：
   ```bash
   nslookup geiit.online
   ```
4. 确认 CNAME 记录指向 Sealos 提供的地址

***

## 附录 A：环境变量完整说明

### A.1 后端环境变量

#### 角色与环境

| 变量名                  | 必填 | 默认值             | 说明                                        |
| -------------------- | -- | --------------- | ----------------------------------------- |
| `ROLE`               | ✅  | `api`           | 启动角色：`api`/`api+worker`/`worker`/`flower` |
| `ENVIRONMENT`        | ✅  | `development`   | 运行环境：`production`/`staging`/`development` |
| `DEBUG`              | ❌  | `False`         | 调试模式（production 自动强制关闭）                   |
| `PORT`               | ✅  | `8000`          | 应用端口                                      |
| `MIGRATE_ON_STARTUP` | ✅  | `true`          | 启动时执行数据库迁移                                |
| `TZ`                 | ❌  | `Asia/Shanghai` | 时区                                        |

#### 数据库

| 变量名               | 必填 | 说明                                |
| ----------------- | -- | --------------------------------- |
| `DATABASE_URL`    | ✅  | 数据库连接（前缀 `postgresql+psycopg://`） |
| `DB_POOL_SIZE`    | ❌  | 连接池大小（默认 10）                      |
| `DB_MAX_OVERFLOW` | ❌  | 连接池溢出（默认 20）                      |

#### Redis

| 变量名                     | 必填 | 说明                  |
| ----------------------- | -- | ------------------- |
| `REDIS_URL`             | ✅  | Redis 连接（DB 0）      |
| `CELERY_BROKER_URL`     | ✅  | Celery Broker（DB 1） |
| `CELERY_RESULT_BACKEND` | ✅  | Celery 结果（DB 2）     |

#### CORS 与 JWT

| 变量名                           | 必填 | 说明                         |
| ----------------------------- | -- | -------------------------- |
| `CORS_ORIGINS`                | ✅  | CORS 白名单（JSON 数组）          |
| `SECRET_KEY`                  | ✅  | JWT 密钥（32+ 字符）             |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | ❌  | Access Token 有效期（默认 15 分钟） |
| `REFRESH_TOKEN_EXPIRE_DAYS`   | ❌  | Refresh Token 有效期（默认 7 天）  |

#### 邮件

| 变量名                  | 必填 | 说明                         |
| -------------------- | -- | -------------------------- |
| `EMAIL_ENABLED`      | ✅  | 启用邮件                       |
| `EMAIL_PROVIDER`     | ✅  | `http`（Resend API）或 `smtp` |
| `RESEND_API_KEY`     | ✅  | Resend API Key             |
| `EMAIL_FROM`         | ✅  | 发件人地址                      |
| `ADMIN_NOTIFY_EMAIL` | ✅  | 管理员通知邮箱                    |
| `FRONTEND_BASE_URL`  | ✅  | 前端地址（用于邮件链接）               |

#### LLM

| 变量名                           | 必填 | 说明                   |
| ----------------------------- | -- | -------------------- |
| `OPENAI_API_KEY`              | ✅  | 主 LLM API Key        |
| `OPENAI_API_BASE`             | ✅  | LLM API 地址           |
| `LLM_MODEL_NAME`              | ✅  | 主模型名                 |
| `LLM_FALLBACK_MODEL_NAME`     | ❌  | 降级模型名                |
| `EMBEDDING_MODEL_NAME`        | ✅  | Embedding 模型名        |
| `EMBEDDING_DIMENSION`         | ✅  | 向量维度（必须 1536）        |
| `LLM_FALLBACK_API_KEY`        | ❌  | 降级 LLM API Key       |
| `LLM_FALLBACK_API_BASE`       | ❌  | 降级 LLM API 地址        |
| `EMBEDDING_FALLBACK_API_KEY`  | ❌  | 降级 Embedding API Key |
| `EMBEDDING_FALLBACK_API_BASE` | ❌  | 降级 Embedding API 地址  |

### A.2 前端环境变量

| 变量名           | 必填 | 说明                                |
| ------------- | -- | --------------------------------- |
| `BACKEND_URL` | ✅  | 后端地址（反代用，`http://kb-qa-api:8000`） |
| `PORT`        | ✅  | nginx 监听端口（`80`）                  |

***

## 附录 B：Sealos 常用操作

### B.1 查看应用日志

1. 应用详情页 →「日志」标签
2. 支持实时查看和历史日志搜索
3. 可选择容器（多副本时）

### B.2 进入容器终端

1. 应用详情页 →「终端」标签
2. 可执行任意 shell 命令
3. 适合调试和执行一次性命令

### B.3 修改环境变量

1. 应用详情页 →「环境变量」标签
2. 修改或添加变量
3. 点击「保存」后应用会自动重启

### B.4 扩缩容

1. 应用详情页 →「扩缩容」
2. 修改副本数或 CPU/内存配额
3. 保存后自动应用

### B.5 重启应用

1. 应用详情页 →「重启」按钮
2. 或修改环境变量后自动重启

### B.6 查看应用公网地址

1. 应用详情页 →「网络」标签
2. 查看外网访问地址

### B.7 删除应用

1. 应用详情页 →「删除」
2. 注意：删除后数据卷也会删除，请先备份

### B.8 查看费用

1. Sealos 桌面 →「费用中心」
2. 查看余额、消费记录和资源使用情况

***

## 附录 C：部署完成检查清单

### C.1 基础设施

- [ ] Sealos 账号已注册并充值
- [ ] 阿里云 ACR 镜像仓库已创建（`kb-qa-backend` + `kb-qa-frontend`）
- [ ] PostgreSQL 实例运行正常（`kb-qa-postgres` 状态 `Running`）
- [ ] pgvector 扩展已创建（`SELECT extname FROM pg_extension;` 验证）
- [ ] pg\_trgm 扩展已创建
- [ ] Redis 实例运行正常（`kb-qa-redis` 状态 `Running`）

### C.2 镜像构建

- [ ] 后端镜像已构建并推送到 ACR
- [ ] 前端镜像已构建并推送到 ACR
- [ ] ACR 控制台确认两个镜像 `latest` 版本可用

### C.3 后端部署

- [ ] `kb-qa-api` 应用状态为 `Running`
- [ ] 环境变量配置完整（`ROLE`、`DATABASE_URL`、`REDIS_URL`、`SECRET_KEY` 等）
- [ ] 存储已挂载（`/app/uploads` + `/app/data`）
- [ ] 存活检查 `/live`、就绪检查 `/ready` 分开配置（端口 8000）
- [ ] 日志显示数据库迁移完成
- [ ] 日志显示 FastAPI 启动成功
- [ ] 日志显示 Celery Worker 启动成功

### C.4 前端部署

- [ ] `kb-qa-frontend` 应用状态为 `Running`
- [ ] `BACKEND_URL` 环境变量配置正确
- [ ] 健康检查配置正确（`/` 端口 80）
- [ ] 日志显示 nginx 启动成功
- [ ] 日志显示后端代理地址正确

### C.5 域名与 SSL

- [ ] DNS CNAME 记录已添加（指向 Sealos 地址）
- [ ] DNS 解析已生效（`nslookup geiit.online` 验证）
- [ ] Sealos 自定义域名已配置
- [ ] SSL 证书已自动签发
- [ ] HTTPS 访问正常（浏览器显示锁图标）

### C.6 功能验证

- [ ] 浏览器访问 `https://geiit.online` 显示登录页
- [ ] 超级管理员账号已创建
- [ ] 管理员登录成功
- [ ] 文档上传功能正常
- [ ] 知识库问答功能正常（流式输出）
- [ ] 文档对话功能正常
- [ ] 重新生成功能正常
- [ ] 登出功能正常

### C.7 浏览器兼容性

- [ ] Chrome 正常
- [ ] Edge 正常
- [ ] 夸克浏览器正常
- [ ] QQ 浏览器正常
- [ ] 百度浏览器正常

### C.8 性能验证

- [ ] 首页 TTFB < 1s
- [ ] API 响应时间 < 0.5s
- [ ] 无 CSP/CORS 错误
- [ ] 无 502/504 错误

### C.9 监控与维护

- [ ] 已设置费用告警
- [ ] 定期查看应用日志
- [ ] 定期检查资源使用情况
- [ ] 已了解回滚方案

***

## 完成

部署完成后，建议：

1. **观察 1-2 天**：监控应用日志和资源使用情况
2. **调整资源配额**：根据实际使用情况调整 CPU/内存，避免浪费
3. **配置告警**：在 Sealos 费用中心设置余额告警
4. **定期备份**：定期导出 PostgreSQL 数据
5. **关注 Sealos 活动**：常有优惠，可降低成本

如有问题，参考「常见问题排查」或查看 Sealos 官方文档：<https://sealos.io/docs/>
