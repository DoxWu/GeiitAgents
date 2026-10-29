"""
文档对话路由模块

作用：
    定义文档对话功能的 API 接口，包括：
    - 文件上传（解析文本并存入 Redis 供后续提问）
    - 从文档库选择已处理文档（复用清洗全文+表格+图片描述）
    - 流式提问（基于文档内容进行 SSE 流式回答）

实现方式：
    1. 上传：接收文件 → 保存临时文件 → 解析（PDF 含表格提取+图片处理）→ 清洗 → 截断 → 存入 Redis
    2. 从文档库选择：查询 Document → 权限校验 → 取 content + 表格/图片块 → 截断 → 存入 Redis
    3. 提问：从 Redis 读取文档 → 构造系统提示词 → 调用 LLM 流式接口 → SSE 返回
    4. 对话历史存储在 Redis 中，支持多轮追问
"""

import json
import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import update

from langchain_core.messages import SystemMessage, HumanMessage, AIMessage

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import rate_limit
from app.services.request_concurrency import concurrency_limit
from app.core.redis import RedisManager
from app.api.deps import get_current_regular_user
from app.models.user import User
from app.models.document import Document
from app.models.conversation import Conversation, Message
from app.schemas.document_chat import (
    DocumentChatUploadResponse,
    DocumentChatRequest,
    DocumentFromLibraryRequest,
)
from app.services.document_pipeline.parsers import (
    MarkdownParser,
    TxtParser,
    DocxParser,
)
from app.services.document_pipeline.pdf_parser import PdfParser
from app.services.document_pipeline.cleaner import TextCleaner
from app.services.document_pipeline.table_extractor import TableExtractor
from app.services.document_pipeline.image_processor import ImageProcessor
from app.services.document_pipeline.context import PipelineContext
from app.services.permission import permission_service
from app.services.llm_resilience import get_llm_service, LLMServiceError


# 模块日志器
# 作用：记录文档解析失败、Redis 操作异常等关键事件，便于排查问题
logger = logging.getLogger(__name__)

# 创建路由器
router = APIRouter(prefix="/document-chat", tags=["文档对话"])


# ============================================
# 常量定义
# ============================================

# 文档对话文件大小上限：10MB
# 作用：文档对话只解析文本放入 LLM 上下文，无需持久化存储，限制 10MB 避免内存压力
MAX_DOC_CHAT_FILE_SIZE = 10 * 1024 * 1024

# 解析后文本最大字符数：约 12000 token，留出问答空间
# 作用：LLM 上下文窗口有限，截断过长文档确保有空间容纳问题和回答
MAX_DOC_CHAT_TEXT_LENGTH = 50000

# Redis 会话 TTL：1 小时
# 作用：文档对话是临时会话，1 小时后自动清理，避免 Redis 内存膨胀
DOC_CHAT_SESSION_TTL = 3600

# 对话历史最大轮数
# 作用：限制历史消息数量，避免上下文过长超出 token 限制
MAX_HISTORY_TURNS = 20

# 支持的文件类型白名单
SUPPORTED_FILE_TYPES = {".pdf", ".docx", ".md", ".txt"}

# 分块读取大小（1MB），用于分块写入临时文件
_CHUNK_SIZE = 1024 * 1024


# ============================================
# 文档上传
# ============================================

@router.post(
    "/upload",
    response_model=DocumentChatUploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="上传文档（文档对话）",
    # 限流：每分钟最多 RATE_LIMIT_ASK_PER_MINUTE 次，复用问答限流配额
    dependencies=[Depends(rate_limit("ask", per_minute=settings.RATE_LIMIT_ASK_PER_MINUTE))],
)
async def upload_document_for_chat(
    file: UploadFile = File(..., description="要上传的文档（支持 .pdf/.docx/.md/.txt，最大 10MB）"),
    current_user: User = Depends(get_current_regular_user),
) -> Any:
    """
    上传文档接口（文档对话）

    作用：
        接收用户上传的文件，解析提取纯文本，清洗后存入 Redis。
        返回 session_id 供后续流式提问使用。

    实现方式：
        1. 校验文件类型（白名单）和大小（10MB）
        2. 保存到临时文件（settings.UPLOAD_DIR）
        3. 根据文件类型选择解析器提取文本
        4. 用 TextCleaner 清洗文本
        5. 截断到最大 50000 字符
        6. 生成 session_id，存入 Redis（TTL 1 小时）
        7. 删除临时文件
        8. 返回上传响应

    请求：
        - multipart/form-data 格式
        - file: 文件

    响应（201）：
        {
            "session_id": "uuid-xxx",
            "file_name": "paper.pdf",
            "file_type": ".pdf",
            "file_size": 102400,
            "char_count": 35000,
            "truncated": false
        }

    错误：
        400: 文件类型不支持 / 文件过大 / 解析失败
    """
    # 1. 校验文件名和类型（白名单）
    # 作用：防止上传危险文件类型，仅允许文本类文档
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": {"code": "INVALID_FILE", "message": "文件名不能为空"}},
        )

    file_ext = os.path.splitext(file.filename)[1].lower()
    if file_ext not in SUPPORTED_FILE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": "INVALID_FILE_TYPE",
                    "message": f"不支持的文件类型: {file_ext}，支持: {', '.join(sorted(SUPPORTED_FILE_TYPES))}",
                }
            },
        )

    # 2. 确保上传目录存在
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)

    # 3. 分块写入临时文件 + 边写边检查大小（防内存 DoS）
    # 作用：避免一次性读取大文件导致 OOM，分块写入并检查累计大小
    safe_filename = os.path.basename(file.filename)
    unique_filename = f"{uuid.uuid4().hex}_{safe_filename}"
    tmp_path = os.path.join(settings.UPLOAD_DIR, unique_filename)

    file_size = 0
    try:
        with open(tmp_path, "wb") as f:
            while True:
                chunk = await file.read(_CHUNK_SIZE)
                if not chunk:
                    break
                file_size += len(chunk)
                # 超过大小限制，立即中止并清理
                if file_size > MAX_DOC_CHAT_FILE_SIZE:
                    f.close()
                    _safe_remove(tmp_path)
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail={
                            "error": {
                                "code": "FILE_TOO_LARGE",
                                "message": f"文件过大，最大支持 {MAX_DOC_CHAT_FILE_SIZE // (1024 * 1024)}MB",
                            }
                        },
                    )
                f.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        _safe_remove(tmp_path)
        logger.error(f"文档对话文件保存失败: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": {"code": "FILE_WRITE_ERROR", "message": "文件保存失败"}},
        )

    # 4. 解析文档提取文本
    # 作用：根据文件类型选择解析器，提取纯文本放入流水线上下文
    try:
        document_text = _parse_document(tmp_path, file_ext)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"文档解析失败: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": "PARSE_ERROR",
                    "message": f"文档解析失败: {type(e).__name__}",
                }
            },
        )
    finally:
        # 无论解析成功与否，都删除临时文件和图片目录
        # 作用：ImageProcessor 会在文件同目录创建 images_<文件名>/ 存放提取的图片，
        #       需一并清理避免磁盘泄漏
        _safe_remove(tmp_path)
        if file_ext == ".pdf":
            image_dir_name = f"images_{os.path.splitext(os.path.basename(tmp_path))[0]}"
            image_dir_path = os.path.join(settings.UPLOAD_DIR, image_dir_name)
            _safe_remove_dir(image_dir_path)

    # 5. 清洗文本（仅非 PDF 类型）
    # 作用：PDF 在 _parse_document 内部已完成清洗（含表格/图片处理），无需重复清洗；
    #       非 PDF 类型（docx/md/txt）返回的是 raw_text，需单独清洗
    if file_ext != ".pdf":
        try:
            document_text = _clean_text(document_text)
        except Exception as e:
            # 清洗失败不阻断流程，使用原始文本
            logger.warning(f"文本清洗失败，使用原始文本: {e}")

    # 6. 截断过长文档
    # 作用：LLM 上下文窗口有限，截断确保有空间容纳问答
    truncated = False
    if len(document_text) > MAX_DOC_CHAT_TEXT_LENGTH:
        document_text = document_text[:MAX_DOC_CHAT_TEXT_LENGTH]
        truncated = True

    # 7. 生成 session_id 并存入 Redis
    session_id = uuid.uuid4().hex
    redis_key = f"doc_chat:{session_id}"
    session_data = {
        "file_name": safe_filename,
        "file_type": file_ext,
        "file_size": file_size,
        "text": document_text,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "user_id": current_user.id,
    }

    if not RedisManager.set(redis_key, session_data, ttl=DOC_CHAT_SESSION_TTL):
        logger.error(f"文档对话会话存入 Redis 失败: session_id={session_id}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": {"code": "REDIS_ERROR", "message": "会话存储失败，请稍后重试"}},
        )

    logger.info(
        f"文档对话上传成功: user_id={current_user.id}, session_id={session_id}, "
        f"file={safe_filename}, chars={len(document_text)}, truncated={truncated}"
    )

    # 8. 返回响应
    return DocumentChatUploadResponse(
        session_id=session_id,
        file_name=safe_filename,
        file_type=file_ext,
        file_size=file_size,
        char_count=len(document_text),
        truncated=truncated,
    )


# ============================================
# 从文档库选择文档
# ============================================

@router.post(
    "/from-library",
    response_model=DocumentChatUploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="从文档库选择文档进行对话",
    dependencies=[Depends(rate_limit("ask", per_minute=settings.RATE_LIMIT_ASK_PER_MINUTE))],
)
async def select_document_from_library(
    request_data: DocumentFromLibraryRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_regular_user),
) -> Any:
    """
    从文档库选择文档接口（文档对话）

    作用：
        用户从个人文档库或公共文档库中选择已处理完成的文档，
        复用其已清洗的全文内容（含表格、图片描述）进行文档对话，
        无需重新上传和解析。

    实现方式：
        1. 查询 Document（未软删除、status=completed）
        2. 权限校验：文档所有者 或 公共文档库可见
        3. 取 document.content（已清洗全文）作为主文本
        4. 补充查询 document_chunks 中的表格和图片描述块
        5. 合并文本 → 截断到 50000 字符 → 存入 Redis
        6. 返回 session_id

    权限隔离：
        - 用户仅可选择自己上传的文档 或 公共文档库中的文档
        - 游客用户被 get_current_regular_user 拦截
        - 防止通过 document_id 越权访问他人私有文档

    请求体：
        {"document_id": 1}

    响应（201）：
        {
            "session_id": "uuid-xxx",
            "file_name": "paper.pdf",
            "file_type": ".pdf",
            "file_size": 102400,
            "char_count": 35000,
            "truncated": false
        }

    错误：
        404: 文档不存在 / 未处理完成 / 无权访问
        400: 文档内容为空
    """
    # 1. 查询文档（未软删除）
    document = db.query(Document).filter(
        Document.id == request_data.document_id,
        Document.is_deleted == False,
    ).first()

    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": {"code": "DOCUMENT_NOT_FOUND", "message": "文档不存在"}},
        )

    # 2. 权限校验
    if not permission_service.can_access_document(db, current_user.id, document.id, current_user.is_superuser):
        # 出于安全考虑，权限不足时返回 404 而非 403，避免泄露文档存在性
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": {"code": "DOCUMENT_NOT_FOUND", "message": "文档不存在"}},
        )

    # 3. 校验文档处理状态
    # 作用：只有 completed 状态的文档才有可用的全文内容
    if document.status != "completed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": "DOCUMENT_NOT_READY",
                    "message": f"文档尚未处理完成（当前状态: {document.status}），请等待处理完成后再选择",
                }
            },
        )

    # 4. 取主文本（已清洗全文）
    # 作用：document.content 由流水线清洗后存储，复用避免重新解析
    document_text = document.content or ""

    # 5. 补充表格和图片描述块
    # 作用：document.content 只存纯文本，表格和图片描述作为独立块存于 document_chunks
    #       补充这些内容可让 LLM 理解表格结构和图片信息
    try:
        from app.models.document_chunk import DocumentChunk

        extra_chunks = db.query(DocumentChunk).filter(
            DocumentChunk.document_id == document.id,
        ).all()

        table_texts: list[str] = []
        image_texts: list[str] = []

        for chunk in extra_chunks:
            # metadata_ 是 JSON 字段，存储 chunk_type 等信息
            chunk_meta = chunk.metadata_ or {}
            chunk_type = chunk_meta.get("chunk_type", "text")

            if chunk_type == "table" and chunk.content:
                table_texts.append(chunk.content)
            elif chunk_type == "image_description" and chunk.content:
                image_texts.append(chunk.content)

        # 合并表格内容
        if table_texts:
            document_text += "\n\n===文档中的表格===\n"
            document_text += "\n\n".join(table_texts)

        # 合并图片描述
        if image_texts:
            document_text += "\n\n===文档中的图片描述===\n"
            document_text += "\n\n".join(image_texts)

    except Exception as e:
        # 补充块查询失败不阻断流程，使用已有的纯文本
        logger.warning(f"查询文档补充块失败，仅使用纯文本: {e}")

    # 6. 校验内容非空
    if not document_text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": "EMPTY_CONTENT",
                    "message": "文档内容为空，无法进行对话",
                }
            },
        )

    # 7. 截断过长文档
    truncated = False
    if len(document_text) > MAX_DOC_CHAT_TEXT_LENGTH:
        document_text = document_text[:MAX_DOC_CHAT_TEXT_LENGTH]
        truncated = True

    # 8. 生成 session_id 并存入 Redis
    session_id = uuid.uuid4().hex
    redis_key = f"doc_chat:{session_id}"
    session_data = {
        "file_name": document.file_name,
        "file_type": document.file_type,
        "file_size": document.file_size,
        "text": document_text,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "user_id": current_user.id,
        "source": "library",
        "source_document_id": document.id,
    }

    if not RedisManager.set(redis_key, session_data, ttl=DOC_CHAT_SESSION_TTL):
        logger.error(f"文档对话会话存入 Redis 失败: session_id={session_id}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": {"code": "REDIS_ERROR", "message": "会话存储失败，请稍后重试"}},
        )

    logger.info(
        f"文档对话从文档库选择成功: user_id={current_user.id}, session_id={session_id}, "
        f"document_id={document.id}, chars={len(document_text)}, truncated={truncated}"
    )

    # 9. 返回响应
    return DocumentChatUploadResponse(
        session_id=session_id,
        file_name=document.file_name,
        file_type=document.file_type,
        file_size=document.file_size,
        char_count=len(document_text),
        truncated=truncated,
    )


# ============================================
# 流式提问（SSE）
# ============================================

@router.post(
    "/ask/stream",
    summary="文档对话提问（流式输出）",
    # 限流：每分钟最多 RATE_LIMIT_ASK_PER_MINUTE 次
    dependencies=[
        Depends(rate_limit("ask", per_minute=settings.RATE_LIMIT_ASK_PER_MINUTE)),
        Depends(concurrency_limit("chat", per_user=settings.CHAT_MAX_CONCURRENT_PER_USER,
                                   global_limit=settings.CHAT_MAX_CONCURRENT_GLOBAL), scope="request"),
        Depends(concurrency_limit("provider", per_user=settings.MODEL_MAX_CONCURRENT_PER_USER,
                                   global_limit=settings.MODEL_MAX_CONCURRENT_GLOBAL), scope="request"),
    ],
)
def ask_document_stream(
    request_data: DocumentChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_regular_user),
) -> StreamingResponse:
    """
    文档对话提问接口（流式输出）

    作用：
        基于上传的文档内容，流式返回 AI 的回答。
        使用 SSE（Server-Sent Events）协议，实现打字机效果。
        支持多轮对话，历史记录存储在 Redis 中。
        修复问题1：对话记录同步持久化到数据库 conversation/message 表，在侧边栏对话历史中显示。

    实现方式：
        1. 从 Redis 获取文档内容（不存在返回 404）
        2. 创建或获取 Conversation（首次提问自动创建，标题为"📄 文件名"）
        3. 保存用户问题到数据库 Message 表
        4. 构造系统提示词（包含文档全文）
        5. 获取对话历史（从 Redis）
        6. 构造 LangChain 消息列表
        7. 调用 LLM 流式接口
        8. 通过 SSE 返回数据块
        9. 流结束后保存对话历史到 Redis + 保存 AI 回答到数据库

    请求体：
        {
            "session_id": "uuid-xxx",
            "question": "请总结这篇文档"
        }

    响应：
        SSE 格式，每行一个事件：
        data: {"type": "chunk", "content": "这是"}

        data: {"type": "chunk", "content": "总结"}
        ...
        data: {"type": "done", "content": "完整回答..."}

    错误：
        404: 会话不存在或已过期
        503: LLM 服务不可用
    """
    # 1. 从 Redis 获取文档内容
    session_key = f"doc_chat:{request_data.session_id}"
    session_data = RedisManager.get(session_key)

    if not session_data or not isinstance(session_data, dict):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": {
                    "code": "SESSION_NOT_FOUND",
                    "message": "文档会话不存在或已过期，请重新上传文档",
                }
            },
        )

    document_text = session_data.get("text", "")
    if not document_text:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": {
                    "code": "SESSION_NOT_FOUND",
                    "message": "文档内容为空，请重新上传文档",
                }
            },
        )

    # 2. 构造系统提示词
    # 作用：将文档全文注入系统提示词，作为 LLM 的上下文
    system_prompt = (
        "你是一个文档分析助手。用户上传了以下文档，请根据文档内容回答问题。\n"
        "如果问题超出文档范围，请说明并尝试提供有用的信息。\n"
        "支持的任务包括但不限于：阅读理解、翻译、总结、解释等。\n\n"
        f"===文档内容===\n{document_text}\n===文档内容结束==="
    )

    # 3. 获取对话历史
    # 作用：从 Redis 读取历史问答，支持多轮追问
    history_key = f"doc_chat:{request_data.session_id}:history"
    history_raw = RedisManager.get(history_key)
    history = history_raw if isinstance(history_raw, list) else []

    # 修复上下文丢失：Redis 历史为空时，从数据库 Message 表加载历史作为 fallback
    # 作用：Redis TTL 过期（1 小时）或 session_id 切换导致历史丢失时，
    #       从数据库恢复历史，避免 LLM 看不到之前的对话导致上下文丢失
    # 触发条件：Redis 历史为空 + 前端传入了 conversation_id（说明是已有对话的延续）
    if not history and request_data.conversation_id:
        try:
            db_messages = db.query(Message).filter(
                Message.conversation_id == request_data.conversation_id,
            ).order_by(Message.created_at.asc()).all()
            for msg in db_messages:
                history.append({"role": msg.role, "content": msg.content})
            if history:
                # 回写 Redis 缓存，避免下次请求再次查库
                RedisManager.set(history_key, history, ttl=DOC_CHAT_SESSION_TTL)
                logger.info(
                    f"从数据库恢复文档对话历史: conversation_id={request_data.conversation_id}, "
                    f"msgs={len(history)}"
                )
        except Exception as e:
            # 数据库历史加载失败不阻塞主流程，使用空历史继续生成
            logger.warning(f"从数据库加载文档对话历史失败: {e}")

    # 4. 构造 LangChain 消息列表
    # 结构：[SystemMessage, ...history, HumanMessage(question)]
    messages: list = [SystemMessage(content=system_prompt)]

    # 将历史记录转为 LangChain 消息
    # 作用：历史中偶数位为 user，奇数位为 assistant，保持顺序
    for msg in history[-MAX_HISTORY_TURNS * 2:]:
        role = msg.get("role")
        content = msg.get("content", "")
        if role == "user":
            messages.append(HumanMessage(content=content))
        elif role == "assistant":
            messages.append(AIMessage(content=content))

    # 当前问题
    messages.append(HumanMessage(content=request_data.question))

    # 5. 创建或获取 Conversation + 保存用户问题到数据库
    # 修复问题1：将文档对话持久化到数据库 conversation/message 表，在侧边栏对话历史中显示
    file_name = session_data.get("file_name", "文档对话")
    conversation = None
    if request_data.conversation_id:
        # 尝试获取已有对话（校验归属和活跃状态）
        conversation = db.query(Conversation).filter(
            Conversation.id == request_data.conversation_id,
            Conversation.user_id == current_user.id,
            Conversation.is_active == True,
        ).first()

    if not conversation:
        # 首次提问，自动创建对话
        conversation = Conversation(
            user_id=current_user.id,
            title=f"📄 {file_name}",
        )
        db.add(conversation)
        db.commit()
        db.refresh(conversation)

    # 保存用户问题到 Message 表
    user_message = Message(
        conversation_id=conversation.id,
        role="user",
        content=request_data.question,
    )
    db.add(user_message)
    db.commit()

    # 6. 流式调用 LLM 并通过 SSE 返回
    # 捕获纯值，避免在生成器中依赖请求作用域对象
    question_text = request_data.question
    session_id_val = request_data.session_id
    conv_id = conversation.id

    async def event_stream():
        """
        SSE 事件生成器

        作用：
            调用 LLM 流式接口，将文本块转为 SSE 格式发送给前端。
            流结束后将本轮问答保存到 Redis 历史记录 + 数据库 Message 表。

        实现方式：
            - 调用 llm_service.astream(messages) 获取流式响应
            - 每个 chunk 包装为 SSE 事件
            - 累积完整回答
            - 流结束后保存历史记录（Redis + 数据库）
            - done 事件携带 conversation_id 供前端刷新侧边栏
            - 异常时保存部分内容到 Redis + 数据库，发送脱敏错误事件
        """
        full_answer = ""

        try:
            llm_service = get_llm_service()

            # 流式调用 LLM
            async for chunk in llm_service.astream(messages):
                if not chunk:
                    continue
                full_answer += chunk
                # 转为 SSE 格式
                sse_data = {
                    "type": "chunk",
                    "content": chunk,
                }
                yield f"data: {json.dumps(sse_data, ensure_ascii=False)}\n\n"

            # 发送完成事件（携带 conversation_id 供前端刷新侧边栏）
            done_data = {
                "type": "done",
                "content": full_answer,
                "conversation_id": conv_id,
            }
            yield f"data: {json.dumps(done_data, ensure_ascii=False)}\n\n"

            # 保存对话历史到 Redis（支持多轮追问的 LLM 上下文）
            _save_history(
                history_key,
                history,
                question_text,
                full_answer,
            )

            # 保存 AI 回答到数据库 Message 表（使用独立 session 避免 StreamingResponse session 失效）
            from app.core.database import SessionLocal as _SessionLocal
            post_db = _SessionLocal()
            try:
                assistant_message = Message(
                    conversation_id=conv_id,
                    role="assistant",
                    content=full_answer,
                )
                post_db.add(assistant_message)
                # 原子递增 turn_count
                post_db.execute(
                    update(Conversation)
                    .where(Conversation.id == conv_id)
                    .values(turn_count=Conversation.turn_count + 1)
                    .execution_options(synchronize_session=False)
                )
                post_db.commit()
            finally:
                post_db.close()

        except LLMServiceError:
            # LLM 服务不可用，发送脱敏错误事件
            logger.error(
                f"文档对话 LLM 调用失败: session_id={session_id_val}",
                exc_info=True,
            )
            # 保存部分内容到 Redis 历史 + 数据库
            if full_answer:
                _save_history(
                    history_key,
                    history,
                    question_text,
                    full_answer,
                )
                from app.core.database import SessionLocal as _ErrSessionLocal
                err_db = _ErrSessionLocal()
                try:
                    partial_message = Message(
                        conversation_id=conv_id,
                        role="assistant",
                        content=full_answer,
                        is_degraded=True,
                        degrade_reason="stream_error",
                    )
                    err_db.add(partial_message)
                    err_db.execute(
                        update(Conversation)
                        .where(Conversation.id == conv_id)
                        .values(turn_count=Conversation.turn_count + 1)
                        .execution_options(synchronize_session=False)
                    )
                    err_db.commit()
                except Exception:
                    pass  # 保存部分回答失败不影响错误事件发送
                finally:
                    err_db.close()
            error_data = {
                "type": "error",
                "content": "抱歉，AI 服务暂时不可用，请稍后重试",
            }
            yield f"data: {json.dumps(error_data, ensure_ascii=False)}\n\n"

        except Exception:
            # 其他异常，发送脱敏错误事件
            logger.exception(
                f"文档对话流式处理异常: session_id={session_id_val}"
            )
            # 保存部分内容到 Redis 历史 + 数据库
            if full_answer:
                _save_history(
                    history_key,
                    history,
                    question_text,
                    full_answer,
                )
                from app.core.database import SessionLocal as _ErrSessionLocal2
                err_db = _ErrSessionLocal2()
                try:
                    partial_message = Message(
                        conversation_id=conv_id,
                        role="assistant",
                        content=full_answer,
                        is_degraded=True,
                        degrade_reason="stream_error",
                    )
                    err_db.add(partial_message)
                    err_db.execute(
                        update(Conversation)
                        .where(Conversation.id == conv_id)
                        .values(turn_count=Conversation.turn_count + 1)
                        .execution_options(synchronize_session=False)
                    )
                    err_db.commit()
                except Exception:
                    pass
                finally:
                    err_db.close()
            error_data = {
                "type": "error",
                "content": "抱歉，回答生成过程中出现错误，请稍后重试",
            }
            yield f"data: {json.dumps(error_data, ensure_ascii=False)}\n\n"

    # 6. 返回流式响应
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",  # 禁用缓存
            "Connection": "keep-alive",   # 保持连接
            "X-Accel-Buffering": "no",    # Nginx 禁用缓冲
        },
    )


# ============================================
# 辅助函数
# ============================================

def _parse_document(file_path: str, file_type: str) -> str:
    """
    解析文档提取纯文本（含表格和图片描述）

    作用：
        根据文件类型选择对应的解析器，提取文档纯文本。
        对于 PDF 文件，额外执行表格提取和图片处理（OCR + 多模态描述），
        将表格的 Markdown 表示和图片描述合并到最终文本中，
        让 LLM 能理解表格结构和图片信息。

    实现方式：
        - .pdf → PdfParser + TextCleaner + TableExtractor + ImageProcessor
                  （合并 cleaned_text + 表格 Markdown + 图片描述）
        - .docx → DocxParser
        - .md → MarkdownParser
        - .txt → TxtParser

    参数：
        file_path: str - 文件路径
        file_type: str - 文件扩展名（如 .pdf）

    返回：
        str - 提取的纯文本（PDF 含表格和图片描述）

    异常：
        文件解析失败时抛出异常，由调用方捕获处理
    """
    # 创建流水线上下文，复用现有解析器
    # 作用：PdfParser 只提供 parse_to_context 接口，需通过上下文调用
    ctx = PipelineContext(
        file_path=file_path,
        file_type=file_type,
        file_name=os.path.basename(file_path),
    )

    if file_type == ".pdf":
        # PDF：完整解析 → 清洗 → 表格提取 → 图片处理 → 合并
        # 作用：PDF 文档结构复杂，需提取表格和图片以保留完整信息
        PdfParser().parse_to_context(ctx)

        # 清洗文本（PdfParser 填充 raw_text，TextCleaner 产出 cleaned_text）
        TextCleaner().clean(ctx)

        # 表格提取（pdfplumber，含跨页表格合并）
        # 作用：表格转为 Markdown 格式，让 LLM 能理解表格结构
        try:
            TableExtractor().extract(ctx)
        except Exception as e:
            logger.warning(f"文档对话表格提取失败（不影响主流程）: {e}")

        # 图片处理（OCR + 多模态描述）
        # 作用：将图片中的文字和视觉信息转为文本，纳入 LLM 上下文
        # 依赖配置：ENABLE_OCR / ENABLE_VISION 控制是否启用
        try:
            ImageProcessor().extract(ctx)
        except Exception as e:
            logger.warning(f"文档对话图片处理失败（不影响主流程）: {e}")

        # 合并所有内容为统一文本
        # 作用：LLM 上下文需要单一文本流，将正文、表格、图片描述按段落拼接
        return _compose_full_text(ctx)

    elif file_type == ".docx":
        ctx.raw_text = DocxParser().parse(file_path)
    elif file_type == ".md":
        ctx.raw_text = MarkdownParser().parse(file_path)
    elif file_type == ".txt":
        ctx.raw_text = TxtParser().parse(file_path)
    else:
        raise ValueError(f"不支持的文件类型: {file_type}")

    return ctx.raw_text


def _compose_full_text(ctx: PipelineContext) -> str:
    """
    合并流水线上下文中的正文、表格、图片描述为统一文本

    作用：
        将 PipelineContext 的 cleaned_text、tables（Markdown）、images（OCR + 描述）
        按逻辑顺序拼接为单一文本流，供 LLM 作为上下文。

    实现方式：
        1. 以 cleaned_text 为主体
        2. 追加表格区块（每张表格的 Markdown 表示）
        3. 追加图片描述区块（OCR 文本 + 多模态描述）
        4. 各区块用清晰分隔标记，便于 LLM 理解结构

    参数：
        ctx: PipelineContext - 流水线上下文（已执行解析、清洗、表格提取、图片处理）

    返回：
        str - 合并后的完整文本
    """
    parts: list[str] = []

    # 1. 正文（已清洗）
    main_text = ctx.cleaned_text or ctx.raw_text or ""
    if main_text.strip():
        parts.append(main_text.strip())

    # 2. 表格（Markdown 格式）
    # 作用：表格作为结构化数据，Markdown 格式让 LLM 能理解行列关系
    if ctx.tables:
        table_parts: list[str] = []
        for table in ctx.tables:
            if table.markdown:
                caption = f"（{table.caption}）" if table.caption else ""
                table_parts.append(f"[表格{table.table_id + 1}{caption}]\n{table.markdown}")
        if table_parts:
            parts.append("===文档中的表格===\n" + "\n\n".join(table_parts))

    # 3. 图片描述（OCR + 多模态）
    # 作用：图片中的文字和视觉信息转为文本，补充纯文本无法表达的内容
    if ctx.images:
        image_parts: list[str] = []
        for img in ctx.images:
            desc_sections: list[str] = []
            if img.ocr_text:
                desc_sections.append(f"OCR文字: {img.ocr_text}")
            if img.description:
                desc_sections.append(f"图片描述: {img.description}")
            if desc_sections:
                image_parts.append(
                    f"[图片{img.image_id + 1}（第{img.page_number}页）]\n"
                    + "；".join(desc_sections)
                )
        if image_parts:
            parts.append("===文档中的图片内容===\n" + "\n\n".join(image_parts))

    return "\n\n".join(parts)


def _clean_text(text: str) -> str:
    """
    清洗文本

    作用：
        使用 TextCleaner 对解析后的文本执行清洗，
        去除不可见字符、重复空白、乱码片段等。

    实现方式：
        1. 创建 PipelineContext 并设置 raw_text
        2. 调用 TextCleaner.clean(ctx)
        3. 返回 ctx.cleaned_text（清洗失败时返回原文）

    参数：
        text: str - 原始文本

    返回：
        str - 清洗后的文本
    """
    ctx = PipelineContext(
        file_path="",
        file_type="",
        file_name="",
    )
    ctx.raw_text = text

    cleaner = TextCleaner()
    cleaner.clean(ctx)

    # 清洗失败时 cleaned_text 会回退为 raw_text
    return ctx.cleaned_text or ctx.raw_text


def _save_history(
    history_key: str,
    history: list,
    question: str,
    answer: str,
) -> None:
    """
    保存对话历史到 Redis

    作用：
        将本轮问答追加到历史记录，支持多轮追问。
        历史记录与文档会话共享 TTL。

    实现方式：
        1. 将问题和回答追加到历史列表
        2. 限制最大轮数，超出时截断旧消息
        3. 写入 Redis（TTL 与文档会话一致）

    参数：
        history_key: str - Redis key
        history: list - 已有的历史记录
        question: str - 本轮问题
        answer: str - 本轮回答
    """
    try:
        updated_history = list(history)
        updated_history.append({"role": "user", "content": question})
        updated_history.append({"role": "assistant", "content": answer})

        # 限制历史长度，超出时丢弃最早的对话
        # 作用：避免历史过长导致 token 超限
        max_messages = MAX_HISTORY_TURNS * 2
        if len(updated_history) > max_messages:
            updated_history = updated_history[-max_messages:]

        RedisManager.set(history_key, updated_history, ttl=DOC_CHAT_SESSION_TTL)
    except Exception as e:
        # 历史保存失败不影响主流程（本轮回答已返回给用户）
        logger.warning(f"对话历史保存失败: {e}")


def _safe_remove(file_path: str) -> None:
    """
    安全删除文件

    作用：
        删除临时文件，文件不存在或删除失败时静默处理。
        避免清理异常影响主流程。

    参数：
        file_path: str - 文件路径
    """
    try:
        if file_path and os.path.exists(file_path):
            os.remove(file_path)
    except Exception as e:
        logger.warning(f"删除临时文件失败: {file_path}, {e}")


def _safe_remove_dir(dir_path: str) -> None:
    """
    安全删除目录（递归）

    作用：
        删除临时图片目录及其内容，目录不存在或删除失败时静默处理。
        避免清理异常影响主流程。

    参数：
        dir_path: str - 目录路径
    """
    try:
        if dir_path and os.path.exists(dir_path):
            import shutil
            shutil.rmtree(dir_path)
    except Exception as e:
        logger.warning(f"删除临时目录失败: {dir_path}, {e}")
