import { beforeEach, expect, it, vi } from 'vitest';

const pdfPage = (items: Array<{ str: string }> = [{ str: 'Hello PDF' }]) => ({
  getTextContent: vi.fn().mockResolvedValue({ items }),
  cleanup: vi.fn(),
});
const pdfDocument = (pages: ReturnType<typeof pdfPage>[]) => ({
  numPages: pages.length,
  getPage: vi.fn(async (page: number) => pages[page - 1]),
});
const pdfjs = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist', () => pdfjs);

import { importPdfReference } from './pdfImport';

beforeEach(() => { vi.resetAllMocks(); pdfjs.GlobalWorkerOptions.workerSrc = ''; });

it('extracts selectable text by page, warns for empty pages, and uses a worker', async () => {
  const pages = [pdfPage([{ str: 'Quarterly' }, { str: 'report' }]), pdfPage([])];
  const document = pdfDocument(pages), destroy = vi.fn();
  pdfjs.getDocument.mockReturnValue({ promise: Promise.resolve(document), destroy });
  const result = await importPdfReference(new TextEncoder().encode('%PDF-fixture'));
  expect(result.markdown).toContain('## 第 1 页\n\nQuarterly report');
  expect(result.markdown).toContain('## 第 2 页\n\n[此页未提取到文本]');
  expect(result.warnings.join(' ')).toContain('第 2 页未提取到文本');
  expect(pdfjs.GlobalWorkerOptions.workerSrc).toContain('pdf.worker');
  expect(pdfjs.getDocument).toHaveBeenCalledWith(expect.objectContaining({ isEvalSupported: false, stopAtErrors: true }));
  expect(pages[0].cleanup).toHaveBeenCalled();
  expect(destroy).toHaveBeenCalled();
});

it('rejects oversized, text-free, overlong, and excessive-page PDFs', async () => {
  await expect(importPdfReference(new Uint8Array(10_000_001))).rejects.toThrow('10 MB');
  expect(pdfjs.getDocument).not.toHaveBeenCalled();

  const emptyDocument = pdfDocument([pdfPage([])]);
  pdfjs.getDocument.mockReturnValueOnce({ promise: Promise.resolve(emptyDocument), destroy: vi.fn() });
  await expect(importPdfReference(new TextEncoder().encode('%PDF-empty'))).rejects.toThrow('不提供 OCR');

  const longDocument = pdfDocument([pdfPage([{ str: 'x'.repeat(50_000) }])]);
  pdfjs.getDocument.mockReturnValueOnce({ promise: Promise.resolve(longDocument), destroy: vi.fn() });
  await expect(importPdfReference(new TextEncoder().encode('%PDF-long'))).rejects.toThrow('50000 个字符');

  const manyPages = pdfDocument(Array.from({ length: 101 }, () => pdfPage()));
  pdfjs.getDocument.mockReturnValueOnce({ promise: Promise.resolve(manyPages), destroy: vi.fn() });
  await expect(importPdfReference(new TextEncoder().encode('%PDF-pages'))).rejects.toThrow('100 页');
});

it('reports password protected documents without leaking parser details', async () => {
  const error = Object.assign(new Error('Password required'), { name: 'PasswordException' });
  pdfjs.getDocument.mockReturnValue({ promise: Promise.reject(error), destroy: vi.fn() });
  await expect(importPdfReference(new TextEncoder().encode('%PDF-locked'))).rejects.toThrow('受密码保护');
});
