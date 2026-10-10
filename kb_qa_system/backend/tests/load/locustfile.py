"""
Locust 压测脚本 — GeiIt企业知识库

作用：
    对 GeiIt企业知识库后端 API 进行负载测试，验证系统在高并发场景下的
    稳定性和响应速度。提供 4 个压测场景，覆盖只读、问答、混合读写等典型业务路径。

使用方式：
    1. 安装 locust：pip install locust
    2. 准备测试账号（通过前端注册或 create_superuser 脚本创建）
    3. 设置环境变量（TARGET_HOST、TEST_USERNAME 等）
    4. 运行：locust -f locustfile.py
    5. 浏览器访问 http://localhost:8089 配置并发数并启动压测

环境变量：
    TARGET_HOST           — 目标地址（默认 http://localhost:8000）
    TEST_USERNAME         — 测试账号用户名（只读/问答场景）
    TEST_PASSWORD         — 测试账号密码
    TEST_USER2_USERNAME   — 第二个测试账号用户名（混合读写场景，可选）
    TEST_USER2_PASSWORD   — 第二个测试账号密码

注意事项：
    - 登录限流 5次/分钟，因此登录放在 on_start 中（每个虚拟用户仅登录一次）
    - 提问限流 20次/分钟，QAUser 的 wait_time 设为 3-5 秒避免触发限流
    - 上传限流 20次/小时，MixedUser 的上传操作频率较低
    - 提问会消耗 LLM Token，长时间压测注意 API 成本
    - Worker 服务必须正常运行，否则文档上传后无法处理

参考文档：
    - 10D 审查报告 D4-01：建议使用本脚本建立性能基线
    - 系统限流配置见 .env.example
"""

import os
import io
import logging
from typing import Optional

from locust import HttpUser, StopUser, task, between

# ============================================
# 配置（从环境变量读取）
# ============================================

TARGET_HOST: str = os.getenv("TARGET_HOST", "http://localhost:8000")
TEST_USERNAME: str = os.getenv("TEST_USERNAME", "testuser")
TEST_PASSWORD: str = os.getenv("TEST_PASSWORD", "Test1234")
TEST_USER2_USERNAME: str = os.getenv("TEST_USER2_USERNAME", "testuser2")
TEST_USER2_PASSWORD: str = os.getenv("TEST_USER2_PASSWORD", "Test1234")
REQUEST_TIMEOUT_SECONDS = float(os.getenv("LOCUST_REQUEST_TIMEOUT_SECONDS", "20"))
ALLOW_MUTATIONS = os.getenv("ALLOW_MUTATIONS", "false").lower() == "true"
ENABLE_LLM_TRAFFIC = os.getenv("ENABLE_LLM_TRAFFIC", "false").lower() == "true"

# API 前缀
API_PREFIX: str = "/api/v1"

# 模块日志器
logger = logging.getLogger(__name__)


# ============================================
# 辅助函数
# ============================================

def login_and_get_token(client, username: str, password: str) -> Optional[str]:
    """
    登录并获取 Access Token

    作用：
        调用 /api/v1/auth/login 接口，使用用户名密码登录，
        返回 JWT Access Token 用于后续请求的 Authorization 头。

    参数：
        client: locust HttpSession 实例
        username: str — 用户名
        password: str — 密码

    返回：
        Optional[str] — Access Token 字符串，登录失败返回 None
    """
    with client.post(
        f"{API_PREFIX}/auth/login",
        json={"username": username, "password": password},
        name="登录",
        catch_response=True,
    ) as response:
        if response.status_code == 200:
            try:
                token = response.json().get("access_token")
            except (ValueError, AttributeError):
                token = None
            if token:
                response.success()
                return token
        response.failure(f"登录失败：HTTP {response.status_code}")
    return None


def configure_request_timeout(client) -> None:
    original_request = client.request

    def request_with_timeout(method, url, **kwargs):
        kwargs.setdefault("timeout", REQUEST_TIMEOUT_SECONDS)
        return original_request(method, url, **kwargs)

    client.request = request_with_timeout


# ============================================
# 场景 1：健康检查用户（基线测试）
# ============================================

class HealthCheckUser(HttpUser):
    """
    健康检查场景用户

    作用：
        仅访问 /health 端点，验证服务在并发下的存活性和响应速度。
        作为基线测试，不涉及业务逻辑，不消耗 LLM Token。

    使用场景：
        验证服务部署后的基本可用性
        测量最简请求的延迟基线（网络 + 中间件 + 健康检查逻辑）

    运行方式：
        locust -f locustfile.py HealthCheckUser
    """

    # 目标地址
    host = TARGET_HOST
    # 等待时间：0.5-1 秒（健康检查频率可较高）
    wait_time = between(0.5, 1)

    @task
    def check_health(self) -> None:
        """
        访问健康检查端点

        作用：
            GET /health，验证 API + 数据库 + Redis 连通性。
            预期响应 200，status=healthy。
        """
        with self.client.get("/health", name="健康检查", catch_response=True) as response:
            if response.status_code == 200:
                data = response.json()
                if data.get("status") == "healthy":
                    response.success()
                else:
                    response.failure(f"服务降级: status={data.get('status')}")
            else:
                response.failure(f"健康检查失败: HTTP {response.status_code}")


# ============================================
# 场景 2：只读用户（读密集型）
# ============================================

class ReadOnlyUser(HttpUser):
    """
    只读场景用户

    作用：
        模拟用户浏览文档列表、查看统计、查看对话历史等只读操作。
        不涉及写入和 LLM 调用，测试数据库查询和缓存性能。

    业务路径：
        登录 → 获取用户信息 → 浏览文档列表 → 查看文档统计 → 查看对话列表

    使用场景：
        测量文档列表分页查询性能
        测量统计聚合查询性能
        验证缓存命中效果

    运行方式：
        locust -f locustfile.py ReadOnlyUser
    """

    host = TARGET_HOST
    # 等待时间：1-3 秒（模拟用户浏览间隔）
    wait_time = between(1, 3)

    def on_start(self) -> None:
        """
        虚拟用户启动时登录

        作用：
            每个虚拟用户启动时登录一次获取 Token，后续请求复用。
            登录限流 5次/分钟，因此不在 task 中重复登录。
        """
        configure_request_timeout(self.client)
        self.token: Optional[str] = login_and_get_token(
            self.client, TEST_USERNAME, TEST_PASSWORD
        )
        if self.token:
            self.auth_headers = {"Authorization": f"Bearer {self.token}"}
        else:
            raise StopUser()

    @task(3)
    def list_documents(self) -> None:
        """
        浏览文档列表

        作用：
            GET /api/v1/documents?page=1&page_size=20
            测量文档列表分页查询性能。
        """
        self.client.get(
            f"{API_PREFIX}/documents?page=1&page_size=20",
            headers=self.auth_headers,
            name="文档列表",
        )

    @task(2)
    def get_document_stats(self) -> None:
        """
        查看文档统计

        作用：
            GET /api/v1/documents/stats/overview
            测量统计聚合查询性能。
        """
        self.client.get(
            f"{API_PREFIX}/documents/stats/overview",
            headers=self.auth_headers,
            name="文档统计",
        )

    @task(2)
    def list_conversations(self) -> None:
        """
        查看对话列表

        作用：
            GET /api/v1/chat/conversations?page=1&page_size=20
            测量对话列表查询性能。
        """
        self.client.get(
            f"{API_PREFIX}/chat/conversations?page=1&page_size=20",
            headers=self.auth_headers,
            name="对话列表",
        )

    @task(1)
    def get_user_info(self) -> None:
        """
        获取当前用户信息

        作用：
            GET /api/v1/auth/me
            测量 JWT 解析和用户查询性能。
        """
        self.client.get(
            f"{API_PREFIX}/auth/me",
            headers=self.auth_headers,
            name="用户信息",
        )


# ============================================
# 场景 3：问答用户（RAG 链路压测）
# ============================================

class QAUser(HttpUser):
    """
    问答场景用户

    作用：
        模拟用户提问，压测 RAG 全链路（检索 → 重排序 → LLM 生成）。
        这是最核心的性能测试场景，涉及向量检索、LLM 调用等耗时操作。

    业务路径：
        登录 → 提问 → 查看对话列表

    使用场景：
        测量 RAG 端到端延迟（检索 + 生成）
        验证 LLM 熔断器在高负载下的行为
        测试 FAQ 缓存命中率对延迟的影响

    注意事项：
        - 提问限流 20次/分钟，wait_time 设为 3-5 秒避免限流
        - 每次提问消耗 LLM Token，长时间压测注意 API 成本
        - 需要先上传文档并处理完成，否则检索无结果

    运行方式：
        locust -f locustfile.py QAUser
    """

    host = TARGET_HOST
    # 等待时间：3-5 秒（避免触发提问限流 20次/分钟）
    wait_time = between(3, 5)

    # 测试问题集（循环使用）
    QUESTIONS: list[str] = [
        "这个系统的功能有哪些？",
        "如何上传文档？",
        "支持哪些文件格式？",
        "文档处理流程是什么？",
        "如何注册账号？",
    ]

    def on_start(self) -> None:
        """
        虚拟用户启动时登录

        作用：
            登录获取 Token，初始化问题计数器。
        """
        configure_request_timeout(self.client)
        if not ENABLE_LLM_TRAFFIC:
            logger.warning("QAUser 已停止：设置 ENABLE_LLM_TRAFFIC=true 才会产生模型请求")
            raise StopUser()
        self.token: Optional[str] = login_and_get_token(
            self.client, TEST_USERNAME, TEST_PASSWORD
        )
        if self.token:
            self.auth_headers = {"Authorization": f"Bearer {self.token}"}
        else:
            raise StopUser()
        self._question_index: int = 0

    @task(3)
    def ask_question(self) -> None:
        """
        提交提问

        作用：
            POST /api/v1/chat/ask
            触发 RAG 全链路：检索 → 重排序 → LLM 生成。
            非流式模式，等待完整响应。

        注意：
            响应时间可能较长（5-30 秒），取决于 LLM 服务和知识库大小。
            超时时间设为 60 秒。
        """
        question = self.QUESTIONS[self._question_index % len(self.QUESTIONS)]
        self._question_index += 1

        with self.client.post(
            f"{API_PREFIX}/chat/ask",
            json={"question": question, "stream": False},
            headers=self.auth_headers,
            name="提问（RAG链路）",
            catch_response=True,
        ) as response:
            if response.status_code == 200:
                data = response.json()
                # 检查是否有有效回答
                answer = data.get("answer") or data.get("content")
                if answer:
                    response.success()
                else:
                    response.failure("回答为空")
            elif response.status_code == 429:
                response.failure("触发限流，降低并发或增加等待时间")
            elif response.status_code == 503:
                response.failure("服务降级（LLM 熔断或不可用）")
            else:
                response.failure(f"提问失败: HTTP {response.status_code}")

    @task(1)
    def list_conversations(self) -> None:
        """
        查看对话列表

        作用：
            GET /api/v1/chat/conversations
            辅助操作，测量对话列表查询性能。
        """
        self.client.get(
            f"{API_PREFIX}/chat/conversations?page=1&page_size=10",
            headers=self.auth_headers,
            name="对话列表",
        )


# ============================================
# 场景 4：混合读写用户
# ============================================

class MixedUser(HttpUser):
    """
    混合读写场景用户

    作用：
        模拟用户的完整操作流程：上传文档 → 浏览 → 提问 → 删除文档。
        覆盖读写混合场景，测试系统在数据变更下的稳定性和一致性。

    业务路径：
        登录 → 上传文档 → 浏览列表 → 提问 → 删除文档（循环）

    使用场景：
        测量文档上传和 Celery 任务投递性能
        验证文档删除的级联清理（chunks、向量等）
        测试读写并发下的数据一致性

    注意事项：
        - 上传限流 20次/小时，上传操作权重较低
        - 上传后文档处理是异步的，提问可能在文档未处理完成时执行
        - 删除文档会级联删除分块和向量
        - 使用内存生成的小 txt 文件上传，避免大文件 IO 瓶颈

    运行方式：
        locust -f locustfile.py MixedUser
    """

    host = TARGET_HOST
    # 等待时间：2-4 秒
    wait_time = between(2, 4)

    def on_start(self) -> None:
        """
        虚拟用户启动时登录

        作用：
            使用第二个测试账号登录（避免与只读/问答场景账号冲突）。
        """
        configure_request_timeout(self.client)
        self._created_document_ids: list[int] = []
        self.token: Optional[str] = login_and_get_token(
            self.client, TEST_USER2_USERNAME, TEST_USER2_PASSWORD
        )
        if self.token:
            self.auth_headers = {"Authorization": f"Bearer {self.token}"}
        else:
            raise StopUser()

    @task(1)
    def upload_document(self) -> None:
        """
        上传文档

        作用：
            POST /api/v1/documents/upload
            上传一个内存生成的小 txt 文件，测试文档上传和任务投递性能。

        注意：
            上传限流 20次/小时，权重设为最低。
            文件内容为简单的测试文本，避免大文件传输耗时。
        """
        if not ALLOW_MUTATIONS:
            return

        # 生成内存测试文件（避免磁盘 IO）
        file_content = "这是一个压测测试文档。\n" * 20
        file_data = io.BytesIO(file_content.encode("utf-8"))

        with self.client.post(
            f"{API_PREFIX}/documents/upload",
            files={"file": ("loadtest_test.txt", file_data, "text/plain")},
            headers=self.auth_headers,
            name="上传文档",
            catch_response=True,
        ) as response:
            if response.status_code in (200, 201):
                try:
                    data = response.json()
                    document_id = data.get("id") or data.get("document", {}).get("id")
                    if document_id:
                        self._created_document_ids.append(int(document_id))
                except (ValueError, AttributeError, TypeError):
                    pass
                response.success()
            elif response.status_code == 429:
                response.failure("上传触发限流（20次/小时）")
            else:
                response.failure(f"上传失败: HTTP {response.status_code}")

    @task(3)
    def list_documents(self) -> None:
        """
        浏览文档列表

        作用：
            GET /api/v1/documents
            测量文档列表查询性能。
        """
        self.client.get(
            f"{API_PREFIX}/documents?page=1&page_size=20",
            headers=self.auth_headers,
            name="文档列表",
        )

    @task(2)
    def ask_question(self) -> None:
        """
        提交提问

        作用：
            POST /api/v1/chat/ask
            简单提问，测试 RAG 链路。
        """
        if not ENABLE_LLM_TRAFFIC:
            return
        with self.client.post(
            f"{API_PREFIX}/chat/ask",
            json={"question": "测试问题", "stream": False},
            headers=self.auth_headers,
            name="提问",
            catch_response=True,
        ) as response:
            if response.status_code == 200:
                response.success()
            elif response.status_code == 429:
                response.failure("提问触发限流")
            else:
                response.failure(f"提问失败: HTTP {response.status_code}")

    @task(1)
    def delete_document(self) -> None:
        """
        删除文档

        作用：
            DELETE /api/v1/documents/{document_id}
            先获取文档列表，删除第一个文档，测试级联删除性能。

        注意：
            如果没有文档则跳过。
        """
        if not ALLOW_MUTATIONS or not self._created_document_ids:
            return
        doc_id = self._created_document_ids.pop(0)
        self.client.delete(
            f"{API_PREFIX}/documents/{doc_id}",
            headers=self.auth_headers,
            name="删除本用户创建的压测文档",
        )
