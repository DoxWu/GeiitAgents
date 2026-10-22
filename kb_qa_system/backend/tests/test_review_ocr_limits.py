from __future__ import annotations

import io
import os
import re
from pathlib import Path

import fitz
import pytest
from PIL import Image, ImageDraw, ImageFont

from app.core.config import settings
from app.services.document_pipeline.chunker import TextChunker
from app.services.document_pipeline.context import PipelineContext
from app.services.document_pipeline.image_processor import ImageProcessor


def missing_ocr_dependency(reason: str) -> None:
    if os.environ.get("GEIIT_OCR_REQUIRED") == "1":
        pytest.fail(reason)
    pytest.skip(reason)


def make_image(text: str = "Invoice Total 583.25") -> bytes:
    image = Image.new("RGB", (900, 220), "white")
    draw = ImageDraw.Draw(image)
    font_path = next(
        (
            path
            for path in (
                Path("C:/Windows/Fonts/msyh.ttc"),
                Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
                Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
            )
            if path.exists()
        ),
        None,
    )
    if font_path is None:
        missing_ocr_dependency("No Chinese-capable test font is installed")
    draw.text((25, 35), text, fill="black", font=ImageFont.truetype(str(font_path), 52))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def make_pdf(path: Path, images: list[bytes]) -> None:
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    for index, data in enumerate(images):
        page.insert_image(fitz.Rect(30, 30 + index * 250, 580, 230 + index * 250), stream=data)
    document.save(path)
    document.close()


def test_scanned_pdf_ocr_is_chunked_with_chinese_and_english(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    processor = ImageProcessor()
    if not processor._is_tesseract_available():
        missing_ocr_dependency("Tesseract is not installed")
    monkeypatch.setattr(settings, "ENABLE_OCR", True)
    monkeypatch.setattr(settings, "ENABLE_VISION", False)
    monkeypatch.setattr(settings, "PARSER_OCR_TIMEOUT_SECONDS", 20)
    pdf_path = tmp_path / "scanned.pdf"
    make_pdf(pdf_path, [make_image("员工编号 7421 Invoice Total 583.25")])

    context = PipelineContext(file_path=str(pdf_path), file_type=".pdf", file_name=pdf_path.name)
    processor.extract(context)
    TextChunker().chunk(context)

    assert context.images
    assert "7421" in context.images[0].ocr_text
    assert "583.25" in context.images[0].ocr_text
    assert "员工编号" in re.sub(r"\s+", "", context.images[0].ocr_text)
    assert context.chunks
    assert any("7421" in chunk.text and "583.25" in chunk.text for chunk in context.chunks)


def test_image_count_budget_stops_extraction(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGES", 1)
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGE_BYTES", 10_000_000)
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGE_TOTAL_BYTES", 10_000_000)
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGE_PIXELS", 20_000_000)
    monkeypatch.setattr(settings, "ENABLE_OCR", True)
    monkeypatch.setattr(settings, "ENABLE_VISION", False)
    processor = ImageProcessor()
    calls: list[str] = []
    monkeypatch.setattr(processor, "_ocr_image", lambda path: calls.append(path) or "recognized")
    pdf_path = tmp_path / "two-images.pdf"
    image = make_image()
    make_pdf(pdf_path, [image, image])
    context = PipelineContext(file_path=str(pdf_path), file_type=".pdf", file_name=pdf_path.name)

    processor.extract(context)

    assert len(context.images) == 1
    assert len(calls) == 1
    assert any("数量超过处理上限" in issue for issue in context.quality_issues)


def test_image_byte_budget_skips_oversized_image(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGES", 10)
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGE_BYTES", 10)
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGE_TOTAL_BYTES", 100)
    monkeypatch.setattr(settings, "ENABLE_OCR", True)
    monkeypatch.setattr(settings, "ENABLE_VISION", False)
    processor = ImageProcessor()
    monkeypatch.setattr(
        processor, "_ocr_image", lambda _path: pytest.fail("OCR must not run for oversized images")
    )
    pdf_path = tmp_path / "large-image.pdf"
    make_pdf(pdf_path, [make_image()])
    context = PipelineContext(file_path=str(pdf_path), file_type=".pdf", file_name=pdf_path.name)

    processor.extract(context)

    assert context.images == []
    assert any("单张图片超过字节大小上限" in issue for issue in context.quality_issues)


def test_image_pixel_budget_rejects_before_binary_extraction(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGE_PIXELS", 100)
    monkeypatch.setattr(settings, "ENABLE_OCR", True)
    monkeypatch.setattr(settings, "ENABLE_VISION", False)
    processor = ImageProcessor()
    pdf_path = tmp_path / "pixel-limit.pdf"
    make_pdf(pdf_path, [make_image()])
    monkeypatch.setattr(
        fitz.Document,
        "extract_image",
        lambda *_args: pytest.fail("Oversized pixels must be rejected before extraction"),
    )
    context = PipelineContext(file_path=str(pdf_path), file_type=".pdf", file_name=pdf_path.name)
    processor.extract(context)
    assert not context.images
    assert any("像素处理上限" in issue for issue in context.quality_issues)


def test_total_image_bytes_stop_further_ocr(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGES", 10)
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGE_BYTES", 10_000_000)
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGE_PIXELS", 20_000_000)
    monkeypatch.setattr(settings, "ENABLE_OCR", True)
    monkeypatch.setattr(settings, "ENABLE_VISION", False)
    pdf_path = tmp_path / "total-limit.pdf"
    make_pdf(pdf_path, [make_image("First 123"), make_image("Second 456")])
    with fitz.open(pdf_path) as doc:
        first = doc.extract_image(doc[0].get_images(full=True)[0][0])["image"]
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGE_TOTAL_BYTES", len(first))
    processor = ImageProcessor()
    calls = []
    monkeypatch.setattr(processor, "_ocr_image", lambda path: calls.append(path) or "text")
    context = PipelineContext(file_path=str(pdf_path), file_type=".pdf", file_name=pdf_path.name)
    processor.extract(context)
    assert len(calls) == len(context.images) == 1
    assert any("图片总字节数" in issue for issue in context.quality_issues)


def test_ocr_timeout_is_bounded_and_image_handle_is_closed(monkeypatch, tmp_path):
    import pytesseract

    processor = ImageProcessor()
    monkeypatch.setattr(processor, "_is_tesseract_available", lambda: True)
    monkeypatch.setattr(settings, "PARSER_OCR_TIMEOUT_SECONDS", 3)
    monkeypatch.setattr(settings, "PARSER_MAX_IMAGE_PIXELS", 20_000_000)
    image_path = tmp_path / "timeout.png"
    image_path.write_bytes(make_image())
    images = []

    def timed_out(image, *, lang, timeout):
        assert lang == "chi_sim+eng"
        assert timeout == 3
        images.append(image)
        raise RuntimeError("Tesseract process timeout")

    monkeypatch.setattr(pytesseract, "image_to_string", timed_out)
    assert processor._ocr_image(str(image_path)) == ""
    assert len(images) == 1
    assert images[0].fp is None
