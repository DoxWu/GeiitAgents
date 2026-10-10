"""
文档处理流水线子包

作用：
    提供模块化的文档处理能力，包括解析、清洗、表格提取、
    图片处理、分块、质量评分。

    替代原 document_processor.py 的简单实现，支持生产级场景：
        - PDF 多栏版面分析
        - 表格结构化提取（含跨页合并）
        - 图片 OCR + 多模态描述
        - 脏数据清洗
        - 质量评分

子模块说明：
    - context: 流水线上下文和数据结构定义
    - cleaner: 脏数据清洗
    - pdf_parser: PDF 解析与版面分析
    - table_extractor: 表格提取与跨页合并
    - image_processor: 图片处理 + OCR + 多模态
    - chunker: 智能分块
    - quality_scorer: 质量评分
    - parsers: 其他格式解析器（MD/TXT/DOCX/URL）
    - pipeline: 主流水线编排器

使用方式：
    from app.services.document_pipeline import get_document_pipeline

    pipeline = get_document_pipeline()
    ctx = pipeline.process(
        file_path="/uploads/doc.pdf",
        file_type=".pdf",
        file_name="doc.pdf",
        document_id=1,
    )
    # ctx.chunks 可直接传给 VectorStoreService.add_chunks
"""

from app.services.document_pipeline.context import (
    PipelineContext,
    ProcessedChunk,
    ParsedPage,
    TextBlock,
    ExtractedTable,
    ExtractedImage,
)

__all__ = [
    "DocumentPipeline",
    "get_document_pipeline",
    "PipelineContext",
    "ProcessedChunk",
    "ParsedPage",
    "TextBlock",
    "ExtractedTable",
    "ExtractedImage",
]


def __getattr__(name):
    # Parser/resource-only callers do not need the embedding/chunking stack.
    if name in {"DocumentPipeline", "get_document_pipeline"}:
        from app.services.document_pipeline import pipeline
        return getattr(pipeline, name)
    raise AttributeError(name)
