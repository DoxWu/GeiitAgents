"""Budgets for untrusted archives, downloads, image and PDF parsing."""
import time
import zipfile
from pathlib import PurePosixPath


def read_limited(response, maximum: int, deadline: float) -> bytes:
    size_header = response.headers.get('Content-Length')
    if size_header:
        try:
            size = int(size_header)
        except ValueError:
            raise ValueError('下载大小声明无效') from None
        if size < 0 or size > maximum:
            raise ValueError('下载内容超过大小限制')
    content = bytearray()
    for chunk in response.iter_content(chunk_size=min(64 * 1024, maximum + 1)):
        if time.monotonic() > deadline:
            raise ValueError('下载超过总时间限制')
        if len(content) + len(chunk) > maximum:
            raise ValueError('下载内容超过大小限制，已中止下载')
        content.extend(chunk)
    if time.monotonic() > deadline:
        raise ValueError('下载超过总时间限制')
    return bytes(content)


def validate_docx_archive(path: str, maximum=64 * 1024 * 1024, max_entries=2000, max_ratio=100):
    """Check the central directory before python-docx allocates expanded XML."""
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > max_entries:
            raise ValueError('DOCX 包含过多压缩条目')
        total = 0
        for info in infos:
            name = PurePosixPath(info.filename.replace('\\', '/'))
            if name.is_absolute() or '..' in name.parts or info.flag_bits & 1:
                raise ValueError('DOCX 包含不受支持的压缩条目')
            total += info.file_size
            if total > maximum or info.file_size > max_ratio * max(1, info.compress_size):
                raise ValueError('DOCX 解压预算超限')
        if '[Content_Types].xml' not in archive.namelist() or 'word/document.xml' not in archive.namelist():
            raise ValueError('不是有效的 DOCX 文档')
