"""
向量存储模块（生产版 - pgvector）

作用：
    使用 PostgreSQL + pgvector 存储文档的向量表示（Embedding），
    并提供向量检索、关键词检索、混合检索功能。

    替代之前的 Chroma 方案，统一技术栈，减少组件依赖。

    这是 RAG（检索增强生成）流程的核心：
    文档分块 → 向量化（Embedding）→ 存入 pgvector → 相似度检索

实现方式：
    1. 使用 OpenAI Embedding 模型将文本转为向量
    2. 使用 pgvector 的 Vector 类型存储向量
    3. 使用 PostgreSQL tsvector 支持全文检索
    4. 支持混合检索（向量 + 关键词）
    5. 使用 Redis 缓存 Embedding 结果，避免重复计算
    6. 支持本地兜底 Embedding 模型（在线不可用时）
"""

import time
import re
import hashlib
import json
import logging
from typing import List, Dict, Any, Optional
from datetime import datetime

from sqlalchemy import text, func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.redis import RedisManager, RedisKeys
from app.core.circuit_breaker import CircuitBreakerOpenError
from app.models.document import Document
from app.models.document_chunk import DocumentChunk

logger = logging.getLogger(__name__)


class VectorStoreService:
    """
    向量存储服务（pgvector）

    作用：
        管理文档的向量化和检索。
        包括：添加文档块、向量检索、关键词检索、混合检索、删除文档块。

    使用方式：
        store = VectorStoreService()
        store.add_chunks(chunks, document_id=1)
        results = store.search("如何使用异步编程？", top_k=4)
    """

    def __init__(self):
        """
        初始化向量存储服务

        作用：
            获取模型提供者管理器引用，不再直接创建 Embedding 模型实例。

        实现方式：
            - 通过 get_model_manager() 获取全局管理器（懒加载单例）
            - Embedding 客户端（在线/本地）、熔断器、降级路由由 manager 统一管理
            - 保留 Redis 缓存逻辑在本类中（缓存是业务层关注点，不属于模型层）
        """
        from app.core.model_provider import get_model_manager
        self._manager = get_model_manager()

    # ============================================
    # Embedding 模型管理
    # ============================================

    # 注：online_embeddings 和 local_embeddings 属性已移除
    # 作用：Embedding 客户端由 ModelProviderManager 统一管理
    # 降级路由由 FailoverRouter 基于 CircuitBreaker 状态自动决策

    @staticmethod
    def _embedding_space_id(client) -> str:
        config = client.config
        identity = {
            "type": config.type,
            "model": config.model,
            "api_base": config.api_base,
            "dimension": int(client.dimension),
        }
        encoded = json.dumps(identity, sort_keys=True, ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _generate_embedding_with_space(
        self, text: str
    ) -> tuple[Optional[List[float]], str, Optional[str]]:
        """
        生成文本的向量表示

        作用：
            将文本转换为向量（Embedding），用于向量化存储和相似度检索。
            委托给 ModelProviderManager 管理的 EmbeddingModelClient，支持降级路由。

        实现方式：
            1. 先查 Redis 缓存，命中则直接返回
            2. 从 manager 获取 (primary, fallbacks) 客户端列表
            3. 遍历列表，依次尝试 embed_query()
               - 客户端内部已处理熔断+重试
               - FailoverRouter 已按熔断器状态排序（健康者优先）
            4. 成功 → 缓存结果 → 返回 (向量, 模型名)
            5. 全部失败 → 返回 (None, "none")

        参数：
            text: str - 要向量化的文本

        返回：
            tuple[Optional[List[float]], str] - (向量, 使用的模型)
            向量为 None 表示向量化失败

        示例：
            vector, model = store.generate_embedding("异步编程")
        """
        # 1. 从 manager 获取主客户端 + 降级客户端列表
        # 作用：FailoverRouter 按熔断器状态选择健康端点，主模型健康时永远用主模型
        from app.core.model_provider.exceptions import (
            ModelInvocationError,
            ModelClientUnavailableError,
        )

        try:
            primary, fallbacks = self._manager.get_embedding_client_with_fallback()
        except ModelClientUnavailableError:
            logger.error("无可用 Embedding 客户端（未注册或全部 disabled）")
            return None, "none", None

        all_clients = [primary] + list(fallbacks)

        # A cache entry is valid only for the current ordered set of model spaces.
        candidate_spaces = [self._embedding_space_id(client) for client in all_clients]
        cache_identity = hashlib.sha256(
            ("\0".join(candidate_spaces) + "\0" + text).encode("utf-8")
        ).hexdigest()[:32]
        cache_key = RedisKeys.llm_cache(cache_identity)
        cached = RedisManager.get(cache_key)
        if cached and isinstance(cached, dict):
            vector = cached.get("vector")
            space = cached.get("embedding_space")
            if (space in candidate_spaces and isinstance(vector, list)
                    and len(vector) == settings.EMBEDDING_DIMENSION):
                return vector, cached.get("model", "cached"), space

        # 2. 遍历客户端列表，依次尝试
        for client in all_clients:
            try:
                space = self._embedding_space_id(client)
                if int(client.dimension) != settings.EMBEDDING_DIMENSION:
                    logger.warning(
                        "跳过向量维度不兼容的 Embedding 端点（name=%s, dimension=%s, required=%s）",
                        client.name, client.dimension, settings.EMBEDDING_DIMENSION,
                    )
                    continue
                vector = client.embed_query(text)
                if len(vector) != settings.EMBEDDING_DIMENSION:
                    logger.warning(
                        "跳过返回维度不兼容的 Embedding 端点（name=%s, dimension=%s, required=%s）",
                        client.name, len(vector), settings.EMBEDDING_DIMENSION,
                    )
                    continue
                model_used = client.config.model

                # 缓存结果（7天过期）
                RedisManager.set(
                    cache_key,
                    {"vector": vector, "model": model_used, "embedding_space": space},
                    ttl=7 * 24 * 3600
                )

                return vector, model_used, space

            except CircuitBreakerOpenError:
                # 此客户端熔断器打开，尝试下一个降级客户端
                logger.info(f"Embedding 客户端({client.name})熔断器打开，尝试下一个")
                continue

            except ModelInvocationError as e:
                # 此客户端调用失败，尝试下一个降级客户端
                logger.warning(f"Embedding 客户端({client.name})失败: {e}，尝试下一个")
                continue

            except Exception as e:
                # 未知异常，尝试下一个降级客户端
                logger.warning(f"Embedding 客户端({client.name})未知错误: {e}，尝试下一个")
                continue

        # 3. 所有端点均失败
        logger.error(f"所有 Embedding 端点均失败: {[c.name for c in all_clients]}")
        return None, "none", None

    def generate_embedding(self, text: str) -> tuple[Optional[List[float]], str]:
        """Return a vector and model name for existing callers."""
        vector, model, _ = self._generate_embedding_with_space(text)
        return vector, model

    # ============================================
    # 添加文档块
    # ============================================

    def add_chunks(
        self,
        chunks: List[Dict[str, Any]],
        document_id: int
    ) -> int:
        """
        将文档分块向量化并存入 pgvector

        作用：
            将分块后的文本向量化并存入 document_chunks 表。

        实现方式：
            1. 遍历所有块
            2. 为每个块生成向量
            3. 创建 DocumentChunk 记录
            4. 批量保存到数据库
            5. 更新全文检索列

        参数：
            chunks: List[Dict[str, Any]] - 分块数据
                格式：[{"text": "...", "metadata": {...}}, ...]
            document_id: int - 文档ID

        返回：
            int - 成功添加的块数量
        """
        if not chunks:
            return 0

        db: Session = SessionLocal()
        success_count = 0

        try:
            for chunk_data in chunks:
                # 注意：局部变量命名为 chunk_text，避免遮蔽 sqlalchemy.text() 函数
                # （此前用 text 作为变量名，导致下方 db.execute(text(...)) 报
                #  'str' object is not callable，文档处理全部失败）
                chunk_text = chunk_data["text"]
                metadata = chunk_data.get("metadata", {})

                # 生成向量
                vector, model_used, embedding_space = self._generate_embedding_with_space(chunk_text)

                # fail-fast：向量化失败则中止整篇文档处理
                # 作用：embedding 全部端点不可用时 generate_embedding 返回 (None, "none")，
                #       若静默插入 content_vector=NULL 会导致"处理成功但向量检索不到"的隐蔽问题。
                #       抛异常让 Celery 任务明确失败，error_message 透出根因便于排查。
                if vector is None:
                    raise RuntimeError(
                        f"文档块向量化失败：所有 Embedding 端点不可用"
                        f"（model_used={model_used}）。"
                        f"请检查 OPENAI_API_KEY / EMBEDDING_FALLBACK_API_KEY 有效性，"
                        f"如需使用服务端本地 Embedding，请安装可选 ML 依赖、显式启用 provider，"
                        f"并先确认模型维度与现有向量列/索引兼容。"
                    )

                # 创建块记录
                db_chunk = DocumentChunk(
                    document_id=document_id,
                    chunk_index=metadata.get("chunk_index", success_count),
                    content=chunk_text,
                    content_vector=vector,
                    embedding_space=embedding_space,
                    token_count=metadata.get("token_count", 0),
                    page_number=metadata.get("page_number"),
                    char_start=metadata.get("char_start"),
                    char_end=metadata.get("char_end"),
                    metadata_=metadata,
                )

                db.add(db_chunk)
                db.flush()  # 获取 ID

                # 更新全文检索列
                # 作用：使用 to_tsvector 生成全文检索向量
                # 注意：text() 是 sqlalchemy.text()，构造参数化 SQL（非局部变量）
                if db_chunk.id:
                    db.execute(
                        text(
                            "UPDATE document_chunks SET content_tsv = "
                            "to_tsvector('simple', :content) WHERE id = :id"
                        ),
                        {"content": chunk_text, "id": db_chunk.id}
                    )

                success_count += 1

            db.commit()
            logger.info(f"文档 {document_id} 添加了 {success_count} 个块")

        except Exception as e:
            db.rollback()
            logger.error(f"添加文档块失败: {e}")
            raise
        finally:
            db.close()

        return success_count

    # ============================================
    # 向量检索
    # ============================================

    def vector_search(
        self,
        query: str,
        top_k: Optional[int] = None,
        document_ids: Optional[List[int]] = None
    ) -> List[Dict[str, Any]]:
        """
        向量相似度检索

        作用：
            将用户问题向量化，与 pgvector 中的文档向量做余弦相似度匹配，
            返回最相关的文档片段。

        实现方式：
            1. 将查询文本向量化
            2. 使用 pgvector 的 <=> 操作符计算余弦距离
            3. 按 distance 升序排序（越小越相似）
            4. 返回 Top-K 结果

        参数：
            query: str - 用户问题
            top_k: Optional[int] - 返回数量
            document_ids: Optional[List[int]] - 限定检索的文档ID列表

        返回：
            List[Dict[str, Any]] - 检索结果
        """
        if top_k is None:
            top_k = settings.SEARCH_TOP_K

        # 1. 生成查询向量
        query_vector, model_used, embedding_space = self._generate_embedding_with_space(query)
        if query_vector is None:
            logger.error("生成查询向量失败，无法进行向量检索")
            return []

        # 2. 构建SQL查询
        db: Session = SessionLocal()
        try:
            # D4-04 IVFFlat probes 调优：设置检索时扫描的聚类数量
            # 作用：probes 越大召回率越高但速度越慢，默认 10 适合中小规模数据
            # 注意：SET LOCAL 仅在当前事务内有效，不影响其他连接
            # 注意：PostgreSQL SET LOCAL 不支持绑定参数（:probes），必须字面量插值
            #       IVFFLAT_PROBES 为 int 类型配置，强制 int() 校验后插值，杜绝 SQL 注入
            probes_value = int(settings.IVFFLAT_PROBES)
            assert probes_value > 0, "IVFFLAT_PROBES 必须为正整数"
            db.execute(text(f"SET LOCAL ivfflat.probes = {probes_value}"))

            # 使用 pgvector 的 <=> 操作符（余弦距离）
            # distance 范围 [0, 2]，0 表示完全相同
            # similarity = 1 - distance
            sql = """
                SELECT
                    dc.id,
                    dc.document_id,
                    dc.chunk_index,
                    dc.content,
                    dc.page_number,
                    dc.metadata_,
                    d.title as document_title,
                    1 - (dc.content_vector <=> :query_vector) as similarity
                FROM document_chunks dc
                JOIN documents d ON dc.document_id = d.id
                WHERE dc.content_vector IS NOT NULL
                  AND d.is_deleted = false
                  AND d.status IN ('completed', 'low_quality')
                  AND dc.embedding_space = :embedding_space
            """

            params: Dict[str, Any] = {
                "query_vector": str(query_vector),
                "embedding_space": embedding_space,
            }

            # 文档ID过滤（权限隔离关键）
            # 语义：
            #   - document_ids is None：不过滤（仅管理员/内部场景）
            #   - document_ids == []：空集，返回空结果（防止越权：空列表不能被当作"不过滤"）
            #   - document_ids 非空：限定到指定文档
            if document_ids is not None:
                if len(document_ids) == 0:
                    # 空列表明确表示"无可访问文档"，直接返回空，避免越权检索全部
                    return []
                sql += " AND dc.document_id = ANY(:doc_ids)"
                params["doc_ids"] = document_ids

            # 相似度阈值过滤
            sql += " AND 1 - (dc.content_vector <=> :query_vector) >= :threshold"
            params["threshold"] = settings.SIMILARITY_THRESHOLD

            # 排序和限制
            sql += " ORDER BY dc.content_vector <=> :query_vector LIMIT :limit"
            params["limit"] = top_k

            # 执行查询
            result = db.execute(text(sql), params)

            # 整理结果
            search_results = []
            for row in result:
                similarity = float(row.similarity)
                search_results.append({
                    "chunk_id": row.id,
                    "content": row.content,
                    "metadata": {
                        "document_id": row.document_id,
                        "document_title": row.document_title,
                        "chunk_index": row.chunk_index,
                        "page_number": row.page_number,
                        **(row.metadata_ or {}),
                    },
                    "score": similarity,
                })

            return search_results

        except Exception as e:
            logger.error(f"向量检索失败: {e}")
            return []
        finally:
            db.close()

    # ============================================
    # 关键词检索
    # ============================================

    def keyword_search(
        self,
        query: str,
        top_k: Optional[int] = None,
        document_ids: Optional[List[int]] = None
    ) -> List[Dict[str, Any]]:
        """
        关键词检索（全文检索 + 中文 ILIKE 模糊匹配）

        作用：
            使用 PostgreSQL 全文检索 + ILIKE 模糊匹配，按关键词匹配文档。
            作为向量检索的补充和兜底。

            【检索优化修复】原实现 query.strip().split() 对中文无效（中文无空格分词），
            to_tsquery('simple', '辅助系统功能设计') 将整个中文字符串作为单个 token，
            导致中文查询 0 结果。修复后采用双路匹配策略：
            - 英文关键词：to_tsquery 精确匹配（ts_rank 计分）
            - 中文 bigram：ILIKE 模糊匹配（匹配数量计分）

        实现方式：
            1. 调用 _extract_search_keywords() 提取关键词（英文单词 + 中文 2-gram）
            2. 英文关键词用 to_tsquery + ts_rank 匹配计分
            3. 中文 bigram 用 ILIKE OR 模糊匹配，按命中数量计分
            4. 融合两路结果，取最高分

        参数：
            query: str - 用户问题
            top_k: Optional[int] - 返回数量
            document_ids: Optional[List[int]] - 限定检索的文档ID列表

        返回：
            List[Dict[str, Any]] - 检索结果
        """
        if top_k is None:
            top_k = settings.SEARCH_TOP_K

        # 提取关键词（核心修复：中文 2-gram 分词替代 strip().split()）
        keywords = self._extract_search_keywords(query)
        if not keywords:
            return []

        # 区分英文词和中文 bigram/unigram
        english_terms = [k for k in keywords if re.match(r'^[a-z]{2,}$', k)]
        chinese_terms = [
            k for k in keywords
            if re.match(r'^[\u4e00-\u9fa5]+$', k)
        ]

        db: Session = SessionLocal()
        try:
            # 文档ID过滤前置检查（权限隔离，同 vector_search 语义）
            if document_ids is not None and len(document_ids) == 0:
                return []

            results_map: Dict[int, Dict[str, Any]] = {}

            # 1. 英文关键词：to_tsquery 精确匹配（原逻辑，仅对英文有效）
            # 作用：英文技术词如 asyncio、requests 仍用全文检索精确匹配
            if english_terms:
                tsquery = " & ".join(english_terms)
                sql_en = """
                    SELECT
                        dc.id, dc.document_id, dc.chunk_index, dc.content,
                        dc.page_number, dc.metadata_, d.title as document_title,
                        ts_rank(to_tsvector('simple', dc.content), to_tsquery('simple', :tsquery)) as rank
                    FROM document_chunks dc
                    JOIN documents d ON dc.document_id = d.id
                    WHERE to_tsvector('simple', dc.content) @@ to_tsquery('simple', :tsquery)
                      AND d.is_deleted = false
                      AND d.status IN ('completed', 'low_quality')
                """
                params_en: Dict[str, Any] = {"tsquery": tsquery}
                if document_ids is not None:
                    sql_en += " AND dc.document_id = ANY(:doc_ids)"
                    params_en["doc_ids"] = document_ids
                sql_en += " ORDER BY rank DESC LIMIT :limit"
                params_en["limit"] = top_k * 3

                result_en = db.execute(text(sql_en), params_en)
                for row in result_en:
                    score = min(float(row.rank) / 0.1, 1.0)
                    results_map[row.id] = {
                        "chunk_id": row.id,
                        "content": row.content,
                        "metadata": {
                            "document_id": row.document_id,
                            "document_title": row.document_title,
                            "chunk_index": row.chunk_index,
                            "page_number": row.page_number,
                            **(row.metadata_ or {}),
                        },
                        "score": score,
                    }

            # 2. 中文 bigram/unigram：ILIKE 模糊匹配（核心修复）
            # 作用：解决 to_tsquery 对中文不分词导致 0 结果的问题
            # 策略：每个 bigram 用 ILIKE %term% 匹配，OR 连接，按命中数计分
            if chinese_terms:
                # 构建 OR 条件：任一关键词匹配即召回
                like_clauses = []
                like_params: Dict[str, Any] = {}
                for idx, term in enumerate(chinese_terms):
                    param_name = f"kw_{idx}"
                    like_clauses.append(f"dc.content ILIKE :{param_name}")
                    # 转义 ILIKE 通配符（防御性：中文不含 % _，但英文可能含 _）
                    escaped = term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
                    like_params[param_name] = f"%{escaped}%"

                where_clause = " OR ".join(like_clauses)
                total_terms = len(chinese_terms)

                # 构建匹配计数表达式：统计每个 chunk 命中的关键词数量
                # 作用：按命中数量排序，命中越多越相关
                case_parts = [
                    f"(CASE WHEN dc.content ILIKE :kw_{idx} THEN 1 ELSE 0 END)"
                    for idx in range(total_terms)
                ]
                match_count_expr = " + ".join(case_parts)

                sql_cn = f"""
                    SELECT
                        dc.id, dc.document_id, dc.chunk_index, dc.content,
                        dc.page_number, dc.metadata_, d.title as document_title,
                        ({match_count_expr}) as match_count
                    FROM document_chunks dc
                    JOIN documents d ON dc.document_id = d.id
                    WHERE ({where_clause})
                      AND d.is_deleted = false
                      AND d.status IN ('completed', 'low_quality')
                """
                params_cn = dict(like_params)
                if document_ids is not None:
                    sql_cn += " AND dc.document_id = ANY(:doc_ids)"
                    params_cn["doc_ids"] = document_ids
                sql_cn += " ORDER BY match_count DESC LIMIT :limit"
                params_cn["limit"] = top_k * 3

                result_cn = db.execute(text(sql_cn), params_cn)
                for row in result_cn:
                    # 得分 = 命中关键词数 / 总关键词数（归一化 0-1）
                    # 作用：归一化便于与向量检索分数融合
                    score = float(row.match_count) / total_terms
                    if row.id in results_map:
                        # 英文和中文都命中：取最高分
                        existing = results_map[row.id]
                        existing["score"] = max(existing["score"], score)
                    else:
                        results_map[row.id] = {
                            "chunk_id": row.id,
                            "content": row.content,
                            "metadata": {
                                "document_id": row.document_id,
                                "document_title": row.document_title,
                                "chunk_index": row.chunk_index,
                                "page_number": row.page_number,
                                **(row.metadata_ or {}),
                            },
                            "score": score,
                        }

            # 排序并取 top_k
            search_results = sorted(
                results_map.values(),
                key=lambda x: x["score"],
                reverse=True
            )[:top_k]

            return search_results

        except Exception as e:
            logger.error(f"关键词检索失败: {e}")
            return []
        finally:
            db.close()

    def _extract_search_keywords(self, query: str) -> List[str]:
        """
        从查询中提取关键词（用于关键词检索）

        作用：
            对中文查询进行 2-gram 滑窗分词，对英文查询提取单词。
            解决原 query.strip().split() 对中文无效的问题。
            借鉴 intent_service._extract_keywords 的分词策略。

        实现方式：
            1. 提取英文单词（连续字母，长度≥2，转小写）
            2. 提取中文段，按 2 字滑窗切分 bigram
            3. 短中文段（单字）直接保留
            4. 去重

        参数：
            query: str - 用户查询

        返回：
            List[str] - 关键词列表（英文小写 + 中文 bigram/unigram）

        示例：
            _extract_search_keywords("辅助系统功能设计")
            → ["辅助", "助系", "系统", "统功", "功能", "能设", "设计"]
            _extract_search_keywords("如何使用 asyncio.gather")
            → ["如何", "何使", "使用", "asyncio", "gather"]
        """
        if not query:
            return []

        keywords: List[str] = []
        seen: set = set()

        # 英文单词（连续字母，长度≥2）
        # 作用：英文技术词如 python、asyncio 是重要关键词
        for word in re.findall(r'[a-zA-Z]{2,}', query):
            w = word.lower()
            if w not in seen:
                seen.add(w)
                keywords.append(w)

        # 中文 2-gram bigram
        # 作用：中文最小语义单元通常是 2 字词，滑窗能覆盖大部分情况
        for segment in re.findall(r'[\u4e00-\u9fa5]+', query):
            if len(segment) == 1:
                # 单字直接保留（短查询场景）
                if segment not in seen:
                    seen.add(segment)
                    keywords.append(segment)
            else:
                # 2 字滑窗切分
                for i in range(len(segment) - 1):
                    bigram = segment[i:i + 2]
                    if bigram not in seen:
                        seen.add(bigram)
                        keywords.append(bigram)

        return keywords

    # ============================================
    # 混合检索
    # ============================================

    def search(
        self,
        query: str,
        top_k: Optional[int] = None,
        document_ids: Optional[List[int]] = None,
        enable_hybrid: Optional[bool] = None,
        keyword_weight: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """
        混合检索（向量 + 关键词）

        作用：
            结合向量检索和关键词检索的优势：
            - 向量检索：理解语义，"如何异步" 能匹配 "async 方法"
            - 关键词检索：精确匹配，"asyncio.gather" 能精确命中

            通过加权融合两路结果，提升检索质量。

        实现方式：
            1. 并行执行向量检索和关键词检索
            2. 按 chunk_id 合并结果
            3. 加权计算最终分数
            4. 排序并返回 Top-K

        参数：
            query: str - 用户问题
            top_k: Optional[int] - 返回数量
            document_ids: Optional[List[int]] - 限定检索的文档ID列表
            enable_hybrid: Optional[bool] - 是否启用混合检索
            keyword_weight: Optional[float] - 关键词检索权重（0-1）
                任务2：由调用方（rag_chain）根据查询子类型动态传入，
                None 时回退到 settings.KEYWORD_SEARCH_WEIGHT（默认 0.3）
                精确匹配型问题传 0.6，语义型问题传 0.2，混合型传 0.3

        返回：
            List[Dict[str, Any]] - 检索结果
        """
        if top_k is None:
            top_k = settings.SEARCH_TOP_K

        if enable_hybrid is None:
            enable_hybrid = settings.ENABLE_HYBRID_SEARCH

        start_time = time.time()

        # 不启用混合检索，直接用向量检索
        if not enable_hybrid:
            results = self.vector_search(query, top_k, document_ids)

            # 向量检索降级：结果为空时回退到关键词检索
            # 作用：当 Embedding 服务不可用（熔断/超时）导致向量检索无结果时，
            #       用关键词检索兜底，保证至少能返回一些相关文档
            if not results:
                logger.info("向量检索无结果，降级到关键词检索")
                results = self.keyword_search(query, top_k, document_ids)

            return self._filter_by_threshold(results)

        # 混合检索
        # 获取更多候选，然后融合
        candidate_k = top_k * 3

        # 向量检索（权重 1 - KEYWORD_SEARCH_WEIGHT）
        # 作用：语义匹配，理解问题意图
        vector_results = self.vector_search(query, candidate_k, document_ids)

        # 关键词检索（权重 KEYWORD_SEARCH_WEIGHT）
        # 作用：精确匹配，作为向量检索的补充和兜底
        keyword_results = self.keyword_search(query, candidate_k, document_ids)

        # 降级场景：向量检索完全失败（Embedding 不可用），仅用关键词结果
        # 作用：保证 Embedding 服务挂掉时仍能返回检索结果
        if not vector_results and keyword_results:
            logger.info("向量检索无结果，混合检索降级为仅关键词检索")
            results = keyword_results[:top_k]
            for r in results:
                r["score"] = r.get("keyword_score", r.get("score", 0))
            return self._filter_by_threshold(results)

        # 融合结果
        # 作用：按 chunk_id 合并，加权计算分数
        merged: Dict[int, Dict[str, Any]] = {}
        # 任务2：动态混合检索权重
        # 作用：keyword_weight 由调用方（rag_chain）根据查询子类型动态传入，
        #       未传入（None）时回退到默认配置 KEYWORD_SEARCH_WEIGHT
        # 子类型映射：exact_match=0.6 / semantic=0.2 / hybrid=0.3
        if keyword_weight is None:
            keyword_weight = settings.KEYWORD_SEARCH_WEIGHT
        vector_weight = 1 - keyword_weight

        for result in vector_results:
            chunk_id = result["chunk_id"]
            result["vector_score"] = result["score"]
            result["keyword_score"] = 0.0
            result["final_score"] = result["score"] * vector_weight
            merged[chunk_id] = result

        for result in keyword_results:
            chunk_id = result["chunk_id"]
            if chunk_id in merged:
                # 合并
                merged[chunk_id]["keyword_score"] = result["score"]
                merged[chunk_id]["final_score"] += result["score"] * keyword_weight
            else:
                result["vector_score"] = 0.0
                result["keyword_score"] = result["score"]
                result["final_score"] = result["score"] * keyword_weight
                merged[chunk_id] = result

        # 按最终分数排序
        results = sorted(
            merged.values(),
            key=lambda x: x["final_score"],
            reverse=True
        )

        # 取 Top-K
        results = results[:top_k]

        # 统一 score 字段为 final_score
        for result in results:
            result["score"] = result["final_score"]

        elapsed_ms = int((time.time() - start_time) * 1000)
        logger.info(f"混合检索完成，耗时 {elapsed_ms}ms，返回 {len(results)} 条结果")

        return self._filter_by_threshold(results)

    def _filter_by_threshold(
        self,
        results: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        按相似度阈值过滤结果

        作用：
            过滤掉相似度太低的结果，避免不相关内容干扰 LLM。

        参数：
            results: List[Dict[str, Any]] - 检索结果

        返回：
            List[Dict[str, Any]] - 过滤后的结果
        """
        return [
            r for r in results
            if r.get("score", 0) >= settings.SIMILARITY_THRESHOLD
        ]

    # ============================================
    # 删除文档块
    # ============================================

    def delete_document_chunks(self, document_id: int) -> bool:
        """
        删除指定文档的所有块

        作用：
            当用户删除文档时，同时从 pgvector 中删除对应的向量。

        参数：
            document_id: int - 文档ID

        返回：
            bool - 是否删除成功
        """
        db: Session = SessionLocal()
        try:
            db.query(DocumentChunk).filter(
                DocumentChunk.document_id == document_id
            ).delete(synchronize_session=False)
            db.commit()
            logger.info(f"已删除文档 {document_id} 的所有块")
            return True
        except Exception as e:
            db.rollback()
            logger.error(f"删除文档块失败: {e}")
            return False
        finally:
            db.close()

    # ============================================
    # 获取统计信息
    # ============================================

    def get_stats(self) -> Dict[str, Any]:
        """
        获取向量存储统计信息

        作用：
            返回向量数据库的状态，用于监控和统计。

        返回：
            Dict[str, Any] - 统计信息
        """
        db: Session = SessionLocal()
        try:
            # 总块数
            total_chunks = db.query(DocumentChunk).count()

            # 已向量化的块数
            vectorized_chunks = db.query(DocumentChunk).filter(
                DocumentChunk.content_vector.isnot(None)
            ).count()

            # 文档数
            total_documents = db.query(Document).filter(
                Document.is_deleted == False
            ).count()

            return {
                "total_chunks": total_chunks,
                "vectorized_chunks": vectorized_chunks,
                "total_documents": total_documents,
                "vectorization_rate": (
                    vectorized_chunks / total_chunks if total_chunks > 0 else 0
                ),
            }
        except Exception as e:
            logger.error(f"获取统计信息失败: {e}")
            return {}
        finally:
            db.close()


# ============================================
# 创建全局实例（懒加载）
# ============================================

_vector_store_instance: Optional[VectorStoreService] = None


def get_vector_store() -> VectorStoreService:
    """
    获取向量存储服务实例（懒加载）

    作用：
        避免在应用启动时就创建向量服务（需要 API Key）。
        在实际需要时才创建。

    返回：
        VectorStoreService - 向量存储服务实例
    """
    global _vector_store_instance
    if _vector_store_instance is None:
        _vector_store_instance = VectorStoreService()
    return _vector_store_instance
