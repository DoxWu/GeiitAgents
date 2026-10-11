"""
模型服务健康检查器

作用：
    定期主动探测各模型端点可用性，提前发现故障。

核心设计原则（关键）：
    主动健康检查的结果不直接参与路由决策！
    探测成功 → breaker.record_success()
    探测失败 → breaker.record_failure()
    路由仍 100% 基于 breaker 状态。
    这样避免"主动检查误报 → 误切降级"的问题。

    主动探测的价值：在真实请求到来前，提前累计 breaker 失败计数，
    使故障服务更快达到熔断阈值（而非等到真实请求连续失败才熔断）。

实现方式：
    - 后台 asyncio Task，周期性调用各 client 的 health_probe()
    - 仅对 config.health_check.enabled=true 的端点探测
    - 按各端点的 interval 分别调度（不同端点可不同频率）
    - 探测超时由 config.health_check.timeout 控制

启动方式：
    在 FastAPI lifespan 中调用 start()，应用关闭时调用 stop()。
"""

import asyncio
import logging
import time
from typing import Optional

from app.core.model_provider.base import BaseModelClient
from app.core.model_provider.diagnostics import safe_error_label
from app.core.model_provider.call_logger import get_call_logger
from app.core.model_provider.registry import ModelServiceRegistry

logger = logging.getLogger(__name__)


class HealthChecker:
    """
    模型服务健康检查器

    作用：
        后台定时探测各模型端点可用性。
        探测结果喂入熔断器（不直接参与路由）。

    生命周期：
        - start(): 启动后台 asyncio Task
        - stop(): 取消 Task 并等待退出
        - 在 FastAPI lifespan 中管理

    使用方式：
        checker = HealthChecker(registry)
        await checker.start()  # 在 lifespan 启动时
        ...
        await checker.stop()   # 在 lifespan 关闭时
    """

    def __init__(self, registry: ModelServiceRegistry):
        """
        初始化健康检查器

        参数：
            registry: ModelServiceRegistry - 客户端注册表
        """
        self._registry = registry
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._stopped = False  # 优化3：防止 stop 后 fire-and-forget 的 start 延迟执行导致 Task 泄漏
        self._call_logger = get_call_logger()

    async def start(self) -> None:
        """
        启动后台健康检查任务

        作用：
            创建 asyncio Task 运行健康检查主循环。
            如果已有任务在运行则不重复创建。
        """
        # 优化3：防止 stop() 后 fire-and-forget 的 start() 延迟执行
        if self._stopped:
            logger.warning("健康检查器已停止，拒绝再次启动")
            return
        if self._running:
            logger.warning("健康检查器已在运行，跳过重复启动")
            return

        self._running = True
        self._task = asyncio.create_task(self._run_loop())
        logger.info("模型服务健康检查器已启动")

    async def stop(self) -> None:
        """
        停止健康检查

        作用：
            设置运行标志为 False，取消 Task 并等待退出。
        """
        self._running = False
        self._stopped = True  # 优化3：标记永久停止，防止延迟的 start() 创建新 Task
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("模型服务健康检查器已停止")

    async def _run_loop(self) -> None:
        """
        健康检查主循环

        作用：
            按各端点的 interval 分别调度探测任务。
            使用最小 interval 作为循环周期，各端点按自身 interval 决定是否探测。

        实现方式：
            1. 每 10 秒检查一次（最小粒度）
            2. 对每个端点，检查距上次探测是否超过其 interval
            3. 超过则发起探测
        """
        # 记录各端点的上次探测时间
        # 作用：支持不同端点不同探测频率
        last_probe_times: dict[str, float] = {}

        while self._running:
            try:
                # 获取所有需探测的端点
                probe_targets = self._get_probe_targets()

                if not probe_targets:
                    # 无需探测的端点，等待较长时间再检查
                    await asyncio.sleep(30)
                    continue

                # 找最小 interval 作为本次等待时间
                now = time.time()
                min_wait = 30  # 默认最多等 30 秒
                probes_to_run = []

                for key, client in probe_targets.items():
                    interval = client.config.health_check.interval
                    last_time = last_probe_times.get(key, 0)
                    elapsed = now - last_time

                    if elapsed >= interval:
                        probes_to_run.append((key, client))
                        last_probe_times[key] = now
                    else:
                        # 计算还需等多久
                        remaining = interval - elapsed
                        min_wait = min(min_wait, remaining)

                # 并发执行探测
                if probes_to_run:
                    await asyncio.gather(
                        *[self._probe_client(key, client) for key, client in probes_to_run],
                        return_exceptions=True,
                    )

                # 等待下一轮
                await asyncio.sleep(max(min_wait, 5))

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("健康检查循环异常: %s", safe_error_label(e))
                await asyncio.sleep(30)

    def _get_probe_targets(self) -> dict:
        """
        获取所有需主动探测的端点

        作用：
            遍历注册表，筛选出 health_check.enabled=true 的端点。

        返回:
            dict - {f"{model_type}:{name}": client}
        """
        targets = {}
        for model_type in ["llm", "embedding", "vision"]:
            for client in self._registry.get_clients(model_type):
                if client.config.health_check.enabled:
                    key = f"{model_type}:{client.name}"
                    targets[key] = client
        return targets

    async def _probe_client(self, key: str, client: BaseModelClient) -> None:
        """
        探测单个客户端

        作用：
            调用 client.health_probe()，记录日志。
            探测结果由 client 内部喂入熔断器。

        参数：
            key: str - 端点标识（"{model_type}:{name}"）
            client: BaseModelClient - 客户端实例
        """
        start_time = time.time()
        try:
            success = await client.health_probe()
            duration_ms = int((time.time() - start_time) * 1000)

            self._call_logger.log_health_probe(
                model_type=client.model_type,
                provider_name=client.name,
                success=success,
                duration_ms=duration_ms,
            )
        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            logger.error("[%s] 健康探测异常: %s", key, safe_error_label(e))
            self._call_logger.log_health_probe(
                model_type=client.model_type,
                provider_name=client.name,
                success=False,
                duration_ms=duration_ms,
            )
