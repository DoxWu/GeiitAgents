"""
Prometheus 指标定义模块

作用：
    集中定义所有 Prometheus 监控指标，包括：
    1. HTTP 层指标：请求总数、延迟、在途请求数（由中间件自动采集）
    2. RAG 链路指标：检索耗时/结果数/分数、LLM 耗时/Token/重试、降级/校验拦截/矛盾检测
    3. 文档处理指标：上传数、分块数
    4. 系统信息指标：应用版本、环境

    同时提供 record_rag_metrics 辅助函数，统一 RAG 指标记录逻辑，
    避免 rag_chain.py 中重复编写指标记录代码。

实现方式：
    - 使用 prometheus_client 库的 Counter / Histogram / Gauge / Info 类型
    - 指标名遵循 Prometheus 命名规范（snake_case，带 _total/_seconds 后缀）
    - 标签（label）用于维度切分，但控制基数避免内存爆炸
    - 全局单例指标对象，模块加载时创建

使用方式：
    from app.core.prometheus_metrics import (
        http_requests_total,
        record_rag_metrics,
    )

    # 记录 HTTP 请求
    http_requests_total.labels(method="GET", endpoint="/health", status="200").inc()

    # 记录 RAG 指标
    record_rag_metrics(metrics_dict, intent_type="kb_query", retrieval_happened=True)
"""

import logging
from typing import Dict, Any, Optional

from prometheus_client import (
    Counter,
    Histogram,
    Gauge,
    Info,
    generate_latest,
    CONTENT_TYPE_LATEST,
    REGISTRY,
)

from app.core.config import settings

logger = logging.getLogger(__name__)


# ============================================
# 指标开关检查
# ============================================

def is_prometheus_enabled() -> bool:
    """
    检查 Prometheus 是否启用

    作用：
        所有指标记录操作前检查此开关，关闭时跳过避免无效计算。
        中间件、路由、埋点代码都应调用此函数判断是否记录。
    """
    return settings.ENABLE_PROMETHEUS


# ============================================
# HTTP 层指标（由 PrometheusMiddleware 自动采集）
# ============================================

# HTTP 请求总数
# 作用：统计各接口的请求量，用于流量监控和异常检测
# 标签：method（GET/POST等）、endpoint（模板化路径）、status（HTTP状态码）
http_requests_total = Counter(
    "http_requests_total",
    "Total HTTP requests processed",
    ["method", "endpoint", "status"],
)

# HTTP 请求延迟分布
# 作用：监控各接口响应时间，P99/P95 分位值用于 SLA 评估
# buckets 覆盖 10ms~30s，适配从健康检查到 LLM 流式的全场景
http_request_duration_seconds = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds",
    ["method", "endpoint"],
    buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
)

# 在途 HTTP 请求数
# 作用：监控当前正在处理的请求数，用于并发量评估和过载告警
http_requests_in_progress = Gauge(
    "http_requests_in_progress",
    "Number of HTTP requests currently in progress",
)

http_streams_in_progress = Gauge(
    "http_streams_in_progress",
    "Number of streaming HTTP responses currently being delivered",
    ["endpoint"],
)
http_stream_duration_seconds = Histogram(
    "http_stream_duration_seconds",
    "Time from request start until a streaming response is fully delivered",
    ["endpoint", "status"],
    buckets=[0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0],
)
http_stream_first_event_seconds = Histogram(
    "http_stream_first_event_seconds",
    "Time from request start until the first non-empty streaming response body",
    ["endpoint"],
    buckets=[0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0],
)
http_stream_cancelled_total = Counter(
    "http_stream_cancelled_total",
    "Streaming responses interrupted before the final body event",
    ["endpoint"],
)


# ============================================
# RAG 链路指标（由 rag_chain.py 主动埋点）
# ============================================

# 问答总数
# 作用：统计问答请求量，按意图类型和流式/非流式维度切分
# 标签：intent_type（kb_query/chitchat/followup/meta）、stream（true/false）
rag_questions_total = Counter(
    "rag_questions_total",
    "Total questions processed by RAG pipeline",
    ["intent_type", "stream"],
)

# RAG 总处理耗时
# 作用：监控从接收到问题到返回答案的全链路耗时
# buckets 覆盖 0.5s~60s，适配从闲聊到复杂检索+生成的全场景
rag_total_duration_seconds = Histogram(
    "rag_total_duration_seconds",
    "Total RAG question processing time (retrieval + generation)",
    ["intent_type"],
    buckets=[0.5, 1.0, 2.0, 3.0, 5.0, 10.0, 20.0, 30.0, 60.0],
)

# 检索耗时
# 作用：监控向量检索性能，定位检索瓶颈
rag_retrieval_duration_seconds = Histogram(
    "rag_retrieval_duration_seconds",
    "Document retrieval time (vector search + reranking)",
    buckets=[0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0],
)

# 检索结果数分布
# 作用：监控检索召回量，判断知识库覆盖是否充足
rag_retrieval_results_count = Histogram(
    "rag_retrieval_results_count",
    "Number of documents retrieved per query",
    buckets=[0, 1, 2, 3, 4, 5, 8, 10, 16, 32],
)

# 检索最高分分布
# 作用：监控检索质量，分数持续偏低说明知识库内容与用户问题不匹配
# buckets 按 SIMILARITY_THRESHOLD（0.5）为分界设计
rag_retrieval_top_score = Histogram(
    "rag_retrieval_top_score",
    "Top similarity score of retrieved documents",
    buckets=[0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
)

# LLM 生成耗时
# 作用：监控 LLM 调用性能，区分流式首字延迟和总生成时间
rag_llm_duration_seconds = Histogram(
    "rag_llm_duration_seconds",
    "LLM generation time",
    buckets=[0.5, 1.0, 2.0, 3.0, 5.0, 10.0, 20.0, 30.0, 60.0],
)

# LLM Token 使用总量
# 作用：监控 Token 消耗，用于成本控制和预算告警
# 标签：direction（input/output）
rag_llm_tokens_total = Counter(
    "rag_llm_tokens_total",
    "Total LLM tokens consumed",
    ["direction"],
)

# LLM 重试次数
# 作用：监控 LLM 调用稳定性，重试频繁说明上游服务不稳定
rag_llm_retries_total = Counter(
    "rag_llm_retries_total",
    "Total LLM retry attempts",
)

# 降级响应总数
# 作用：监控服务降级频率，降级率高说明 LLM 服务不稳定或配置有问题
# 标签：reason（circuit_open/llm_unavailable/unknown_error/skipped）
rag_degradation_total = Counter(
    "rag_degradation_total",
    "Total degraded responses (fallback used)",
    ["reason"],
)

# 预生成校验拦截总数
# 作用：监控检索质量不足导致跳过生成的频率，判断知识库覆盖是否充足
rag_validation_skipped_total = Counter(
    "rag_validation_skipped_total",
    "Total pre-generation validation skips (low quality retrieval)",
)

# 矛盾检测命中总数
# 作用：监控知识库内容冲突频率，冲突多说明需要清洗或更新文档
rag_conflict_detected_total = Counter(
    "rag_conflict_detected_total",
    "Total conflicts detected in retrieval results",
)


# ============================================
# 文档处理指标（由 documents 路由/流水线埋点）
# ============================================

# 文档上传总数
# 作用：统计文档入库量，按文件类型维度切分
# 标签：file_type（pdf/md/docx/txt 等）
document_uploads_total = Counter(
    "document_uploads_total",
    "Total document uploads",
    ["file_type"],
)

# 文档处理耗时
# 作用：监控文档解析+分块+向量化的全流程耗时
document_processing_duration_seconds = Histogram(
    "document_processing_duration_seconds",
    "Document processing time (parse + chunk + embed)",
    buckets=[1.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0],
)

# 文档分块创建总数
# 作用：统计知识库 chunk 总量，评估向量库规模
document_chunks_created_total = Counter(
    "document_chunks_created_total",
    "Total document chunks created",
)


# ============================================
# 系统信息指标
# ============================================

# 应用信息
# 作用：暴露应用版本、环境等信息，便于 Prometheus 标识实例
app_info = Info(
    "kb_qa_system",
    "Enterprise Knowledge Base QA System information",
)


# ============================================
# 数据库连接池指标（E2-02）
# ============================================

# 连接池大小
# 作用：监控连接池配置的总量，用于容量规划
db_pool_size = Gauge(
    "db_pool_size",
    "Database connection pool size (configured)",
)

# 已检出连接数
# 作用：监控当前正在使用的连接数，使用率 > 80% 时应告警
db_pool_checked_out = Gauge(
    "db_pool_checked_out",
    "Database connections currently checked out from pool",
)

# 溢出连接数
# 作用：监控超过 pool_size 的临时连接数，持续溢出说明 pool_size 需调大
db_pool_overflow = Gauge(
    "db_pool_overflow",
    "Database overflow connections (beyond pool_size)",
)


def record_db_pool_metrics() -> None:
    """
    采集数据库连接池指标

    作用：
        从 SQLAlchemy engine.pool 获取连接池状态并更新 Gauge 指标。
        建议在 Prometheus 中间件或定时任务中定期调用。

    实现方式：
        - 通过 engine.pool.status() 获取连接池状态字符串
        - 解析状态字符串提取 checked_out 和 overflow 数量
        - pool_size 从配置读取
    """
    if not is_prometheus_enabled():
        return

    try:
        from app.core.database import engine
        pool = engine.pool
        # SQLAlchemy QueuePool 的 status() 返回格式：
        # "Pool size: 10  Connections in pool: 3  Current Overflow: 2  Current Checked out connections: 5"
        status = pool.status()
        # 解析 checked out 和 overflow
        import re
        checked_match = re.search(r"Checked out connections:\s*(\d+)", status)
        overflow_match = re.search(r"Current Overflow:\s*(-?\d+)", status)

        checked_out = int(checked_match.group(1)) if checked_match else 0
        overflow = max(0, int(overflow_match.group(1))) if overflow_match else 0

        db_pool_size.set(pool.size())
        db_pool_checked_out.set(checked_out)
        db_pool_overflow.set(overflow)
    except Exception as e:
        logger.debug(f"数据库连接池指标采集异常: {e}")


# ============================================
# Redis 缓存命中率指标（E2-03）
# ============================================

# Redis 缓存命中次数
# 作用：统计缓存命中量，配合 miss 指标计算命中率
redis_cache_hits_total = Counter(
    "redis_cache_hits_total",
    "Total Redis cache hits",
)

# Redis 缓存未命中次数
# 作用：统计缓存未命中量，命中率低说明缓存策略需优化
redis_cache_misses_total = Counter(
    "redis_cache_misses_total",
    "Total Redis cache misses",
)


def record_cache_hit() -> None:
    """
    记录缓存命中

    作用：
        在 RedisManager.get() 成功获取缓存时调用，
        统计缓存命中率以评估缓存策略效果。
    """
    if not is_prometheus_enabled():
        return
    try:
        redis_cache_hits_total.inc()
    except Exception as e:
        logger.debug(f"Redis 缓存命中指标记录异常: {e}")


def record_cache_miss() -> None:
    """
    记录缓存未命中

    作用：
        在 RedisManager.get() 未找到缓存时调用，
        统计缓存未命中量以评估缓存策略效果。
    """
    if not is_prometheus_enabled():
        return
    try:
        redis_cache_misses_total.inc()
    except Exception as e:
        logger.debug(f"Redis 缓存未命中指标记录异常: {e}")


def init_app_info():
    """
    初始化应用信息指标

    作用：
        在应用启动时设置 app_info 的值（版本、环境等），
        供 Prometheus 通过 kb_qa_system_info 指标查询。
    """
    app_info.info({
        "version": "1.0.0",
        "environment": settings.ENVIRONMENT,
        "app_name": settings.APP_NAME,
    })


# ============================================
# RAG 指标记录辅助函数
# ============================================

def record_rag_metrics(
    metrics: Dict[str, Any],
    intent_type: str = "kb_query",
    retrieval_happened: bool = True,
    stream: bool = False,
) -> None:
    """
    统一记录 RAG 链路指标

    作用：
        将 rag_chain.ask()/ask_stream() 返回的 metrics 字典中的指标
        统一记录到 Prometheus，避免在多处重复编写记录代码。

    实现方式：
        1. 检查 Prometheus 开关，关闭时直接返回
        2. 记录问答总数（按意图类型和流式标记）
        3. 记录检索指标（仅 retrieval_happened=True 时）
        4. 记录 LLM 指标（耗时、Token、重试）
        5. 记录降级指标（如有降级原因）
        所有记录操作都包裹在 try-except 中，避免指标记录失败影响主流程。

    参数：
        metrics: Dict[str, Any] - rag_chain._build_metrics() 返回的指标字典
            包含：retrieval_count, retrieval_top_score, retrieval_time_ms,
                  llm_time_ms, retry_count, token_input, token_output, model_used
        intent_type: str - 用户意图类型（kb_query/chitchat/followup/meta）
        retrieval_happened: bool - 是否执行了检索（闲聊/追问/元问题为 False）
        stream: bool - 是否流式响应
    """
    if not is_prometheus_enabled():
        return

    try:
        # 1. 记录问答总数
        rag_questions_total.labels(
            intent_type=intent_type,
            stream=str(stream).lower(),
        ).inc()

        # 2. 记录检索指标（仅检索路径）
        if retrieval_happened:
            retrieval_ms = metrics.get("retrieval_time_ms", 0)
            rag_retrieval_duration_seconds.observe(retrieval_ms / 1000.0)

            retrieval_count = metrics.get("retrieval_count", 0)
            rag_retrieval_results_count.observe(retrieval_count)

            top_score = metrics.get("retrieval_top_score", 0.0)
            rag_retrieval_top_score.observe(top_score)

        # 3. 记录 LLM 指标
        llm_ms = metrics.get("llm_time_ms", 0)
        if llm_ms > 0:
            rag_llm_duration_seconds.observe(llm_ms / 1000.0)

        token_input = metrics.get("token_input", 0)
        if token_input > 0:
            rag_llm_tokens_total.labels(direction="input").inc(token_input)

        token_output = metrics.get("token_output", 0)
        if token_output > 0:
            rag_llm_tokens_total.labels(direction="output").inc(token_output)

        retry_count = metrics.get("retry_count", 0)
        if retry_count > 0:
            rag_llm_retries_total.inc(retry_count)

    except Exception as e:
        # 指标记录失败不影响主流程
        logger.debug(f"Prometheus 指标记录异常: {e}")


def record_degradation(reason: Optional[str]) -> None:
    """
    记录降级响应

    作用：
        当 RAG 链路走兜底回复时，记录降级原因。
        用于监控服务健康度和 LLM 可用性。

    参数：
        reason: Optional[str] - 降级原因
            circuit_open: 熔断打开
            llm_unavailable: LLM 服务不可用
            unknown_error: 未知异常
            skipped: 预生成校验跳过（非 LLM 故障，但也是降级行为）
            None: 未降级（不记录）
    """
    if not is_prometheus_enabled() or not reason:
        return

    try:
        rag_degradation_total.labels(reason=reason).inc()
    except Exception as e:
        logger.debug(f"Prometheus 降级指标记录异常: {e}")


def record_total_duration(intent_type: str, duration_seconds: float) -> None:
    """
    记录 RAG 总处理耗时

    作用：
        记录从问题接收到答案返回的全链路耗时（含 DB 操作）。
        在 chat.py 中调用（因为 total_time_ms 在 chat.py 测量）。

    参数：
        intent_type: str - 用户意图类型
        duration_seconds: float - 总耗时（秒）
    """
    if not is_prometheus_enabled():
        return

    try:
        rag_total_duration_seconds.labels(intent_type=intent_type).observe(duration_seconds)
    except Exception as e:
        logger.debug(f"Prometheus 总耗时指标记录异常: {e}")


def record_validation_skip() -> None:
    """
    记录预生成校验拦截

    作用：
        当检索质量不足导致跳过 LLM 生成时，记录拦截事件。
        用于监控知识库覆盖率和检索质量。
    """
    if not is_prometheus_enabled():
        return

    try:
        rag_validation_skipped_total.inc()
    except Exception as e:
        logger.debug(f"Prometheus 校验拦截指标记录异常: {e}")


def record_conflict_detected() -> None:
    """
    记录矛盾检测命中

    作用：
        当检索结果中检测到内容矛盾时，记录冲突事件。
        用于监控知识库内容质量。
    """
    if not is_prometheus_enabled():
        return

    try:
        rag_conflict_detected_total.inc()
    except Exception as e:
        logger.debug(f"Prometheus 矛盾检测指标记录异常: {e}")


def get_metrics_data() -> tuple:
    """
    获取 Prometheus 指标数据

    作用：
        生成 Prometheus 格式的指标数据，供 /metrics 端点返回。
        Prometheus server 通过 HTTP GET 抓取此数据。

    返回:
        tuple - (metrics_bytes, content_type)
            metrics_bytes: bytes - 指标数据（Prometheus 文本格式）
            content_type: str - HTTP Content-Type
    """
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST
