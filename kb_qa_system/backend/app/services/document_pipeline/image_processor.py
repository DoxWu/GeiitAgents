"""
图片处理、OCR 与多模态理解模块

作用：
    从 PDF 中提取图片，使用 OCR 识别图片中的文字，
    使用多模态模型（GPT-4V）生成图片描述。

    核心能力：
        1. 图片提取（PyMuPDF 提取图片二进制并保存）
        2. OCR 文字识别（pytesseract，支持中英文）
        3. 多模态图片描述（OpenAI Vision API）
        4. 优雅降级（OCR/Vision 不可用时跳过，不阻断流水线）

    为何需要图片处理：
        纯文本提取会丢失图片中的信息（流程图、图表、示意图），
        通过 OCR + 多模态描述把这些信息转为文本，纳入检索范围。

实现方式：
    ImageProcessor.extract(ctx) 提取图片、OCR、生成描述，写入 ctx.images。
"""

import os
import logging
import hashlib
from typing import List, Optional

from app.services.document_pipeline.context import (
    PipelineContext,
    ExtractedImage,
)

logger = logging.getLogger(__name__)


class ImageProcessor:
    """
    图片处理器

    作用：
        从 PDF 提取图片，OCR 识别文字，多模态模型生成描述。

    使用方式：
        processor = ImageProcessor()
        processor.extract(ctx)
        # ctx.images 已填充
    """

    # OCR 支持的语言
    # 作用：中文 + 英文混合识别
    _OCR_LANG = "chi_sim+eng"

    # 多模态描述的 Prompt
    # 作用：引导模型生成对检索友好的图片描述
    _VISION_PROMPT = (
        "请详细描述这张图片的内容，重点关注：\n"
        "1. 图片类型（流程图/图表/示意图/截图/照片等）\n"
        "2. 主要元素和结构\n"
        "3. 文字内容（如有）\n"
        "4. 图片传达的核心信息\n"
        "请用简洁的中文回答，便于检索。"
    )

    # 最小图片尺寸（小于则跳过，避免噪声）
    _MIN_IMAGE_SIZE = 50 * 50

    def __init__(self):
        """
        初始化图片处理器

        作用：
            懒加载 OCR 引擎和多模态客户端管理器引用，避免启动时加载。
            多模态客户端由 ModelProviderManager 统一管理（含重试/熔断/降级）。
        """
        self._tesseract_available: Optional[bool] = None
        self._manager = None

    # ============================================
    # 主入口
    # ============================================

    def extract(self, ctx: PipelineContext) -> None:
        """
        图片处理主入口

        作用：
            从 PDF 提取图片，OCR 识别文字，多模态模型生成描述。
            写入 ctx.images。

        实现方式：
            1. 检查配置是否启用
            2. 仅 PDF 文件支持图片提取
            3. 创建图片存储目录
            4. 遍历每页提取图片
            5. 对每张图片执行 OCR 和多模态描述
            6. 失败则降级（仅保留能拿到的信息）

        参数：
            ctx: PipelineContext - 流水线上下文
        """
        from app.core.config import settings

        # 配置开关
        if not settings.ENABLE_OCR and not settings.ENABLE_VISION:
            logger.info("图片处理（OCR + 多模态）已禁用，跳过")
            return

        # 仅 PDF 文件支持
        if ctx.file_type.lower() != ".pdf":
            return

        ctx.start_step("ocr")

        try:
            import fitz  # PyMuPDF

            # 创建图片存储目录
            # 作用：提取的图片保存到磁盘，便于后续引用
            image_dir = os.path.join(
                os.path.dirname(ctx.file_path),
                f"images_{ctx.document_id}"
            )
            os.makedirs(image_dir, exist_ok=True)

            doc = fitz.open(ctx.file_path)
            images: List[ExtractedImage] = []
            image_id_counter = 0

            try:
                for page_num, page in enumerate(doc, start=1):
                    page_images = self._extract_images_from_page(
                        page, page_num, image_id_counter, image_dir, ctx
                    )
                    images.extend(page_images)
                    image_id_counter += len(page_images)
            finally:
                doc.close()

            ctx.images = images

            ctx.finish_step(
                "ocr",
                success=True,
                input_count=image_id_counter,
                output_count=len(images),
            )
            ctx.set_progress(75)

            logger.info(
                f"图片处理完成：提取 {len(images)} 张图片，"
                f"OCR 启用={settings.ENABLE_OCR}，多模态启用={settings.ENABLE_VISION}"
            )

        except ImportError:
            logger.warning("PyMuPDF 未安装，跳过图片处理")
            ctx.finish_step("ocr", success=False, error="PyMuPDF not installed")

        except Exception as e:
            logger.error(f"图片处理失败: {e}", exc_info=True)
            ctx.finish_step("ocr", success=False, error=str(e))
            ctx.add_issue(f"图片处理失败: {e}")

    # ============================================
    # 单页图片提取
    # ============================================

    def _extract_images_from_page(
        self,
        page,
        page_number: int,
        start_id: int,
        image_dir: str,
        ctx: PipelineContext,
    ) -> List[ExtractedImage]:
        """
        从单页提取图片

        作用：
            遍历页面中的所有图片，提取二进制并保存为文件，
            然后对每张图片执行 OCR 和多模态描述。

        实现方式：
            1. page.get_images(full=True) 获取图片引用列表
            2. doc.extract_image(xref) 提取图片二进制
            3. 保存到磁盘
            4. 调用 _ocr_image 识别文字
            5. 调用 _describe_image 生成描述

        参数：
            page: fitz.Page - 页面对象
            page_number: int - 页码
            start_id: int - 起始图片 ID
            image_dir: str - 图片保存目录
            ctx: PipelineContext - 流水线上下文

        返回:
            List[ExtractedImage] - 该页的图片列表
        """
        from app.core.config import settings

        images = []
        image_list = page.get_images(full=True)

        for idx, img_info in enumerate(image_list):
            xref = img_info[0]

            try:
                # 提取图片二进制
                # 作用：doc.extract_image 返回 {"image": bytes, "ext": "png", ...}
                doc = page.parent
                base_image = doc.extract_image(xref)

                image_bytes = base_image.get("image")
                image_ext = base_image.get("ext", "png")

                if not image_bytes:
                    continue

                # 检查图片尺寸（避免过小图片）
                # 作用：装饰性小图标无检索价值
                width = base_image.get("width", 0)
                height = base_image.get("height", 0)
                if width * height < self._MIN_IMAGE_SIZE:
                    continue

                # 保存图片到磁盘
                image_filename = f"page{page_number}_img{idx}.{image_ext}"
                image_path = os.path.join(image_dir, image_filename)
                with open(image_path, "wb") as f:
                    f.write(image_bytes)

                # OCR 识别
                ocr_text = ""
                if settings.ENABLE_OCR:
                    ocr_text = self._ocr_image(image_path)

                # 多模态描述
                description = ""
                if settings.ENABLE_VISION:
                    description = self._describe_image(image_path)

                # 无任何文本信息则跳过
                # 作用：纯装饰图无价值
                if not ocr_text and not description:
                    continue

                image = ExtractedImage(
                    image_id=start_id + idx,
                    page_number=page_number,
                    image_path=image_path,
                    ocr_text=ocr_text,
                    description=description,
                    source="pdf",
                )
                images.append(image)

            except Exception as e:
                logger.warning(
                    f"页面 {page_number} 图片 {idx} 提取失败: {e}"
                )
                continue

        return images

    # ============================================
    # OCR 文字识别
    # ============================================

    def _ocr_image(self, image_path: str) -> str:
        """
        OCR 识别图片中的文字

        作用：
            使用 pytesseract 识别图片中的文字，作为精确关键词补充检索。

        实现方式：
            1. 检查 pytesseract 是否可用
            2. 调用 image_to_string 识别
            3. 清理结果（去除多余空白）

        参数：
            image_path: str - 图片路径

        返回:
            str - 识别的文本（无则空字符串）
        """
        if not self._is_tesseract_available():
            return ""

        try:
            import pytesseract
            from PIL import Image

            image = Image.open(image_path)
            # OCR 识别
            # 作用：chi_sim+eng 支持中英文混合识别
            text = pytesseract.image_to_string(image, lang=self._OCR_LANG)

            # 清理
            text = " ".join(text.split())
            return text.strip()

        except Exception as e:
            logger.debug(f"OCR 识别失败（{image_path}）: {e}")
            return ""

    def _is_tesseract_available(self) -> bool:
        """
        检查 Tesseract OCR 是否可用

        作用：
            懒加载检查，避免每次调用都尝试导入。
            Tesseract 不可用时不影响其他流程。

        返回:
            bool - 是否可用
        """
        if self._tesseract_available is not None:
            return self._tesseract_available

        try:
            import pytesseract
            # 尝试调用 tesseract 命令
            pytesseract.get_tesseract_version()
            self._tesseract_available = True
            logger.info("Tesseract OCR 可用")
        except Exception:
            self._tesseract_available = False
            logger.warning("Tesseract OCR 不可用，图片 OCR 将被跳过")

        return self._tesseract_available

    # ============================================
    # 多模态图片描述
    # ============================================

    def _describe_image(self, image_path: str) -> str:
        """
        使用多模态模型描述图片

        作用：
            委托给 ModelProviderManager 管理的 VisionModelClient 生成图片描述，
            把图表、流程图等可视化信息转为文本。
            客户端内部已处理重试+熔断+超时+降级。

        实现方式：
            1. 通过 _get_vision_client() 获取健康的 Vision 客户端
            2. 委托 client.describe_image() 生成描述
            3. 失败则返回空字符串（降级，保持与原实现兼容）

        参数：
            image_path: str - 图片路径

        返回:
            str - 图片描述（无则空字符串）
        """
        try:
            client = self._get_vision_client()
            if client is None:
                return ""

            # 委托给 VisionModelClient（内部已处理 base64 编码、MIME 类型、重试、熔断）
            return client.describe_image(image_path, prompt=self._VISION_PROMPT)

        except Exception as e:
            logger.debug(f"多模态描述失败（{image_path}）: {e}")
            return ""

    def _get_vision_client(self):
        """
        获取多模态模型客户端（通过 ModelProviderManager）

        作用：
            通过 manager 获取当前健康的 Vision 客户端。
            manager 内部由 FailoverRouter 按熔断器状态选择端点。
            无可用端点时返回 None，跳过多模态描述。

        返回:
            VisionModelClient 实例或 None
        """
        if self._manager is None:
            from app.core.model_provider import get_model_manager
            self._manager = get_model_manager()

        try:
            return self._manager.get_vision_client()
        except Exception as e:
            logger.debug(f"无可用多模态客户端: {e}")
            return None
