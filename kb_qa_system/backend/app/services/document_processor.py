"""
文档处理模块（兼容入口 + 流水线封装）

作用：
    本模块是文档处理的统一入口，提供两层接口：

    1. 兼容接口（向后兼容现有路由）：
        - extract_text(file_path, file_type) -> str
          仅解析返回原始文本，不做完整流水线处理
        - split_text(text) -> List[str]
          仅做基础分块
        - split_text_with_metadata(text, document_id, document_title)
          分块并附加元数据
        - extract_from_url(url) -> str
        - get_file_type(filename) / is_allowed_file_type(filename)
          静态工具方法

    2. 流水线接口（生产推荐，Celery 任务调用）：
        - process_document(file_path, file_type, file_name, ...)
          执行完整流水线（解析→清洗→表格→图片→分块→质量评分）
          返回 PipelineContext，包含 chunks、quality_score 等

实现方式：
    1. DocumentProcessor 类作为门面（Facade），委托给 document_pipeline 子包
    2. 兼容接口内部调用对应解析器和分块器
    3. 流水线接口委托给 DocumentPipeline.process()

迁移指南：
    现有路由调用：
        text = document_processor.extract_text(path, type)
        chunks = document_processor.split_text_with_metadata(text, doc_id, title)
    建议迁移到：
        ctx = document_processor.process_document(path, type, name, doc_id, title)
        chunks = ctx.to_chunk_dicts()
        # ctx.quality_score, ctx.quality_issues 可用于质量评估
"""

import logging
from typing import List, Dict, Any, Optional
from pathlib import Path

from app.core.config import settings
from app.services.document_pipeline.context import PipelineContext
from app.services.document_pipeline.parsers import (
    MarkdownParser,
    TxtParser,
    DocxParser,
    UrlParser,
)

logger = logging.getLogger(__name__)


class DocumentProcessor:
    """
    文档处理器（门面类）

    作用：
        提供文档处理的统一接口，内部委托给 document_pipeline 子包。
        既保持向后兼容，又暴露完整流水线能力。

    使用方式：
        # 兼容接口（旧代码）
        text = document_processor.extract_text("doc.pdf", ".pdf")
        chunks = document_processor.split_text_with_metadata(text, 1, "示例")

        # 流水线接口（推荐）
        ctx = document_processor.process_document(
            file_path="doc.pdf",
            file_type=".pdf",
            file_name="doc.pdf",
            document_id=1,
            document_title="示例文档",
        )
        chunk_dicts = ctx.to_chunk_dicts()
    """

    def __init__(self):
        """
        初始化文档处理器

        作用：
            创建解析器和分块器实例（兼容接口使用）。
            流水线实例通过 get_document_pipeline() 懒加载。
        """
        # 兼容接口使用的解析器
        # 作用：extract_text 直接调用对应解析器，不走完整流水线
        self.markdown_parser = MarkdownParser()
        self.txt_parser = TxtParser()
        self.docx_parser = DocxParser()
        self.url_parser = UrlParser()

        # 兼容接口使用的分块器
        # 作用：split_text 直接调用分块器
        self._text_splitter = None

    @property
    def text_splitter(self):
        if self._text_splitter is None:
            from app.services.document_pipeline.chunker import TextChunker
            self._text_splitter = TextChunker().text_splitter
        return self._text_splitter

    # ============================================
    # 流水线接口（推荐）
    # ============================================

    def process_document(
        self,
        file_path: str,
        file_type: str,
        file_name: str,
        document_id: Optional[int] = None,
        document_title: str = "",
    ) -> PipelineContext:
        """
        执行完整文档处理流水线（推荐接口）

        作用：
            调用 DocumentPipeline.process 执行完整流水线，
            返回包含 chunks、quality_score 等的 PipelineContext。
            Celery 异步任务应调用此方法。

        实现方式：
            委托给 get_document_pipeline().process()

        参数：
            file_path: str - 文件路径
            file_type: str - 文件类型（.pdf/.md/.txt/.docx/.url）
            file_name: str - 文件名
            document_id: Optional[int] - 文档ID
            document_title: str - 文档标题

        返回:
            PipelineContext - 包含完整处理结果
                - ctx.chunks: 分块列表
                - ctx.quality_score: 质量分（0-100）
                - ctx.quality_issues: 质量问题列表
                - ctx.to_chunk_dicts(): 转为向量存储入参格式
        """
        from app.services.document_pipeline.pipeline import get_document_pipeline
        pipeline = get_document_pipeline()
        return pipeline.process(
            file_path=file_path,
            file_type=file_type,
            file_name=file_name,
            document_id=document_id,
            document_title=document_title,
        )

    def compute_file_hash(self, file_path: str) -> Optional[str]:
        """
        计算文件哈希（用于去重）

        作用：
            委托给 DocumentPipeline.compute_file_hash。
            计算文件 SHA256 哈希，相同哈希的文件不重复存储。

        参数：
            file_path: str - 文件路径

        返回:
            Optional[str] - SHA256 哈希（失败返回 None）
        """
        from app.services.document_pipeline.pipeline import DocumentPipeline
        return DocumentPipeline.compute_file_hash(file_path)

    # ============================================
    # 兼容接口：文本提取
    # ============================================

    def extract_text(self, file_path: str, file_type: str) -> str:
        """
        从文件中提取文本内容（兼容接口）

        作用：
            根据文件类型调用对应的解析器，仅提取原始文本。
            不做清洗、分块、表格提取等完整流水线处理。

            ⚠️ 注意：此接口仅返回原始文本，丢失了表格、图片、版面信息。
            推荐使用 process_document 获取完整处理结果。

        实现方式：
            1. 通过文件扩展名判断类型
            2. 调用对应解析器的 parse 方法
            3. 返回原始文本字符串

        参数：
            file_path: str - 文件路径
            file_type: str - 文件类型（扩展名，如 .pdf/.md/.txt/.docx）

        返回:
            str - 提取的纯文本内容

        异常:
            ValueError: 不支持的文件类型
            Exception: 文件解析失败
        """
        file_type = file_type.lower()

        if file_type == ".pdf":
            # PDF 走完整解析器（含版面分析），但只返回 raw_text
            from app.services.document_pipeline.pdf_parser import PdfParser
            from app.services.document_pipeline.context import PipelineContext
            ctx = PipelineContext(
                file_path=file_path,
                file_type=file_type,
                file_name=Path(file_path).name,
            )
            PdfParser().parse_to_context(ctx)
            return ctx.raw_text
        elif file_type in (".md", ".markdown"):
            return self.markdown_parser.parse(file_path)
        elif file_type == ".txt":
            return self.txt_parser.parse(file_path)
        elif file_type == ".docx":
            return self.docx_parser.parse(file_path)
        else:
            raise ValueError(f"不支持的文件类型: {file_type}")

    def extract_from_url(self, url: str) -> str:
        """
        从网页 URL 提取文本内容（含图片文本，任务3增强）

        作用：
            下载网页，提取正文文本，并提取图片 OCR/描述文本，
            拼接为完整内容返回。
            含 Content-Type 检测：非 HTML 资源抛出 ValueError("URL_NOT_HTML:...")。

        实现方式：
            调用 UrlParser.parse_with_images 一次下载同时提取文本和图片：
            1. 下载网页 HTML（含 SSRF 防护）
            2. 检测 Content-Type，非 HTML 抛出明确异常
            3. 提取正文文本
            4. 提取图片文本（OCR + 多模态描述，过滤小图片）
            5. 拼接正文 + 图片文本返回

        参数：
            url: str - 网页 URL（已经过 SSRF 校验）

        返回:
            str - 提取的文本内容（正文 + 图片文本）

        异常:
            ValueError - 非 HTML 资源时抛出（消息含 "URL_NOT_HTML" 标识）
            requests.RequestException - 下载失败
        """
        return self.url_parser.parse_with_images(url)

    # ============================================
    # 兼容接口：分块
    # ============================================

    def split_text(self, text: str) -> List[str]:
        """
        将长文本切分为小块（兼容接口）

        作用：
            使用 RecursiveCharacterTextSplitter 进行基础分块。
            不包含表格、图片处理。

        参数：
            text: str - 原始长文本

        返回:
            List[str] - 分块后的文本列表
        """
        if not text or not text.strip():
            return []

        return self.text_splitter.split_text(text)

    def split_text_with_metadata(
        self,
        text: str,
        document_id: int,
        document_title: str,
    ) -> List[Dict[str, Any]]:
        """
        分块并附加元数据（兼容接口）

        作用：
            在分块的同时，为每个块添加元数据。
            元数据格式与 VectorStoreService.add_chunks 入参兼容。

        实现方式：
            1. 调用 split_text 进行分块
            2. 为每个块构造 {"text": ..., "metadata": {...}} 字典

        参数：
            text: str - 原始文本
            document_id: int - 文档ID
            document_title: str - 文档标题

        返回:
            List[Dict[str, Any]] - 包含文本和元数据的字典列表
                格式：
                [
                    {
                        "text": "分块内容...",
                        "metadata": {
                            "document_id": 1,
                            "document_title": "Python指南",
                            "chunk_index": 0,
                            "chunk_type": "text",
                            "page_number": None,
                            "token_count": 100
                        }
                    },
                    ...
                ]
        """
        chunks = self.split_text(text)

        result = []
        for index, chunk in enumerate(chunks):
            # 粗略估算 Token 数
            token_count = max(1, int(len(chunk) / 1.5))

            result.append({
                "text": chunk,
                "metadata": {
                    "document_id": document_id,
                    "document_title": document_title,
                    "chunk_index": index,
                    "chunk_type": "text",
                    "page_number": None,  # 兼容接口无页码信息
                    "char_start": None,
                    "char_end": None,
                    "token_count": token_count,
                }
            })

        return result

    # ============================================
    # 静态工具方法
    # ============================================

    @staticmethod
    def get_file_type(filename: str) -> str:
        """
        从文件名获取文件类型（扩展名）

        作用：
            提取文件扩展名，统一转为小写。

        参数：
            filename: str - 文件名

        返回:
            str - 小写扩展名（如 .pdf/.md）
        """
        return Path(filename).suffix.lower()

    @staticmethod
    def is_allowed_file_type(filename: str) -> bool:
        """
        检查文件类型是否被允许

        作用：
            上传文件时验证类型，防止上传不支持的文件。

        参数：
            filename: str - 文件名

        返回:
            bool - 是否允许上传
        """
        file_type = DocumentProcessor.get_file_type(filename)
        return file_type in settings.ALLOWED_FILE_TYPES

    # M-23 修复：扩展名 -> 期望 MIME 类型映射，用于双重校验
    # 作用：仅校验扩展名可被伪造（evil.exe 重命名为 evil.pdf），增加 MIME 校验
    #   一个扩展名可能对应多个合法 MIME（如 .md 有 text/markdown、text/x-markdown），
    #   只要 content_type 命中其一即通过；content_type 为空时降级为仅扩展名校验（兼容性）
    _EXT_MIME_MAP: Dict[str, List[str]] = {
        ".pdf": ["application/pdf"],
        ".md": ["text/markdown", "text/x-markdown", "text/plain"],
        ".markdown": ["text/markdown", "text/x-markdown", "text/plain"],
        ".txt": ["text/plain", "text/markdown"],
        ".docx": [
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/octet-stream",  # 部分 SDK 上传 docx 时 content_type 退化
        ],
    }

    @staticmethod
    def validate_file_mime_type(filename: str, content_type: Optional[str]) -> bool:
        """
        校验文件 MIME 类型与扩展名是否一致（M-23 修复）

        作用：
            扩展名校验仅防止上传不支持的类型，但无法防止"伪造扩展名"攻击
            （如将 evil.exe 重命名为 evil.pdf）。本方法对 content_type 做白名单校验：
            - content_type 必须在该扩展名允许的 MIME 列表内
            - content_type 为空（部分客户端不传）时降级为通过（兼容性优先）

        参数：
            filename: str - 文件名（用于推断扩展名）
            content_type: Optional[str] - 客户端声明的 MIME 类型（file.content_type）

        返回:
            bool - True 表示 MIME 类型合法或无法校验（兼容），False 表示不一致
        """
        # content_type 为空时降级通过（兼容部分客户端不传 content_type 的场景）
        if not content_type:
            return True

        file_type = DocumentProcessor.get_file_type(filename)
        allowed_mimes = DocumentProcessor._EXT_MIME_MAP.get(file_type)
        if not allowed_mimes:
            # 扩展名不在映射表中（理论上 is_allowed_file_type 已拦截），降级通过
            return True

        # content_type 可能含 charset 后缀（如 "text/plain; charset=utf-8"），取分号前部分
        mime_main = content_type.split(";")[0].strip().lower()
        return mime_main in [m.lower() for m in allowed_mimes]


# ============================================
# 创建全局实例
# ============================================

"""
作用：
    创建全局文档处理器实例，避免重复创建。
    其他模块通过 `from app.services.document_processor import document_processor` 导入。

    - 兼容接口（extract_text / split_text_with_metadata）保持原行为
    - 流水线接口（process_document）提供生产级处理能力
"""
document_processor = DocumentProcessor()
