import { LIMITS, LOCAL_DOCUMENT_EXTENSION, readDocument, type LocalDocument } from './core';

export async function readLocalDocument(file: File): Promise<LocalDocument> {
  if (!LOCAL_DOCUMENT_EXTENSION.test(file.name) || file.name.length > 255
    || /[\\/]/.test(file.name) || Array.from(file.name).some(char => char.charCodeAt(0) < 32)) throw new Error('请选择 Markdown、TXT、PDF、DOCX 或 PPTX 文件，文件名须有效。');
  if (/\.(md|markdown|txt)$/i.test(file.name)) return readDocument(file);
  const extension = file.name.split('.').pop()!.toLowerCase();
  const maxBytes = extension === 'pdf' ? 10_000_000 : extension === 'docx' ? 2_000_000 : 5_000_000;
  if (!file.size || file.size > maxBytes) throw new Error(`${extension.toUpperCase()} 文件须非空且不超过 ${maxBytes / 1_000_000} MB。`);
  const data = await file.arrayBuffer();
  // Reuse the bounded, lazy local parsers; no cloud API or embedding profile is involved.
  const imported = extension === 'pdf'
    ? await (await import('@/officeTasks/pdfImport')).importPdfReference(data)
    : extension === 'docx'
      ? await (await import('@/officeTasks/docxImport')).importDocxReference(data)
      : await (await import('@/officeTasks/pptxImport')).importPptxReference(data);
  const text = imported.markdown;
  const bytes = new TextEncoder().encode(text).byteLength;
  if (!text.trim() || text.includes('\0') || bytes > LIMITS.fileBytes) throw new Error('提取文本为空、无效或超过单文档 2 MiB 限制。');
  return { id: crypto.randomUUID(), name: file.name, text, bytes,
    importWarnings: ['仅索引提取文本；引用字符位置对应提取结果，不代表原文件位置。', ...imported.warnings] };
}
