"""
PDF 解析与版面分析模块

作用：
    使用 PyMuPDF (fitz) 解析 PDF 文件，提取文本块、图片、表格候选位置。
    支持多栏版面检测和阅读顺序重排。

    核心能力：
        1. 文本块提取（带坐标、字号、字体）
        2. 多栏布局检测（基于 x 坐标聚类）
        3. 阅读顺序重排（按栏优先、Z 顺序）
        4. 页眉页脚标记（基于 y 坐标）
        5. 空白页检测
        6. 图片位置记录（图片本身由 image_processor 处理）

    为何用 PyMuPDF 而非 pypdf：
        - PyMuPDF 提供更精确的坐标信息（fitz.Page.get_text("dict")）
        - 支持字体、字号、颜色等版面特征
        - 解析速度更快
        - 能识别图片位置

实现方式：
    PdfParser.parse_to_context(ctx) 解析 PDF，填充 ctx.raw_text 和 ctx.pages。
    每页的 blocks 按"栏优先"顺序排列，text 为重排后的纯文本。
"""

import logging
import time
from app.core.config import settings
from typing import List, Optional, Dict, Any

from app.services.document_pipeline.context import (
    PipelineContext,
    ParsedPage,
    TextBlock,
)

logger = logging.getLogger(__name__)


class PdfParser:
    """
    PDF 解析器

    作用：
        使用 PyMuPDF 解析 PDF，提取带坐标的文本块，
        检测多栏布局并按阅读顺序重排。

    使用方式：
        parser = PdfParser()
        parser.parse_to_context(ctx)
    """

    # 页眉页脚判定阈值（页面高度的上下 10%）
    _HEADER_FOOTER_RATIO = 0.10

    # 多栏检测：栏间距至少占页面宽度的 15%
    _COLUMN_GAP_RATIO = 0.15

    # 空白页判定：文本字符数低于此值视为空白页
    _BLANK_PAGE_CHAR_THRESHOLD = 10

    def parse_to_context(self, ctx: PipelineContext) -> None:
        """
        解析 PDF 文件并填充上下文

        作用：
            读取 PDF，按页提取文本块、检测版面、重排阅读顺序，
            结果写入 ctx.pages 和 ctx.raw_text。

        实现方式：
            1. fitz.open 打开 PDF
            2. 遍历每页，调用 _parse_page 提取版面信息
            3. 检测多栏布局
            4. 按阅读顺序重排文本块
            5. 拼接每页文本形成 raw_text

        参数：
            ctx: PipelineContext - 流水线上下文

        异常：
            解析失败会抛出异常，由流水线捕获处理
        """
        import fitz  # PyMuPDF

        doc = fitz.open(ctx.file_path)
        pages: List[ParsedPage] = []
        deadline = time.monotonic() + settings.PARSER_MAX_SECONDS
        total_chars = 0

        try:
            if len(doc) > settings.PARSER_MAX_PDF_PAGES:
                raise ValueError("PDF 页数超过解析预算")
            for page_num, page in enumerate(doc, start=1):
                if time.monotonic() > deadline:
                    raise ValueError("PDF 解析超过总时间限制")
                parsed_page = self._parse_page(page, page_num)
                total_chars += len(parsed_page.text)
                if total_chars > settings.PARSER_MAX_TEXT_CHARS:
                    raise ValueError("PDF 文本超过解析预算")
                pages.append(parsed_page)

            ctx.pages = pages
            ctx.raw_text = "\n\n".join(p.text for p in pages if p.text)

        finally:
            doc.close()

    # ============================================
    # 单页解析
    # ============================================

    def _parse_page(self, page, page_number: int) -> ParsedPage:
        """
        解析单页 PDF

        作用：
            提取一页的文本块、检测栏数、按阅读顺序重排。

        实现方式：
            1. 调用 page.get_text("dict") 获取结构化数据
            2. 提取每个 span 作为 TextBlock
            3. 检测多栏布局
            4. 按阅读顺序排序
            5. 拼接为页文本

        参数：
            page: fitz.Page - PyMuPDF 页面对象
            page_number: int - 页码

        返回:
            ParsedPage - 解析后的页面对象
        """
        # 获取页面尺寸
        page_rect = page.rect
        page_width = page_rect.width
        page_height = page_rect.height

        # 提取结构化文本
        # 作用：get_text("dict") 返回带坐标、字体信息的字典
        import fitz
        text_dict = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)

        blocks: List[TextBlock] = []

        # 遍历文本块
        for block in text_dict.get("blocks", []):
            if block.get("type", 0) != 0:
                # 非文本块（图片等），由 image_processor 处理
                continue

            bbox = block.get("bbox", [0, 0, 0, 0])
            x0, y0, x1, y1 = bbox

            # 拼接块内所有行的文本
            block_text = ""
            max_font_size = 0
            is_bold = False

            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    span_text = span.get("text", "")
                    block_text += span_text

                    # 字号
                    font_size = span.get("size", 0)
                    if font_size > max_font_size:
                        max_font_size = font_size

                    # 是否加粗
                    font_flags = span.get("flags", 0)
                    if font_flags & 16:  # bit 4 = bold
                        is_bold = True

                block_text += "\n"

            block_text = block_text.strip()
            if not block_text:
                continue

            # 判定块类型（页眉/页脚/正文）
            block_type = self._classify_block(
                y0, y1, page_height, block_text, max_font_size
            )

            text_block = TextBlock(
                text=block_text,
                page_number=page_number,
                x0=x0,
                y0=y0,
                x1=x1,
                y1=y1,
                block_type=block_type,
                font_size=max_font_size,
                is_bold=is_bold,
            )
            blocks.append(text_block)

        # 检测多栏布局
        column_count = self._detect_columns(blocks, page_width)

        # 按阅读顺序重排
        ordered_blocks = self._reorder_blocks(blocks, column_count, page_width)

        # 拼接页文本
        page_text = "\n\n".join(b.text for b in ordered_blocks if b.text)

        # 判定空白页
        is_blank = len(page_text.strip()) < self._BLANK_PAGE_CHAR_THRESHOLD

        return ParsedPage(
            page_number=page_number,
            text=page_text,
            blocks=ordered_blocks,
            is_blank=is_blank,
            column_count=column_count,
        )

    # ============================================
    # 块类型分类
    # ============================================

    def _classify_block(
        self,
        y0: float,
        y1: float,
        page_height: float,
        text: str,
        font_size: float,
    ) -> str:
        """
        分类文本块类型

        作用：
            根据位置和字号判断块是页眉、页脚、标题还是正文。

        实现方式：
            1. y0 在页面顶部 10% 范围内 → 页眉
            2. y1 在页面底部 10% 范围内 → 页脚
            3. 字号显著大于平均（> 14）→ 标题
            4. 否则 → 正文

        参数：
            y0: float - 块顶部 y 坐标
            y1: float - 块底部 y 坐标
            page_height: float - 页面高度
            text: str - 块文本
            font_size: float - 字号

        返回:
            str - 块类型（header/footer/title/text）
        """
        # 页眉
        if y0 < page_height * self._HEADER_FOOTER_RATIO:
            return "header"

        # 页脚
        if y1 > page_height * (1 - self._HEADER_FOOTER_RATIO):
            return "footer"

        # 标题（字号大于 14 且文本较短）
        if font_size >= 14 and len(text) < 100:
            return "title"

        return "text"

    # ============================================
    # 多栏检测
    # ============================================

    def _detect_columns(
        self,
        blocks: List[TextBlock],
        page_width: float,
    ) -> int:
        """
        检测多栏布局

        作用：
            判断页面是单栏还是多栏布局，影响阅读顺序重排。

        实现方式：
            1. 统计所有文本块的中心 x 坐标
            2. 用 KMeans（k=2）聚类，若两簇中心距离 > 页宽 * 15% 视为双栏
            3. 简化实现：用直方图找两个峰

        参数：
            blocks: List[TextBlock] - 文本块列表
            page_width: float - 页面宽度

        返回:
            int - 栏数（1 或 2）
        """
        if len(blocks) < 4:
            return 1

        # 取所有块的中心 x 坐标
        # 作用：双栏文档的块中心会聚集在两个区域
        centers = [(b.x0 + b.x1) / 2 for b in blocks if b.block_type == "text"]

        if len(centers) < 4:
            return 1

        # 简化聚类：以页宽中点为分界，统计左右块数
        # 作用：双栏文档左栏块中心 < 页宽/2，右栏块中心 > 页宽/2
        mid_x = page_width / 2
        left_count = sum(1 for c in centers if c < mid_x - page_width * 0.05)
        right_count = sum(1 for c in centers if c > mid_x + page_width * 0.05)

        # 两栏都有充足块数才认为是双栏
        # 作用：避免单栏文档因个别块偏移被误判
        if left_count >= 2 and right_count >= 2:
            # 进一步验证：左栏块的 x1 和右栏块的 x0 之间有明显间隔
            left_blocks = [b for b in blocks if (b.x0 + b.x1) / 2 < mid_x]
            right_blocks = [b for b in blocks if (b.x0 + b.x1) / 2 > mid_x]

            if left_blocks and right_blocks:
                left_max_x = max(b.x1 for b in left_blocks)
                right_min_x = min(b.x0 for b in right_blocks)
                gap = right_min_x - left_max_x

                # 间隔大于页宽 15% 确认为双栏
                if gap > page_width * self._COLUMN_GAP_RATIO:
                    return 2

        return 1

    # ============================================
    # 阅读顺序重排
    # ============================================

    def _reorder_blocks(
        self,
        blocks: List[TextBlock],
        column_count: int,
        page_width: float,
    ) -> List[TextBlock]:
        """
        按阅读顺序重排文本块

        作用：
            PDF 提取的块默认按位置顺序，但多栏文档需要按
            "左栏从上到下，再右栏从上到下"的顺序重排。

        实现方式：
            1. 单栏：按 y0 升序排序（从上到下）
            2. 双栏：先按栏（左/右）分组，每栏内按 y0 升序，
                    然后左栏 + 右栏拼接

        参数：
            blocks: List[TextBlock] - 原始文本块
            column_count: int - 栏数
            page_width: float - 页面宽度

        返回:
            List[TextBlock] - 重排后的文本块
        """
        if column_count == 1:
            # 单栏：直接按 y0 升序
            return sorted(blocks, key=lambda b: (b.y0, b.x0))

        # 双栏：先分组
        mid_x = page_width / 2
        left_blocks = [b for b in blocks if (b.x0 + b.x1) / 2 < mid_x]
        right_blocks = [b for b in blocks if (b.x0 + b.x1) / 2 >= mid_x]

        # 每栏内按 y0 升序
        left_blocks.sort(key=lambda b: b.y0)
        right_blocks.sort(key=lambda b: b.y0)

        # 左栏 + 右栏
        return left_blocks + right_blocks

    # ============================================
    # 提取图片位置
    # ============================================

    def extract_image_locations(self, file_path: str) -> List[Dict[str, Any]]:
        """
        提取 PDF 中所有图片的位置信息

        作用：
            返回每页的图片位置列表，供 image_processor 提取图片内容。
            此方法只返回位置，不提取图片二进制（由 image_processor 完成）。

        参数：
            file_path: str - PDF 文件路径

        返回:
            List[Dict[str, Any]] - 图片位置列表
                每项：{"page_number": int, "bbox": (x0,y0,x1,y1), "image_index": int}
        """
        import fitz

        doc = fitz.open(file_path)
        image_locations = []

        try:
            for page_num, page in enumerate(doc, start=1):
                image_list = page.get_images(full=True)
                for img_idx, img in enumerate(image_list):
                    xref = img[0]
                    # 通过 xref 找到图片在页面上的位置
                    rects = page.get_image_rects(xref)
                    for rect in rects:
                        image_locations.append({
                            "page_number": page_num,
                            "bbox": (rect.x0, rect.y0, rect.x1, rect.y1),
                            "image_index": img_idx,
                            "xref": xref,
                        })
        finally:
            doc.close()

        return image_locations
