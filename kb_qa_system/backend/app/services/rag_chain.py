"""
RAG 检索链路模块

作用：
    实现 RAG（Retrieval-Augmented Generation，检索增强生成）完整流程：
    1. 用户提问
    2. 从向量数据库检索相关文档片段
    3. 将检索结果作为上下文，构建 Prompt
    4. 调用 LLM 生成回答
    5. 返回回答和引用来源

    这是知识库问答系统的核心模块。

实现方式：
    1. 通过 LLMResilienceService 调用 LLM（内置重试+熔断+超时+降级）
    2. 使用 pgvector 向量数据库进行相似度检索
    3. 使用 PromptTemplate 构建 Prompt
    4. 支持流式输出（SSE）
    5. 支持多轮对话（保留历史上下文）
    6. LLM 不可用时走兜底回复，保证用户始终能收到响应
"""

import logging
import re
import threading
from typing import List, Dict, Any, Optional, AsyncGenerator

from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, BaseMessage

from app.core.config import settings
from app.services.rag_answer_guard import medical_answer_boundary, requires_medical_evidence
from app.services.vector_store import get_vector_store

logger = logging.getLogger(__name__)


class RAGChainService:
    """
    RAG 检索链路服务

    作用：
        整合检索和生成，实现知识库问答。

    使用方式：
        rag = RAGChainService()
        # 非流式
        result = rag.ask("如何使用异步编程？")
        # 流式
        async for chunk in rag.ask_stream("如何使用异步编程？"):
            print(chunk)
    """

    def __init__(self):
        """
        初始化 RAG 服务

        作用：
            构建 Prompt 模板。LLM 实例由 LLMResilienceService 管理（懒加载）。

        实现方式：
            1. 构建 Prompt 模板（系统提示词 + 上下文 + 历史 + 问题）
            2. LLM 容错服务通过 get_llm_service() 懒加载，避免启动时创建
        """
        # 构建 Prompt 模板
        # 作用：定义发送给 LLM 的消息格式
        # 包含：系统提示词、对话历史、检索到的上下文、用户问题
        self.prompt = self._build_prompt()

    def _get_llm_service(self):
        """
        获取 LLM 容错服务（懒加载）

        作用：
            懒加载 LLMResilienceService，避免应用启动时就创建 LLM 实例（需要 API Key）。
            该服务内置重试、熔断、超时、降级四种容错机制。

        返回：
            LLMResilienceService - LLM 容错服务实例
        """
        from app.services.llm_resilience import get_llm_service
        return get_llm_service()

    def _build_prompt(self) -> ChatPromptTemplate:
        """
        构建 Prompt 模板

        作用：
            定义发送给 LLM 的消息格式，包括：
            - system: 系统提示词（定义 AI 角色和行为规则）
            - history: 对话历史（多轮对话上下文）
            - human: 当前问题 + 检索到的知识库内容

        实现方式：
            使用 LangChain 的 ChatPromptTemplate：
            - from_messages: 从消息列表创建模板
            - 变量用 {变量名} 表示，运行时填充

        返回：
            ChatPromptTemplate - Prompt 模板实例
        """
        prompt = ChatPromptTemplate.from_messages([
            # 系统消息：定义 AI 的角色和行为
            # 作用：告诉 AI 它是知识库助手，必须基于提供的上下文回答
            ("system", settings.SYSTEM_PROMPT),

            # 对话历史：多轮对话的上下文
            # 作用：让 AI 理解上下文，支持追问
            # MessagesPlaceholder 会被替换为消息列表
            MessagesPlaceholder(variable_name="history"),

            # 用户消息：当前问题
            # 作用：用户本次的提问
            ("human", "{question}"),
        ])

        return prompt

    # ============================================
    # 检索相关文档
    # ============================================

    def retrieve_context(
        self,
        query: str,
        top_k: Optional[int] = None,
        user_id: Optional[int] = None,
        document_ids: Optional[List[int]] = None,
        user_type: str = "regular",
        rerank_mode: str = "current",
    ) -> List[Dict[str, Any]]:
        """
        检索相关文档片段（权限隔离版）

        作用：
            将用户问题在向量数据库中检索，返回最相关的文档片段。
            这些片段会作为上下文提供给 LLM。

            【权限隔离核心】检索范围被限定为用户有权访问的文档：
            - user_id 不为空时，自动计算可访问文档 ID（自己的 + 公共库）
            - document_ids 显式指定时，取与可访问范围的交集（防止越权）
            - 无 user_id 时一律返回空列表（M-3 修复：不再信任裸 document_ids）
            - guest 用户（任务5）仅可访问公共库，不可访问任何私人文档

        实现方式：
            1. 若提供 user_id，通过权限服务获取可访问文档 ID 列表
            2. 若同时提供 document_ids，取交集（最小权限原则）
            3. 调用 vector_store.search 检索（启用 reranking 时扩大召回数量）
            4. 启用 reranking 时用 cross-encoder 重排序，取 final_top_k
            5. 返回检索结果

        参数：
            query: str - 用户问题
            top_k: Optional[int] - 返回的文档数量
            user_id: Optional[int] - 当前用户 ID（来自 JWT，用于计算检索范围）
            document_ids: Optional[List[int]] - 显式限定的文档 ID（与可访问范围取交集）
            user_type: str - 用户类型（regular/guest，任务5），guest 仅检索公共库

        返回：
            List[Dict[str, Any]] - 检索结果
            格式：
            [
                {
                    "content": "文档片段内容",
                    "metadata": {"document_id": 1, "document_title": "..."},
                    "score": 0.95
                },
                ...
            ]
        """
        try:
            # 计算检索范围（权限隔离）
            # 作用：确保只检索用户有权访问的文档，防止越权
            accessible_ids = self._compute_search_scope(user_id, document_ids, user_type)
            if accessible_ids is not None and len(accessible_ids) == 0:
                # 无可访问文档，直接返回空（不调用向量库）
                logger.info(f"用户 {user_id} 无可访问文档，检索返回空")
                return []

            # 确定最终返回数量
            # 作用：top_k 为 None 时用默认值 SEARCH_TOP_K
            final_top_k = top_k or settings.SEARCH_TOP_K

            # 计算检索数量（启用 reranking 时扩大召回）
            # 作用：向量检索多召回候选（top_k × 倍数），cross-encoder 重排序后取 final_top_k
            #       高召回 + 高精度 = 兼顾不漏召和精确排序
            use_qwen = rerank_mode == "qwen3.7-text-rerank"
            if use_qwen:
                from app.services.qwen_reranker import MAX_CANDIDATES
                search_k = min(MAX_CANDIDATES, final_top_k * settings.RERANKER_CANDIDATE_MULTIPLIER)
            elif settings.ENABLE_RERANKING:
                search_k = final_top_k * settings.RERANKER_CANDIDATE_MULTIPLIER
            else:
                search_k = final_top_k

            # 检索计时
            # 作用：监控检索耗时，超时时记录警告（实际超时由 Embedding request_timeout 兜底）
            import time as _time
            retrieval_start = _time.time()

            vector_store = get_vector_store()

            # 任务2：动态混合检索权重
            # 作用：复用 intent_classifier 检测查询子类型，动态调整关键词检索权重
            # 实现方式：纯正则匹配（零延迟），从 settings.QUERY_SUBTYPE_WEIGHTS 映射权重
            # 子类型：exact_match(0.6) / semantic(0.2) / hybrid(0.3)
            from app.services.intent_classifier import intent_classifier, QuerySubType
            query_sub_type = intent_classifier._detect_query_sub_type(query)
            dynamic_keyword_weight = settings.QUERY_SUBTYPE_WEIGHTS.get(
                query_sub_type.value, settings.KEYWORD_SEARCH_WEIGHT
            )
            logger.debug(
                f"查询子类型: {query_sub_type.value}，关键词权重: {dynamic_keyword_weight}"
            )

            results = vector_store.search(
                query,
                top_k=search_k,
                document_ids=accessible_ids,
                keyword_weight=dynamic_keyword_weight,
            )

            retrieval_ms = int((_time.time() - retrieval_start) * 1000)
            if retrieval_ms > settings.RETRIEVAL_TIMEOUT * 1000:
                logger.warning(
                    f"检索耗时 {retrieval_ms}ms 超过阈值 {settings.RETRIEVAL_TIMEOUT}s"
                )
            else:
                logger.info(f"检索完成，耗时 {retrieval_ms}ms，返回 {len(results)} 条候选")

            # Reranking 重排序
            # 作用：cross-encoder 对候选结果二次打分，提升 Top-K 精确度
            # 启用 reranking 且候选数大于 final_top_k 时才重排序（否则无意义）
            if use_qwen:
                from app.services.qwen_reranker import rerank_with_primary
                results = rerank_with_primary(query, results, top_k=final_top_k)
            elif settings.ENABLE_RERANKING and len(results) > final_top_k:
                from app.services.reranker import reranker_service
                rerank_start = _time.time()
                results = reranker_service.rerank(query, results, top_k=final_top_k)
                rerank_ms = int((_time.time() - rerank_start) * 1000)
                logger.info(f"重排序耗时 {rerank_ms}ms，返回 {len(results)} 条最终结果")

            return results
        except Exception as e:
            # 检索失败时返回空列表，让 LLM 知道没有找到相关内容
            # 作用：检索异常不阻塞问答流程，LLM 会基于空上下文回答
            logger.error(f"检索失败: {e}", exc_info=True)
            return []

    def _compute_search_scope(
        self,
        user_id: Optional[int],
        document_ids: Optional[List[int]],
        user_type: str = "regular",
    ) -> Optional[List[int]]:
        """
        计算检索范围（最小权限原则）

        作用：
            根据用户身份和显式限定的文档 ID，计算最终检索范围。
            规则：
            1. 提供 user_id：取该用户可访问的全部文档 ID
            2. 同时提供 document_ids：取可访问范围与 document_ids 的交集
            3. 无 user_id（无论是否有 document_ids）：返回空列表拒绝检索
               （M-3 修复：原实现无 user_id 时直接信任 document_ids，
                存在越权风险——调用方可传入任意 document_ids 检索他人文档。
                修复后强制要求 user_id，无 user_id 一律拒绝。）
            4. 都未提供：返回空列表拒绝检索
            5. guest 用户（任务5）：仅可访问公共库，permission 服务内部过滤

        参数：
            user_id: Optional[int] - 用户 ID（必须提供，否则拒绝检索）
            document_ids: Optional[List[int]] - 显式限定的文档 ID（与可访问范围取交集）
            user_type: str - 用户类型（regular/guest，任务5），透传至 permission 服务

        返回:
            Optional[List[int]] - 最终检索范围
            - 空列表：有范围但为空（无可访问文档或未提供 user_id，应返回空结果）
            - 非空列表：最终限定的文档 ID
        """
        from app.core.database import SessionLocal
        from app.services.permission import permission_service

        # M-3 修复：无 user_id 一律拒绝检索（不再信任 document_ids）
        # 作用：原实现无 user_id 时直接返回 document_ids，调用方可传入任意 ID 越权检索
        #       修复后强制要求 user_id，所有检索路径必须经过权限服务计算可访问范围
        if user_id is None:
            logger.warning(
                "检索未提供 user_id，拒绝执行（防止越权）"
            )
            return []

        # 有 user_id：计算可访问范围
        # L-16 说明：此处创建独立 SessionLocal() 而非复用请求级 db session
        #   原因：RAGChainService 是单例，不持有请求级 db session；
        #         ask/ask_stream 方法签名未暴露 db 参数（公共 API 稳定性考虑）
        #   影响：每次检索额外占用一个连接池连接（仅 permission 查询期间，毫秒级）
        #   缓解：try/finally 确保 session 及时释放；permission 查询走索引很快
        #   优化路径（未来）：可为 ask/ask_stream 增加可选 db 参数，由调用方注入请求级 session
        db = SessionLocal()
        try:
            accessible = permission_service.get_accessible_document_ids(
                db, user_id, user_type=user_type
            )

            # 同时有 document_ids：取交集（最小权限）
            if document_ids is not None:
                accessible_set = set(accessible)
                accessible = [did for did in document_ids if did in accessible_set]

            return accessible
        finally:
            db.close()

    # ============================================
    # 用户意图识别（检索前预处理）
    # ============================================

    def _classify_intent(
        self,
        question: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
    ) -> Any:
        """
        用户意图识别

        作用：
            判断用户输入的意图类型（知识库提问/闲聊/追问/元问题），
            决定是否需要检索知识库文档。

            非知识库意图（闲聊/追问/元问题）走无检索生成路径，
            避免被预生成校验误拦截（如"谢谢"检索不到文档返回"未找到相关文档"）。

        实现方式：
            委托给 IntentClassifier.classify，内部会：
            1. 规则预判（关键词+正则匹配，零 LLM 调用）
            2. LLM 分类（规则无法判断时）
            3. 降级为 kb_query（LLM 不可用时）

        参数：
            question: str - 用户输入
            conversation_history: Optional[List[Dict[str, str]]] - 对话历史
                用于判断追问意图（无历史的"继续"无法追问）

        返回:
            IntentClassification - 分类结果
                intent: 意图类型
                confidence: 置信度
                needs_retrieval: 是否需要检索
                reason: 分类原因
        """
        from app.services.intent_classifier import (
            intent_classifier,
            IntentClassification,
            IntentType,
        )

        try:
            return intent_classifier.classify(question, conversation_history)
        except Exception as e:
            # 意图识别异常时降级为 kb_query，走完整 RAG 流程
            # 作用：避免意图识别故障导致系统无法回答知识库问题
            logger.warning(f"意图识别异常，降级为 kb_query: {e}")
            return IntentClassification(
                intent=IntentType.KB_QUERY,
                confidence=0.5,
                needs_retrieval=True,
                reason="error_fallback",
            )

    def _get_intent_system_prompt(self, intent_value: str) -> str:
        """
        根据意图类型返回对应的系统提示词（无检索路径专用）

        作用：
            非知识库意图不使用标准 SYSTEM_PROMPT（该 Prompt 要求基于检索内容回答），
            而是根据意图类型使用专用提示词，引导 LLM 生成合适的回复。

        实现方式：
            根据意图类型返回预设的系统提示词：
            - chitchat: 引导自然社交回复
            - followup: 引导基于历史继续讨论
            - meta: 介绍系统能力

        参数：
            intent_value: str - 意图类型值（IntentType 的 value 属性）

        返回:
            str - 对应意图的系统提示词
        """
        from app.services.intent_classifier import IntentType

        prompts = {
            IntentType.CHITCHAT.value: (
                "你是GeiIt企业知识库的友好助手。用户正在和你闲聊，请自然、简洁地回复。"
                "如果用户有知识库相关的问题，可以引导用户提问。"
            ),
            IntentType.FOLLOWUP.value: (
                "你是GeiIt企业知识库的助手。用户希望基于之前的对话继续讨论。"
                "请结合对话历史，自然地继续回答或补充说明。保持回答简洁、连贯。"
                "如果用户的问题需要查询知识库文档才能回答，请告知用户可以明确提问。"
            ),
            IntentType.META.value: (
                "你是GeiIt企业知识库的助手。用户询问关于你本身的信息。请简洁介绍你的能力：\n"
                "1. 基于企业知识库回答问题\n"
                "2. 支持多轮对话和追问\n"
                "3. 支持上传 PDF/Word/Markdown 等文档构建知识库\n"
                "4. 回答会标注引用来源"
            ),
        }
        # 默认使用闲聊提示词（兜底，未知意图类型时安全降级）
        return prompts.get(intent_value, prompts[IntentType.CHITCHAT.value])

    def _generate_without_retrieval(
        self,
        question: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        summary: Optional[str] = None,
        intent: Any = None,
    ) -> Dict[str, Any]:
        """
        无检索生成（非流式）—— 用于闲聊/追问/元问题

        作用：
            非知识库意图不需要检索文档，直接用 LLM 回复。
            跳过检索和预生成校验，避免误拦截（如"谢谢"被拦截返回"未找到相关文档"）。

            根据意图类型调整系统提示词：
            - chitchat: 引导自然社交回复
            - followup: 结合历史继续讨论
            - meta: 介绍系统能力

        实现方式：
            1. 根据意图选择系统提示词（非标准 SYSTEM_PROMPT，因为无 context）
            2. 构建历史（含摘要，无矛盾检测/意图切换提示）
            3. 直接构建消息列表（SystemMessage + history + HumanMessage）
            4. 调用 LLM 生成（带容错降级）
            5. 返回与 ask() 相同格式的结果（sources 为空，附带 intent 信息）

        参数：
            question: str - 用户输入
            conversation_history: Optional[List[Dict[str, str]]] - 对话历史
            summary: Optional[str] - 历史摘要（记忆衰退机制产物）
            intent: Any - 意图分类结果（IntentClassification 实例）

        返回:
            Dict[str, Any] - 与 ask() 相同格式
                answer: LLM 生成的回复
                sources: 空列表（无检索）
                question: 用户输入
                degraded: 是否降级
                degrade_reason: 降级原因
                metrics: 质量指标
                conflict: None（无矛盾检测）
                intent: 意图信息（供前端区分展示和埋点统计）
        """
        # 1. 根据意图选择系统提示词
        # 作用：不同意图需要不同的回复风格，标准 SYSTEM_PROMPT 要求基于检索内容回答不适用
        system_prompt = self._get_intent_system_prompt(intent.intent.value)

        # 2. 构建历史（含摘要）
        # 作用：followup 意图需要历史上下文继续讨论；chitchat/meta 有历史也无害
        # intent_switched=False：无检索路径不需要话题切换提示（切换提示是给检索路径用的）
        history = self._build_history(
            conversation_history or [],
            summary=summary,
            intent_switched=False,
        )

        # 3. 直接构建消息（不走标准模板，因为无 context 变量）
        # 作用：标准模板需要 {context} 和 {question}，无检索路径没有 context
        messages = [SystemMessage(content=system_prompt)] + history + [HumanMessage(content=question)]

        # 4. 调用 LLM（带容错降级）
        degraded = False
        degrade_reason = None
        llm_metrics: Dict[str, Any] = {}

        try:
            llm_service = self._get_llm_service()
            answer = llm_service.invoke(messages)
            llm_metrics = llm_service.last_metrics
        except Exception as e:
            # LLM 完全不可用 → 走兜底回复
            # 作用：保证用户始终能收到响应
            from app.core.circuit_breaker import CircuitBreakerOpenError
            from app.services.llm_resilience import LLMServiceError

            if isinstance(e, CircuitBreakerOpenError):
                degrade_reason = "circuit_open"
                logger.warning(f"LLM 熔断中，走兜底回复: {e}")
            elif isinstance(e, LLMServiceError):
                degrade_reason = "llm_unavailable"
                logger.error(f"LLM 服务不可用，走兜底回复: {e}")
            else:
                degrade_reason = "unknown_error"
                logger.error(f"LLM 调用未知异常，走兜底回复: {e}", exc_info=True)

            answer = self._degraded_answer(question, has_context=False)
            degraded = True

        # 5. 组装结果（与 ask() 格式一致，sources 为空，附带 intent 信息）
        # Prometheus 指标：记录无检索路径的 RAG 指标
        # 作用：闲聊/追问/元问题的 LLM 调用也纳入监控，retrieval_happened=False 跳过检索指标
        from app.core.prometheus_metrics import record_rag_metrics, record_degradation
        record_rag_metrics(
            {}, intent_type=intent.intent.value,
            retrieval_happened=False, stream=False,
        )
        if degraded:
            record_degradation(degrade_reason)

        return {
            "answer": answer,
            "sources": [],
            "question": question,
            "degraded": degraded,
            "degrade_reason": degrade_reason,
            "metrics": self._build_metrics([], 0, llm_metrics, degraded),
            "conflict": None,
            # 意图信息（供前端区分展示和埋点统计）
            "intent": {
                "type": intent.intent.value,
                "confidence": intent.confidence,
                "reason": intent.reason,
            },
        }

    async def _generate_without_retrieval_stream(
        self,
        question: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        summary: Optional[str] = None,
        intent: Any = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        无检索流式生成 —— 用于闲聊/追问/元问题

        作用：
            非知识库意图的流式版本，直接用 LLM 流式回复。
            跳过检索和预生成校验，避免误拦截。

        实现方式：
            1. yield 空引用来源（保持与 ask_stream 相同的事件流格式）
            2. 根据意图选择系统提示词
            3. 构建历史（含摘要）
            4. 流式调用 LLM，yield 每个文本块
            5. yield done 事件（携带完整回复和指标）
            6. LLM 失败时 yield 兜底回复

        参数：
            question: str - 用户输入
            conversation_history: Optional[List[Dict[str, str]]] - 对话历史
            summary: Optional[str] - 历史摘要
            intent: Any - 意图分类结果（IntentClassification 实例）

        返回:
            AsyncGenerator - 异步生成器，yield 数据块
            数据格式：
            - {"type": "sources", "content": [], "intent": {...}}  # 空引用来源+意图
            - {"type": "chunk", "content": "..."}                    # 回答片段
            - {"type": "done", "content": "...", "metrics": {...}}   # 完整回答+指标
        """
        intent_info = {
            "type": intent.intent.value,
            "confidence": intent.confidence,
            "reason": intent.reason,
        }

        # 1. yield 空引用来源（携带意图信息，让前端知道是无检索路径）
        # 作用：保持与 ask_stream 事件流格式一致，前端先收到 sources 事件
        yield {"type": "sources", "content": [], "intent": intent_info}

        # 2. 根据意图选择系统提示词
        system_prompt = self._get_intent_system_prompt(intent.intent.value)

        # 3. 构建历史（含摘要，intent_switched=False）
        history = self._build_history(
            conversation_history or [],
            summary=summary,
            intent_switched=False,
        )

        # 4. 构建消息（直接构建，不走标准模板）
        messages = [SystemMessage(content=system_prompt)] + history + [HumanMessage(content=question)]

        # 5. 流式调用 LLM（带容错降级）
        full_answer = ""
        degraded = False
        degrade_reason = None
        llm_metrics: Dict[str, Any] = {}
        llm_service = None

        try:
            llm_service = self._get_llm_service()
            async for chunk in llm_service.astream(messages):
                # 流式 chunk 容错
                # 作用：过滤 None/空/异常类型的 chunk
                safe_chunk = self._sanitize_chunk(chunk)
                if safe_chunk is None:
                    continue
                full_answer += safe_chunk
                yield {"type": "chunk", "content": safe_chunk}
            # 流式正常结束，读取 LLM 指标
            if llm_service is not None:
                llm_metrics = llm_service.last_metrics
        except Exception as e:
            # LLM 流式失败 → 走兜底回复
            # 作用：保证流式接口也能优雅降级
            from app.core.circuit_breaker import CircuitBreakerOpenError
            from app.services.llm_resilience import LLMServiceError

            if isinstance(e, CircuitBreakerOpenError):
                degrade_reason = "circuit_open"
                logger.warning(f"LLM 流式熔断中，走兜底回复: {e}")
            elif isinstance(e, LLMServiceError):
                degrade_reason = "llm_unavailable"
                logger.error(f"LLM 流式服务不可用，走兜底回复: {e}")
            else:
                degrade_reason = "unknown_error"
                logger.error(f"LLM 流式调用未知异常，走兜底回复: {e}", exc_info=True)

            # 尝试读取已部分填充的 LLM 指标
            if llm_service is not None:
                llm_metrics = llm_service.last_metrics

            degraded = True
            # 兜底回复作为补充分段输出
            fallback = self._degraded_answer(question, has_context=False)
            if full_answer:
                fallback = "\n\n" + fallback
            full_answer += fallback
            yield {"type": "chunk", "content": fallback}

        # 6. 组装指标并发送 done 事件
        metrics = self._build_metrics([], 0, llm_metrics, degraded)

        # Prometheus 指标：记录无检索流式路径的 RAG 指标
        from app.core.prometheus_metrics import record_rag_metrics, record_degradation
        record_rag_metrics(
            {}, intent_type=intent.intent.value,
            retrieval_happened=False, stream=True,
        )
        if degraded:
            record_degradation(degrade_reason)

        yield {
            "type": "done",
            "content": full_answer,
            "degraded": degraded,
            "degrade_reason": degrade_reason,
            "metrics": metrics,
            "intent": intent_info,
        }

    # ============================================
    # Query 改写（检索预处理）
    # ============================================

    def _rewrite_query_for_search(
        self,
        question: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        intent_switched: bool = False,
    ) -> str:
        """
        改写用户 query 用于检索（指代消解 + 语义扩展）

        作用：
            在检索前对用户问题进行改写，提升检索召回质量。
            解决多轮对话中的三类检索问题：
            1. 指代消解："那个怎么样" → "asyncio.gather 怎么样"
            2. 短query扩展："asyncio" → "Python asyncio 异步编程 使用方法"
            3. 延续性指令："继续" → 提取历史主题补全为完整问题

            【关键设计】改写后的 query 仅用于检索，原始 question 仍用于 LLM 生成。
            原因：LLM 生成需要看到用户的原始表达，避免改写引入歧义；
                  检索需要消解指代和补充关键词，才能召回相关文档。

            【意图切换处理】intent_switched=True 时，传空历史给改写服务。
            原因：意图切换时，历史中的旧话题指代（"那个"指代旧话题内容）不应
                  被消解到当前 query，否则会用旧话题的关键词污染检索。

        实现方式：
            委托给 QueryRewriteService.rewrite_query，内部会：
            1. 检查 ENABLE_QUERY_REWRITE 开关
            2. 快速预判是否需要改写（无历史或已清晰则跳过）
            3. 调用 LLM 改写（带超时降级）
            4. 失败时返回原始 query

        参数：
            question: str - 用户原始问题
            conversation_history: Optional[List[Dict[str, str]]] - 对话历史
                格式：[{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]
            intent_switched: bool - 是否检测到意图切换
                True: 传空历史给改写服务，避免旧话题污染
                False: 正常用历史做指代消解

        返回:
            str - 改写后的 query（用于检索）；无需改写或失败时返回原始 question
        """
        # 懒导入避免循环依赖
        # 作用：query_rewrite_service 间接依赖 llm_resilience，延迟到运行时加载
        from app.services.query_rewrite import query_rewrite_service

        # 意图切换时传空历史，避免旧话题指代消解污染当前 query
        # 作用：改写服务无历史时会原样返回 query（不做指代消解），保证检索基于当前意图
        history_for_rewrite = [] if intent_switched else conversation_history

        try:
            return query_rewrite_service.rewrite_query(question, history_for_rewrite)
        except Exception as e:
            # 改写失败不影响主流程，降级为原始 query
            # 作用：query 改写是检索增强，失败时用原始 query 检索即可
            logger.warning(f"Query 改写异常，使用原始 query: {e}")
            return question

    # ============================================
    # 矛盾检测（检索后处理）
    # ============================================

    def _detect_conflicts(
        self,
        query: str,
        search_results: List[Dict[str, Any]],
    ) -> Optional[Any]:
        """
        检测检索结果之间的内容矛盾

        作用：
            在检索后用 LLM 判断多个文档片段是否存在内容矛盾。
            检测到矛盾时返回 ConflictResult，用于：
            1. 在 _build_context 中标记冲突片段
            2. 在 _build_history 中注入矛盾提示
            3. 在返回结果中携带冲突信息供前端展示

        实现方式：
            委托给 ConflictDetector.detect_conflicts，内部会：
            1. 快速预判（结果少于2条跳过）
            2. 调用 LLM 检测（带降级容错）
            3. 解析 JSON 返回结构化结果

        参数：
            query: str - 用户问题（用于判断矛盾的上下文）
            search_results: List[Dict[str, Any]] - 检索结果

        返回:
            Optional[ConflictResult] - 矛盾检测结果
                None: 配置关闭或异常
                ConflictResult: 检测结果（含 has_conflict/conflicting_pairs/description）
        """
        from app.services.conflict_detector import conflict_detector

        try:
            return conflict_detector.detect_conflicts(query, search_results)
        except Exception as e:
            # 矛盾检测失败不影响主流程
            # 作用：矛盾检测是质量增强，失败时正常生成回答
            logger.warning(f"矛盾检测异常，跳过: {e}")
            return None

    # ============================================
    # 预生成校验（检索质量检查）
    # ============================================

    def _validate_before_generation(
        self,
        query: str,
        search_results: List[Dict[str, Any]],
    ) -> Any:
        """
        预生成校验：在 LLM 生成前检查检索结果质量

        作用：
            校验检索结果是否足够支持生成有意义的回答。
            质量不足时返回兜底回答，避免幻觉并节省 LLM 调用成本。

        实现方式：
            委托给 PreGenerationValidator.validate，内部会：
            1. 检查结果是否为空 → 不生成
            2. 检查内容总长度 → 不生成
            3. 检查最高分数 → 不生成或标记低置信度
            4. 异常时默认允许生成

        参数：
            query: str - 用户问题（用于生成兜底回答）
            search_results: List[Dict[str, Any]] - 检索结果

        返回:
            ValidationResult - 校验结果
                should_generate=False 时包含 fallback_answer
                confidence="low" 时调用方应附加低置信度提示
        """
        from app.services.pre_generation_validator import pre_generation_validator

        return pre_generation_validator.validate(query, search_results)

    # ============================================
    # 构建上下文文本
    # ============================================

    def _build_context(
        self,
        search_results: List[Dict[str, Any]],
        conflict_result: Optional[Any] = None,
    ) -> str:
        """
        将检索结果构建为上下文文本

        作用：
            将多个文档片段拼接成一个字符串，作为 Prompt 中的 {context} 部分。
            如果存在矛盾检测结果，为冲突片段添加矛盾标记，让 LLM 注意差异。

        实现方式：
            1. 遍历检索结果
            2. 为每个片段添加来源标注（文档标题、编号、相关度）
            3. 如果片段在冲突对中，添加 ⚠️ 矛盾标记
            4. 用分隔符拼接

        参数：
            search_results: List[Dict[str, Any]] - 检索结果
            conflict_result: Optional[ConflictResult] - 矛盾检测结果
                如果有冲突，conflicting_pairs 中的片段会被标记矛盾警告
                为 None 或无冲突时正常构建

        返回：
            str - 上下文文本

        示例（无矛盾）：
            [文档1: Python指南] (相关度: 95%)
            Python是一种编程语言...

            [文档2: 异步编程] (相关度: 85%)
            asyncio是Python的异步框架...

        示例（有矛盾）：
            [文档1: 部署指南] (相关度: 95%) ⚠️与文档2存在矛盾
            系统支持最大100并发...

            [文档2: 性能测试] (相关度: 85%) ⚠️与文档1存在矛盾
            最大并发数为50...
        """
        if not search_results:
            return "未找到相关文档。"

        # 构建冲突索引集合
        # 作用：快速判断某个片段是否在冲突对中，用于添加标记
        conflicted_indices = set()
        if conflict_result and conflict_result.has_conflict:
            for idx1, idx2 in conflict_result.conflicting_pairs:
                conflicted_indices.add(idx1)
                conflicted_indices.add(idx2)

        context_parts = []
        for index, result in enumerate(search_results, 1):
            # 获取文档标题
            title = result["metadata"].get("document_title", "未知文档")
            # 获取内容
            content = result["content"]
            # 获取相关度分数
            score = result.get("score", 0)
            score_percent = int(score * 100)

            # 构建片段标注
            # 作用：[文档X: 标题] (相关度: Y%)
            header = f"[文档{index}: {title}] (相关度: {score_percent}%)"

            # 如果片段在冲突对中，添加矛盾标记
            # 作用：让 LLM 注意该片段与其他片段存在矛盾，谨慎处理
            if (index - 1) in conflicted_indices:
                header += " ⚠️与其他文档存在矛盾，请注意区分"

            part = f"{header}\n{content}"
            context_parts.append(part)

        return "\n\n".join(context_parts)

    # ============================================
    # 构建无引用降级上下文 - 任务2
    # ============================================

    def _build_no_citation_context(self, question: str) -> str:
        """
        构建无引用降级模式的上下文（任务2）

        作用：
            当检索结果为空或质量不足时，构建特殊上下文提示，
            告知 LLM 当前没有知识库引用，让其基于自身通用知识回答，
            并在回答中声明答案来源（避免用户误以为是知识库内容）。

        实现方式：
            返回固定提示文本 + 用户原始问题，替代正常检索上下文填入 prompt。

        参数：
            question: str - 用户原始问题

        返回：
            str - 降级提示上下文（替代正常检索上下文填入 prompt）
        """
        return (
            "【系统提示】当前未从知识库中检索到与用户问题相关的文档引用。"
            "请基于你的通用知识回答用户问题，并在回答开头明确说明"
            "「以下内容基于模型通用知识，未引用知识库文档」。\n\n"
            f"用户问题：{question}"
        )

    # ============================================
    # 构建对话历史
    # ============================================

    def _build_history(
        self,
        conversation_history: List[Dict[str, str]],
        summary: Optional[str] = None,
        intent_switched: bool = False,
        conflict_result: Optional[Any] = None,
    ) -> List[Any]:
        """
        将对话历史转换为 LangChain 消息格式

        作用：
            将数据库中存储的对话历史转换为 LangChain 的消息对象，
            以便 LLM 理解多轮对话上下文。

            【记忆衰退机制】如果存在历史摘要（summary），将其作为 SystemMessage
            注入消息列表头部，让 LLM 通过摘要获取旧对话的关键信息，
            同时只保留近期对话的完整内容，控制 Token 消耗。

            【意图切换处理】如果 intent_switched=True，注入一条 SystemMessage
            提示 LLM 用户已切换话题，应基于当前问题独立回答，不要受历史话题影响。
            原因：即使切换了话题，近期历史仍保留（让 LLM 知道对话连续性），
                  但需明确告知 LLM 不要用旧话题内容回答当前问题。

            【矛盾检测处理】如果 conflict_result 显示存在矛盾，注入一条 SystemMessage
            提示 LLM 检索到的文档之间存在矛盾，应指出差异而非随意选择一方。
            原因：LLM 面对矛盾信息时可能随机选择，导致回答不稳定；
                  明确告知矛盾后，LLM 会更谨慎地处理（指出差异或说明来源）。

        实现方式：
            1. 如果意图切换，注入切换提示 SystemMessage（放在最前）
            2. 如果有矛盾，注入矛盾提示 SystemMessage（含矛盾描述）
            3. 如果有摘要，创建 SystemMessage 放在列表头部（长期上下文）
            4. 遍历对话历史，根据 role 创建 HumanMessage 或 AIMessage
            5. 只保留最近 N 轮（避免超出上下文长度）

        参数：
            conversation_history: List[Dict[str, str]] - 对话历史
                格式：[{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]
            summary: Optional[str] - 历史摘要（记忆衰退机制产物）
                由 HistorySummaryService 生成，涵盖旧对话的关键信息。
                意图切换时调用方应传 None，避免旧摘要污染。
            intent_switched: bool - 是否检测到意图切换
                True: 注入切换提示，让 LLM 独立回答当前问题
                False: 正常多轮对话，完整使用历史上下文
            conflict_result: Optional[ConflictResult] - 矛盾检测结果
                如果有冲突，注入矛盾提示让 LLM 谨慎处理
                为 None 或无冲突时不注入

        返回：
            List[Any] - LangChain 消息列表（可能以提示/摘要 SystemMessage 开头）
        """
        messages = []

        # 注入意图切换提示（放在最前，优先级最高）
        # 作用：明确告知 LLM 用户已切换话题，避免用旧话题内容回答当前问题
        if intent_switched:
            switch_message = SystemMessage(
                content=(
                    "【话题切换提示】用户已切换到新的话题。请基于当前问题独立回答，"
                    "不要受之前对话话题的影响。历史对话仅供理解上下文连续性参考，"
                    "不要将旧话题的内容作为当前问题的答案。"
                )
            )
            messages.append(switch_message)

        # 注入矛盾检测提示
        # 作用：告知 LLM 检索到的文档存在矛盾，应指出差异而非随意选择
        if conflict_result and conflict_result.has_conflict:
            conflict_desc = conflict_result.description or "存在内容矛盾"
            conflict_message = SystemMessage(
                content=(
                    "【矛盾检测提示】检索到的知识库文档之间存在内容矛盾。"
                    f"矛盾描述：{conflict_desc}\n\n"
                    "请在回答中：\n"
                    "1. 指出不同文档之间的差异，不要只选择一方\n"
                    "2. 说明各信息的来源（引用文档编号）\n"
                    "3. 如果无法确定哪个正确，请如实告知用户存在争议\n"
                    "4. 不要隐瞒矛盾信息，让用户知晓完整情况"
                )
            )
            messages.append(conflict_message)

        # 注入历史摘要（记忆衰退机制）
        # 作用：让 LLM 通过摘要获取旧对话的关键信息，弥补近期历史只保留 N 轮的损失
        # 注意：意图切换时调用方应传 None，此处仍保留判断以防调用方未处理
        if summary:
            summary_message = SystemMessage(
                content=(
                    "以下是之前对话的摘要，供你参考长期上下文：\n\n"
                    f"{summary}"
                )
            )
            messages.append(summary_message)

        # 只保留最近的历史记录，避免超出 LLM 上下文长度
        limit = settings.CONVERSATION_HISTORY_LIMIT
        recent_history = conversation_history[-limit:] if conversation_history else []

        for msg in recent_history:
            if msg["role"] == "user":
                messages.append(HumanMessage(content=msg["content"]))
            elif msg["role"] == "assistant":
                messages.append(AIMessage(content=msg["content"]))

        return messages

    # ============================================
    # 构建 LLM 消息 & 降级兜底
    # ============================================

    def _build_messages(
        self,
        question: str,
        context: str,
        history: List[Any],
    ) -> List[BaseMessage]:
        """
        构建发送给 LLM 的消息列表

        作用：
            将 Prompt 模板填充为实际消息列表，供 LLMResilienceService 使用。
            （不再用 LangChain 的 chain 语法，改为直接构建消息，便于容错服务接管）

        实现方式：
            使用 self.prompt.format_messages 填充变量：
            - context: 检索到的知识库内容
            - question: 用户问题
            - history: 对话历史消息列表

        参数：
            question: str - 用户问题
            context: str - 检索结果构建的上下文文本
            history: List[Any] - LangChain 消息列表（来自 _build_history）

        返回：
            List[BaseMessage] - 完整的消息列表（system + history + human）
        """
        return self.prompt.format_messages(
            context=context,
            question=question,
            history=history,
        )

    def _degraded_answer(self, question: str, has_context: bool) -> str:
        """
        生成降级兜底回复

        作用：
            当 LLM 服务完全不可用（熔断打开或主备模型均失败）时，
            返回一段友好的提示文本，避免用户看到裸异常。

        实现方式：
            根据是否有检索结果，返回不同的兜底话术。

        参数：
            question: str - 用户原始问题（用于提示）
            has_context: bool - 是否检索到了相关文档

        返回：
            str - 兜底回复文本
        """
        if has_context:
            return (
                "抱歉，AI 服务当前暂时不可用，请稍后重试。\n\n"
                "我已经检索到可能相关的知识库文档，您可以先查看下方引用来源。"
            )
        return (
            "抱歉，AI 服务当前暂时不可用，请稍后重试。\n\n"
            f"您的问题是：{question}\n"
            "如果持续出现此提示，请联系管理员。"
        )

    def _sanitize_answer(self, answer: str, source_count: int) -> str:
        """
        校验并修正回答中的引用格式

        作用：
            LLM 可能生成不合法的引用标注（如 [文档99] 但实际只有 3 个来源）。
            本方法检查单项 [文档X] 和闭区间 [文档X-Y]，移除超出范围的非法引用，
            避免误导用户。

        实现方式：
            1. 用正则匹配单项或闭区间引用
            2. 检查编号范围是否在 [1, source_count] 且起点不大于终点
            3. 超出范围的引用替换为空（移除方括号引用，保留正文）

        参数：
            answer: str - LLM 生成的原始回答
            source_count: int - 实际检索到的文档来源数量

        返回：
            str - 校验后的回答（非法引用已移除）

        示例：
            # 3 个来源，回答含 [文档5]
            sanitized = self._sanitize_answer("参见[文档5]", 3)
            # → "参见" （[文档5] 被移除，因为 5 > 3）
        """
        if not answer:
            return answer

        # 区间引用包含首尾文档编号，必须整体落在可用来源范围内。
        pattern = re.compile(r"\[文档\s*(\d+)(?:\s*[-–]\s*(\d+))?\]")

        def _replace_invalid(match):
            """Remove citations whose single index or inclusive range is invalid."""
            first = int(match.group(1))
            last = int(match.group(2) or first)
            if 1 <= first <= last <= source_count:
                return match.group(0)  # 合法引用，保留
            logger.debug(
                "移除非法引用 %s（有效范围 1-%s）", match.group(0), source_count
            )
            return ""

        sanitized = pattern.sub(_replace_invalid, answer)

        # 清理移除引用后可能产生的多余空格
        # 作用：如 "参见 [文档5] 的说明" → "参见  的说明" → "参见的说明"
        sanitized = re.sub(r'  +', ' ', sanitized).strip()

        return sanitized

    def _sanitize_chunk(self, chunk: Any) -> Optional[str]:
        """
        流式 chunk 容错处理

        作用：
            流式输出时，单个 chunk 可能因网络/编码问题出现异常值。
            本方法确保每个 chunk 是非空字符串，避免前端处理崩溃。

        处理规则：
            - None / 空字符串 → 返回 None（跳过）
            - bytes → 解码为 str
            - 其他类型 → 转为 str
            - str → 原样返回

        参数：
            chunk: Any - 原始 chunk

        返回：
            Optional[str] - 处理后的字符串，None 表示应跳过该 chunk
        """
        if chunk is None:
            return None

        if isinstance(chunk, bytes):
            try:
                chunk = chunk.decode("utf-8")
            except UnicodeDecodeError:
                logger.warning("流式 chunk 包含无法解码的字节，已跳过")
                return None

        if not isinstance(chunk, str):
            chunk = str(chunk)

        # 空字符串跳过（不发送空 chunk，减少前端无效渲染）
        if not chunk:
            return None

        return chunk

    # ============================================
    # 非流式问答
    # ============================================

    def ask(
        self,
        question: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        top_k: Optional[int] = None,
        user_id: Optional[int] = None,
        document_ids: Optional[List[int]] = None,
        summary: Optional[str] = None,
        intent_switched: bool = False,
        user_type: str = "regular",
        rerank_mode: str = "current",
    ) -> Dict[str, Any]:
        """
        问答（非流式）

        作用：
            完整的 RAG 问答流程：检索 → 构建 Prompt → 调用 LLM → 返回结果。
            一次性返回完整答案，并携带全链路质量指标（metrics）。

            【权限隔离】必须传入 user_id 以限定检索范围，防止越权访问他人文档。
            【记忆衰退】可通过 summary 传入历史摘要，让 LLM 获取长期上下文。
            【意图切换】intent_switched=True 时，不用历史做指代消解，并提示 LLM 已切换话题。

        实现方式：
            1. Query 改写（意图切换时不用历史，避免旧话题污染）
            2. 检索相关文档（限定在用户可访问范围内）
            3. 构建上下文文本
            4. 构建 Prompt（填充上下文、历史和摘要）
            5. 调用 LLM 生成回答
            6. 收集 LLM 指标（从 llm_service.last_metrics 读取）
            7. 返回答案、引用来源、质量指标

        参数：
            question: str - 用户问题
            conversation_history: Optional[List[Dict[str, str]]] - 对话历史
            top_k: Optional[int] - 检索文档数量
            user_id: Optional[int] - 当前用户 ID（用于检索范围限定，强烈建议传入）
            document_ids: Optional[List[int]] - 显式限定文档 ID（与可访问范围取交集）
            summary: Optional[str] - 历史摘要（记忆衰退机制）
                由 HistorySummaryService 生成，注入到 history 头部作为长期上下文。
                意图切换时应由调用方传 None，避免旧话题摘要污染检索。
            intent_switched: bool - 是否检测到意图切换
                True: 用户切换了话题，query 改写不用历史，LLM 提示已切换
                False: 正常多轮对话，使用完整上下文

        返回：
            Dict[str, Any] - 问答结果
            格式：
            {
                "answer": "AI的回答...",
                "sources": [...],
                "question": "用户问题",
                "degraded": false,
                "degrade_reason": null,
                "metrics": {
                    "retrieval_count": 4,
                    "retrieval_top_score": 0.95,
                    "retrieval_time_ms": 120,
                    "llm_time_ms": 2300,
                    "retry_count": 0,
                    "token_input": 1500,
                    "token_output": 300,
                    "model_used": "qwen-plus"
                }
            }

        示例：
            result = rag.ask("如何使用asyncio？", user_id=current_user.id)
            print(result["answer"])
        """
        import time as _time

        # -1. 用户意图识别（最先执行）
        # 作用：判断用户输入是知识库提问、闲聊、追问还是元问题
        #   - kb_query: 走完整 RAG 流程（检索+预生成校验+生成）
        #   - chitchat/followup/meta: 走无检索路径（直接用 LLM 回复，跳过检索和校验）
        # 原因：闲聊/追问不需要检索文档，如果走 RAG 会被预生成校验误拦截
        # Recognized medical questions require evidence, even if intent classification
        # would otherwise route them to retrieval-free chat or follow-up generation.
        medical_query = requires_medical_evidence(question)
        intent = None if medical_query else self._classify_intent(question, conversation_history)
        if intent is not None and not intent.needs_retrieval:
            # 非知识库提问，走无检索生成路径
            # 作用：闲聊/追问/元问题直接用 LLM 回复，不检索文档，不做预生成校验
            return self._generate_without_retrieval(
                question=question,
                conversation_history=conversation_history,
                summary=summary,
                intent=intent,
            )

        # 0. Query 改写（指代消解 + 语义扩展）
        # 作用：用 LLM 改写用户问题，提升检索质量
        #   - 指代消解："那个怎么样" → "asyncio.gather 怎么样"
        #   - 短query扩展："asyncio" → "Python asyncio 异步编程 使用方法"
        #   - 延续性指令："继续" → 提取历史主题补全
        # 关键设计：改写后的 query 仅用于检索，原始 question 仍用于 LLM 生成（保持用户原意）
        # 意图切换时不用历史改写，避免旧话题的指代消解污染当前 query
        # 降级策略：LLM 不可用或超时返回原始 query（query_rewrite_service 内部处理）
        search_query = (
            question if medical_query else self._rewrite_query_for_search(
                question, conversation_history, intent_switched=intent_switched
            )
        )

        # 1. 检索相关文档（限定在用户可访问范围）
        # 作用：用改写后的 query 检索，同时计时用于检索耗时指标
        retrieval_start = _time.time()
        search_results = self.retrieve_context(
            search_query,
            top_k=top_k,
            user_id=user_id,
            document_ids=document_ids,
            user_type=user_type,
            rerank_mode=rerank_mode,
        )
        retrieval_time_ms = int((_time.time() - retrieval_start) * 1000)

        boundary = self._medical_boundary_response(question, search_results, retrieval_time_ms)
        if boundary is not None:
            return boundary

        # 1.5 矛盾检测（检索结果冲突标记）
        # 作用：检测多个文档片段之间是否存在内容矛盾
        #   - 检测到矛盾时，在上下文中标记冲突片段，提示 LLM 谨慎处理
        #   - LLM 不可用或结果少于2条时跳过检测（conflict_detector 内部处理）
        conflict_result = self._detect_conflicts(question, search_results)

        # 1.6 预生成校验（检索质量检查）
        # 作用：在 LLM 生成前校验检索结果质量
        #   - 结果为空/内容过短/分数过低 → 跳过生成，返回兜底回答（避免幻觉+节省成本）
        #   - 分数接近阈值 → 标记低置信度，生成但附加提示
        #   - 正常 → 继续生成
        validation = self._validate_before_generation(question, search_results)
        no_citation_mode = False
        if not validation.should_generate:
            # 任务2 降级策略优化：检索质量不足时，仍将问题提交给 LLM
            # 作用：原实现直接返回兜底文案，用户得不到实际回答；
            #       改为用"无上下文"提示调用 LLM，让其基于通用知识回答，
            #       并在回答前拼接降级提示，明确告知用户答案未基于知识库。
            logger.info(f"预生成校验拦截，降级为无引用模式调用 LLM，原因：{validation.reason}")
            # Prometheus 指标：记录校验拦截和降级
            from app.core.prometheus_metrics import record_validation_skip, record_degradation
            record_validation_skip()
            record_degradation("no_citation")
            no_citation_mode = True
            # 构建无引用上下文，继续走 LLM 调用流程（不 return）
            context = self._build_no_citation_context(question)
        else:
            # 正常路径：构建含检索结果的上下文（含矛盾标记）
            # 作用：冲突片段会被添加 ⚠️ 标记，让 LLM 注意差异
            context = self._build_context(search_results, conflict_result=conflict_result)

        # 3. 构建对话历史（含历史摘要注入 + 意图切换提示 + 矛盾提示）
        # 作用：
        #   - summary 作为 SystemMessage 放在 history 头部，提供长期上下文
        #   - intent_switched=True 时，额外注入 SystemMessage 提示 LLM 用户已切换话题
        #   - 有矛盾时，额外注入矛盾提示让 LLM 指出差异而非随意选择
        history = self._build_history(
            conversation_history or [],
            summary=summary,
            intent_switched=intent_switched,
            conflict_result=conflict_result,
        )

        # 4. 构建 LLM 消息并调用（带重试+熔断+降级）
        # 作用：通过 LLMResilienceService 调用，内置容错链路
        # 注意：这里用原始 question（不是改写后的 search_query），保持用户原意
        messages = self._build_messages(question, context, history)

        # 标记是否降级（用于前端提示）
        degraded = False
        degrade_reason = None
        # LLM 指标容器（降级时为空字典）
        llm_metrics: Dict[str, Any] = {}

        try:
            llm_service = self._get_llm_service()
            answer = llm_service.invoke(messages)
            # 读取 LLM 指标（invoke 内部已重置并填充 last_metrics）
            llm_metrics = llm_service.last_metrics
            # 任务2：无引用模式下，LLM 成功后拼接降级提示并标记降级
            # 作用：明确告知用户本次回答未基于知识库引用，来自模型通用知识
            if no_citation_mode:
                degrade_notice = (
                    "⚠️ 未在知识库中检索到相关引用，以下回答来自模型通用知识，仅供参考。\n\n"
                )
                answer = degrade_notice + answer
                degraded = True
                degrade_reason = "no_citation"
        except Exception as e:
            # LLM 完全不可用（熔断打开或主备模型均失败）→ 走兜底回复
            # 作用：保证用户始终能收到响应，而不是 500 错误
            from app.core.circuit_breaker import CircuitBreakerOpenError
            from app.services.llm_resilience import LLMServiceError

            if isinstance(e, CircuitBreakerOpenError):
                degrade_reason = "circuit_open"
                logger.warning(f"LLM 熔断中，走兜底回复: {e}")
            elif isinstance(e, LLMServiceError):
                degrade_reason = "llm_unavailable"
                logger.error(f"LLM 服务不可用，走兜底回复: {e}")
            else:
                degrade_reason = "unknown_error"
                logger.error(f"LLM 调用未知异常，走兜底回复: {e}", exc_info=True)

            answer = self._degraded_answer(question, has_context=bool(search_results))
            degraded = True

        # 5. 整理引用来源
        # 作用：告诉用户答案来自哪些文档
        sources = []
        for result in search_results:
            sources.append({
                "document_id": result["metadata"].get("document_id"),
                "title": result["metadata"].get("document_title", "未知"),
                "content": result["content"][:200] + "..." if len(result["content"]) > 200 else result["content"],
                "score": result.get("score", 0),
            })

        # 6. 引用格式校验（非降级场景才校验，兜底回复无需校验）
        # 作用：移除 LLM 生成的不合法引用标注（如 [文档99] 但只有 3 个来源）
        if not degraded:
            answer = self._sanitize_answer(answer, len(sources))

        # 7. 组装质量指标
        # 作用：供 QAEvent 埋点使用，记录全链路耗时和状态
        metrics = self._build_metrics(
            search_results=search_results,
            retrieval_time_ms=retrieval_time_ms,
            llm_metrics=llm_metrics,
            degraded=degraded,
        )

        # 低置信度提示（预生成校验标记的低质量检索结果）
        # 作用：检索分数接近阈值时，在回答前附加提示，让用户知晓回答可信度有限
        if validation.confidence == "low":
            answer = (
                "⚠️ 以下回答基于相关性较低的检索结果，仅供参考：\n\n" + answer
            )

        # Prometheus 指标：记录 RAG 全链路指标
        # 作用：将检索/LLM/降级/矛盾等指标推送到 Prometheus，供 Grafana 监控
        from app.core.prometheus_metrics import (
            record_rag_metrics, record_degradation, record_conflict_detected,
        )
        record_rag_metrics(
            metrics, intent_type="kb_query",
            retrieval_happened=True, stream=False,
        )
        if degraded:
            record_degradation(degrade_reason)
        if conflict_result and conflict_result.has_conflict:
            record_conflict_detected()

        return {
            "answer": answer,
            "sources": sources,
            "question": question,
            "degraded": degraded,
            "degrade_reason": degrade_reason,
            "metrics": metrics,
            # 矛盾检测信息（供前端展示警告）
            # 作用：让前端知道检索结果存在矛盾，可展示警告提示用户
            "conflict": self._format_conflict_info(conflict_result),
        }

    def _medical_boundary_response(
        self,
        question: str,
        search_results: list[dict[str, Any]],
        retrieval_time_ms: int,
        *,
        stream: bool = False,
    ) -> dict[str, Any] | None:
        """Preserve both response contracts when a medical evidence rule ends generation."""
        answer = medical_answer_boundary(question, search_results)
        if answer is None:
            return None
        sources = [
            {
                "document_id": result["metadata"].get("document_id"),
                "title": result["metadata"].get("document_title", "未知"),
                "content": result["content"][:200] + "..."
                if len(result["content"]) > 200
                else result["content"],
                "score": result.get("score", 0),
            }
            for result in search_results
        ]
        metrics = self._build_metrics(search_results, retrieval_time_ms, {}, degraded=False)
        from app.core.prometheus_metrics import record_rag_metrics

        record_rag_metrics(metrics, intent_type="kb_query", retrieval_happened=True, stream=stream)
        return {
            "answer": answer,
            "sources": sources,
            "question": question,
            "degraded": False,
            "degrade_reason": None,
            "metrics": metrics,
            "conflict": None,
        }

    def _build_metrics(
        self,
        search_results: List[Dict[str, Any]],
        retrieval_time_ms: int,
        llm_metrics: Dict[str, Any],
        degraded: bool,
    ) -> Dict[str, Any]:
        """
        组装全链路质量指标

        作用：
            将检索指标和 LLM 指标合并为统一格式，供 QAEvent 埋点使用。
            降级场景下 LLM 指标为空，仅返回检索指标。

        参数：
            search_results: List[Dict] - 检索结果（用于提取 count 和 top_score）
            retrieval_time_ms: int - 检索耗时（毫秒）
            llm_metrics: Dict[str, Any] - LLM 服务返回的指标（last_metrics）
            degraded: bool - 是否降级

        返回：
            Dict[str, Any] - 统一指标字典
        """
        # 检索指标
        retrieval_count = len(search_results)
        retrieval_top_score = max(
            (r.get("score", 0) for r in search_results),
            default=0.0,
        )

        # LLM 指标（降级时为空，用默认值）
        return {
            "retrieval_count": retrieval_count,
            "retrieval_top_score": round(retrieval_top_score, 4),
            "retrieval_time_ms": retrieval_time_ms,
            "llm_time_ms": llm_metrics.get("llm_time_ms", 0),
            "retry_count": llm_metrics.get("retry_count", 0),
            "token_input": llm_metrics.get("token_input", 0),
            "token_output": llm_metrics.get("token_output", 0),
            "model_used": llm_metrics.get("model_used", ""),
        }

    def _format_conflict_info(
        self,
        conflict_result: Optional[Any],
    ) -> Optional[Dict[str, Any]]:
        """
        格式化矛盾检测结果为前端友好的字典

        作用：
            将 ConflictResult 转为简洁的字典格式，供前端展示冲突警告。
            无矛盾或检测被跳过时返回 None。

        参数：
            conflict_result: Optional[ConflictResult] - 矛盾检测结果

        返回:
            Optional[Dict[str, Any]] - 格式化的冲突信息
                None: 无矛盾或检测被跳过
                {
                    "has_conflict": true,
                    "description": "矛盾描述",
                    "conflicting_count": 2  // 涉及矛盾的文档数
                }
        """
        if not conflict_result or not conflict_result.has_conflict:
            return None

        # 统计涉及矛盾的文档数量
        # 作用：conflicting_pairs 中可能有重复索引，用集合去重
        conflicted_indices = set()
        for idx1, idx2 in conflict_result.conflicting_pairs:
            conflicted_indices.add(idx1)
            conflicted_indices.add(idx2)

        return {
            "has_conflict": True,
            "description": conflict_result.description,
            "conflicting_count": len(conflicted_indices),
        }

    # ============================================
    # 流式问答
    # ============================================

    async def ask_stream(
        self,
        question: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        top_k: Optional[int] = None,
        user_id: Optional[int] = None,
        document_ids: Optional[List[int]] = None,
        summary: Optional[str] = None,
        intent_switched: bool = False,
        user_type: str = "regular",
        rerank_mode: str = "current",
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        问答（流式输出）

        作用：
            流式返回 AI 的回答，实现打字机效果。
            前端可以通过 SSE（Server-Sent Events）接收。
            done 事件携带全链路质量指标（metrics）。

            【权限隔离】必须传入 user_id 以限定检索范围，防止越权访问他人文档。
            【记忆衰退】可通过 summary 传入历史摘要，让 LLM 获取长期上下文。
            【意图切换】intent_switched=True 时，不用历史做指代消解，并提示 LLM 已切换话题。

        实现方式：
            1. Query 改写（意图切换时不用历史，避免旧话题污染）
            2. 先检索文档并发送引用来源（限定在用户可访问范围）
            3. 然后流式生成回答
            4. 使用 async generator yield 每个块
            5. done 事件携带完整回答和指标

        参数：
            question: str - 用户问题
            conversation_history: Optional[List[Dict[str, str]]] - 对话历史
            top_k: Optional[int] - 检索文档数量
            user_id: Optional[int] - 当前用户 ID（用于检索范围限定，强烈建议传入）
            document_ids: Optional[List[int]] - 显式限定文档 ID（与可访问范围取交集）
            summary: Optional[str] - 历史摘要（记忆衰退机制）
                由 HistorySummaryService 生成，注入到 history 头部作为长期上下文。
                意图切换时应由调用方传 None，避免旧话题摘要污染检索。
            intent_switched: bool - 是否检测到意图切换
                True: 用户切换了话题，query 改写不用历史，LLM 提示已切换
                False: 正常多轮对话，使用完整上下文

        返回：
            AsyncGenerator - 异步生成器，yield 数据块
            数据格式：
            - {"type": "sources", "content": [...]}                    # 引用来源
            - {"type": "chunk", "content": "..."}                      # 回答片段
            - {"type": "done", "content": "...", "metrics": {...}}     # 完整回答+指标

        示例：
            async for chunk in rag.ask_stream("问题？", user_id=current_user.id):
                if chunk["type"] == "sources":
                    print("引用来源:", chunk["content"])
                elif chunk["type"] == "chunk":
                    print(chunk["content"], end="")
                elif chunk["type"] == "done":
                    print("\n完成")
                    print("指标:", chunk.get("metrics"))
        """
        import time as _time

        # -1. 用户意图识别（最先执行）
        # 作用：判断用户输入是知识库提问、闲聊、追问还是元问题
        #   - kb_query: 走完整 RAG 流程（检索+预生成校验+生成）
        #   - chitchat/followup/meta: 走无检索路径（直接用 LLM 回复，跳过检索和校验）
        # 原因：闲聊/追问不需要检索文档，如果走 RAG 会被预生成校验误拦截
        # Apply the same evidence requirement before retrieval-free streaming routes.
        medical_query = requires_medical_evidence(question)
        intent = None if medical_query else self._classify_intent(question, conversation_history)
        if intent is not None and not intent.needs_retrieval:
            # 非知识库提问，走流式无检索生成路径
            # 作用：闲聊/追问/元问题直接用 LLM 流式回复，不检索文档，不做预生成校验
            async for event in self._generate_without_retrieval_stream(
                question=question,
                conversation_history=conversation_history,
                summary=summary,
                intent=intent,
            ):
                yield event
            return

        # 0. Query 改写（指代消解 + 语义扩展）
        # 作用：用 LLM 改写用户问题，提升检索质量
        #   - 指代消解："那个怎么样" → "asyncio.gather 怎么样"
        #   - 短query扩展："asyncio" → "Python asyncio 异步编程 使用方法"
        #   - 延续性指令："继续" → 提取历史主题补全
        # 关键设计：改写后的 query 仅用于检索，原始 question 仍用于 LLM 生成（保持用户原意）
        # 意图切换时不用历史改写，避免旧话题的指代消解污染当前 query
        # 降级策略：LLM 不可用或超时返回原始 query（query_rewrite_service 内部处理）
        search_query = (
            question if medical_query else self._rewrite_query_for_search(
                question, conversation_history, intent_switched=intent_switched
            )
        )

        # 1. 检索相关文档（限定在用户可访问范围）
        # 作用：用改写后的 query 检索，同时计时用于检索耗时指标
        retrieval_start = _time.time()
        search_results = self.retrieve_context(
            search_query,
            top_k=top_k,
            user_id=user_id,
            document_ids=document_ids,
            user_type=user_type,
            rerank_mode=rerank_mode,
        )
        retrieval_time_ms = int((_time.time() - retrieval_start) * 1000)

        boundary = self._medical_boundary_response(
            question, search_results, retrieval_time_ms, stream=True
        )
        if boundary is not None:
            yield {"type": "sources", "content": boundary["sources"]}
            yield {"type": "chunk", "content": boundary["answer"]}
            yield {
                "type": "done",
                "content": boundary["answer"],
                "degraded": False,
                "degrade_reason": None,
                "metrics": boundary["metrics"],
            }
            return

        # 1.5 矛盾检测（检索结果冲突标记）
        # 作用：检测多个文档片段之间是否存在内容矛盾
        #   - 检测到矛盾时，在上下文中标记冲突片段，提示 LLM 谨慎处理
        #   - LLM 不可用或结果少于2条时跳过检测（conflict_detector 内部处理）
        conflict_result = self._detect_conflicts(question, search_results)

        # 1.6 预生成校验（检索质量检查）
        # 作用：在 LLM 生成前校验检索结果质量
        #   - 结果为空/内容过短/分数过低 → 跳过生成，直接 yield 兜底回答
        #   - 分数接近阈值 → 标记低置信度，生成但附加提示
        #   - 正常 → 继续生成
        validation = self._validate_before_generation(question, search_results)
        conflict_info = self._format_conflict_info(conflict_result)

        no_citation_mode = False
        # 引用来源容器（no_citation_mode 时保持空列表，供后续引用校验使用）
        sources = []
        if not validation.should_generate:
            # 任务2 流式降级策略优化：检索质量不足时，仍流式调用 LLM
            # 作用：原实现直接 yield 兜底文案 + return，用户得不到实际回答；
            #       改为用"无上下文"提示流式调用 LLM，先发送降级提示 chunk，
            #       再流式输出 LLM 回答，让用户得到实际内容。
            logger.info(f"流式预生成校验拦截，降级为无引用模式调用 LLM，原因：{validation.reason}")
            # Prometheus 指标：记录校验拦截和降级
            from app.core.prometheus_metrics import record_validation_skip, record_degradation
            record_validation_skip()
            record_degradation("no_citation")
            no_citation_mode = True
            # 构建无引用上下文
            context = self._build_no_citation_context(question)
            # 发送空引用来源（前端显示"无引用"）
            yield {"type": "sources", "content": []}
            # 不再 return，继续走流式 LLM 调用
        else:
            # 正常路径：构建并发送引用来源 + 构建含检索结果的上下文
            for result in search_results:
                sources.append({
                    "document_id": result["metadata"].get("document_id"),
                    "title": result["metadata"].get("document_title", "未知"),
                    "content": result["content"][:200] + "..." if len(result["content"]) > 200 else result["content"],
                    "score": result.get("score", 0),
                })

            # yield 引用来源（含矛盾检测信息，供前端展示警告）
            # 作用：如果有矛盾，前端可以在引用来源区域展示冲突警告
            sources_event = {"type": "sources", "content": sources}
            if conflict_info:
                sources_event["conflict"] = conflict_info
            yield sources_event

            # 构建含检索结果的上下文（含矛盾标记）
            context = self._build_context(search_results, conflict_result=conflict_result)

        # 3. 构建历史（含历史摘要注入 + 意图切换提示 + 矛盾提示）
        # 作用：
        #   - summary 作为 SystemMessage 放在 history 头部，提供长期上下文
        #   - intent_switched=True 时，额外注入 SystemMessage 提示 LLM 用户已切换话题
        #   - 有矛盾时，额外注入矛盾提示让 LLM 指出差异而非随意选择
        history = self._build_history(
            conversation_history or [],
            summary=summary,
            intent_switched=intent_switched,
            conflict_result=conflict_result,
        )

        # 4. 构建 LLM 消息
        # 注意：这里用原始 question（不是改写后的 search_query），保持用户原意
        messages = self._build_messages(question, context, history)

        # 任务2：无引用模式下，先 yield 降级提示 chunk（在 LLM 流式输出前）
        # 作用：让用户立即看到降级提示，随后接收 LLM 基于通用知识的回答
        if no_citation_mode:
            yield {
                "type": "chunk",
                "content": "⚠️ 未在知识库中检索到相关引用，以下回答来自模型通用知识，仅供参考。\n\n",
            }

        # 5. 流式调用 LLM（带重试+熔断+首字超时+降级）
        # 作用：通过 LLMResilienceService 流式调用，容错在服务层处理
        full_answer = ""
        degraded = False
        degrade_reason = None
        llm_metrics: Dict[str, Any] = {}
        # 保存 llm_service 引用，用于在异常后读取 last_metrics
        llm_service = None

        try:
            llm_service = self._get_llm_service()
            async for chunk in llm_service.astream(messages):
                # 流式 chunk 容错
                # 作用：过滤 None/空/异常类型的 chunk，避免前端处理崩溃
                safe_chunk = self._sanitize_chunk(chunk)
                if safe_chunk is None:
                    continue
                full_answer += safe_chunk
                yield {"type": "chunk", "content": safe_chunk}
            # 流式正常结束，读取 LLM 指标
            if llm_service is not None:
                llm_metrics = llm_service.last_metrics
        except Exception as e:
            # LLM 流式失败（熔断打开或主备模型均失败）→ 走兜底回复
            # 作用：保证流式接口也能优雅降级，避免前端收到错误中断
            from app.core.circuit_breaker import CircuitBreakerOpenError
            from app.services.llm_resilience import LLMServiceError

            if isinstance(e, CircuitBreakerOpenError):
                degrade_reason = "circuit_open"
                logger.warning(f"LLM 流式熔断中，走兜底回复: {e}")
            elif isinstance(e, LLMServiceError):
                degrade_reason = "llm_unavailable"
                logger.error(f"LLM 流式服务不可用，走兜底回复: {e}")
            else:
                degrade_reason = "unknown_error"
                logger.error(f"LLM 流式调用未知异常，走兜底回复: {e}", exc_info=True)

            # 尝试读取已部分填充的 LLM 指标（如重试次数）
            if llm_service is not None:
                llm_metrics = llm_service.last_metrics

            degraded = True
            # 兜底回复作为补充分段输出（如果已有部分内容，加换行分隔）
            fallback = self._degraded_answer(question, has_context=bool(search_results))
            if full_answer:
                fallback = "\n\n" + fallback
            full_answer += fallback
            yield {"type": "chunk", "content": fallback}

        # 任务2：无引用模式下，LLM 流式成功后标记降级并将降级提示拼接到最终回答（用于持久化）
        # 作用：done 事件的 content 用于持久化存储，需包含降级提示以保持与非流式一致
        # 条件：no_citation_mode 且 LLM 未失败（degraded=False 表示走 try 成功路径）
        #       LLM 失败时 degraded 已由 except 分支设置为 circuit_open 等，不覆盖
        if no_citation_mode and not degraded:
            degrade_notice = (
                "⚠️ 未在知识库中检索到相关引用，以下回答来自模型通用知识，仅供参考。\n\n"
            )
            full_answer = degrade_notice + full_answer
            degraded = True
            degrade_reason = "no_citation"

        # 6. 引用格式校验（非降级场景才校验）
        # 作用：移除 LLM 生成的不合法引用标注
        # 注意：流式模式下 chunk 已发送给前端无法修改，此处仅校验最终完整回答
        #       用于持久化和 done 事件返回（确保存储的回答是校验后的版本）
        if not degraded:
            sanitized_answer = self._sanitize_answer(full_answer, len(sources))
        else:
            sanitized_answer = full_answer

        # 7. 组装质量指标
        # 作用：供 QAEvent 埋点使用
        metrics = self._build_metrics(
            search_results=search_results,
            retrieval_time_ms=retrieval_time_ms,
            llm_metrics=llm_metrics,
            degraded=degraded,
        )

        # 8. 发送完成信号（携带 degraded 标记、指标和冲突信息，便于前端提示和埋点）
        # 注意：done 事件的 content 是校验后的完整回答（可能与流式拼接的略有差异）

        # 低置信度提示（预生成校验标记的低质量检索结果）
        # 作用：检索分数接近阈值时，在回答前附加提示，让用户知晓回答可信度有限
        if validation.confidence == "low":
            sanitized_answer = (
                "⚠️ 以下回答基于相关性较低的检索结果，仅供参考：\n\n" + sanitized_answer
            )

        done_event = {
            "type": "done",
            "content": sanitized_answer,
            "degraded": degraded,
            "degrade_reason": degrade_reason,
            "metrics": metrics,
        }
        # 如果有矛盾，在 done 事件中也携带冲突信息
        # 作用：前端可在回答完成后展示矛盾警告提示
        if conflict_info:
            done_event["conflict"] = conflict_info

        # Prometheus 指标：记录流式 RAG 全链路指标
        # 作用：将检索/LLM/降级/矛盾等指标推送到 Prometheus
        from app.core.prometheus_metrics import (
            record_rag_metrics, record_degradation, record_conflict_detected,
        )
        record_rag_metrics(
            metrics, intent_type="kb_query",
            retrieval_happened=True, stream=True,
        )
        if degraded:
            record_degradation(degrade_reason)
        if conflict_result and conflict_result.has_conflict:
            record_conflict_detected()

        yield done_event


# ============================================
# 创建全局实例（懒加载）
# ============================================

def get_rag_chain() -> RAGChainService:
    """
    获取 RAG 服务实例（懒加载，线程安全）

    作用：
        避免在应用启动时就创建 RAG 服务（需要 API Key）。
        在实际需要时才创建。
        M-13 修复：使用 threading.Lock 保护单例创建，防止多线程并发
        时创建多个实例（原实现 check-then-create 存在竞态，导致多个
        RAGChainService 实例各自维护独立的 LLM 连接，浪费资源）。

    返回：
        RAGChainService - RAG 服务实例
    """
    global _rag_chain_instance
    if _rag_chain_instance is None:
        with _rag_chain_lock:
            if _rag_chain_instance is None:
                _rag_chain_instance = RAGChainService()
    return _rag_chain_instance


# 全局实例缓存
# M-13 修复：加线程锁防止多线程并发创建重复实例
_rag_chain_instance: Optional[RAGChainService] = None
_rag_chain_lock = threading.Lock()
