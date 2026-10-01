import { File as NodeFile } from 'node:buffer';
import JSZip from 'jszip';
import { expect, it, vi } from 'vitest';
import { readLocalDocument } from './documentImport';
const pdfjs = vi.hoisted(() => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: vi.fn() }));
vi.mock('pdfjs-dist', () => pdfjs);
function file(data: Uint8Array | string, name: string) { return new NodeFile([data], name) as unknown as File; }

it('imports real DOCX content with its original name and retained omission warnings', async () => {
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>报销需发票</w:t><w:drawing/></w:r></w:p></w:body></w:document>');
  const result = await readLocalDocument(file(await zip.generateAsync({ type: 'uint8array' }), '制度.docx'));
  expect(result).toMatchObject({ name: '制度.docx', text: '报销需发票', bytes: 15 });
  expect(result.importWarnings?.join(' ')).toContain('图片');
  expect(result.importWarnings?.join(' ')).toContain('不代表原文件位置');
});

it('extracts PDF text via the bounded adapter and counts text bytes instead of binary size', async () => {
  const destroy = vi.fn();
  pdfjs.getDocument.mockReturnValueOnce({ promise: Promise.resolve({ numPages: 1,
    getPage: async () => ({ getTextContent: async () => ({ items: [{ str: '报销需要发票' }] }), cleanup: vi.fn() }) }), destroy });
  const result = await readLocalDocument(file(new Uint8Array(2_500_000), '制度.PDF'));
  expect(result.name).toBe('制度.PDF'); expect(result.text).toContain('报销需要发票');
  expect(result.bytes).toBe(new TextEncoder().encode(result.text).byteLength);
  expect(result.bytes).toBeLessThan(100); expect(destroy).toHaveBeenCalled();
});

it.each([['pdf', 10_000_001], ['docx', 2_000_001], ['pptx', 5_000_001]])('rejects oversized %s before reading or parsing', async (extension, size) => {
  const arrayBuffer = vi.fn();
  await expect(readLocalDocument({ name: `large.${extension}`, size, arrayBuffer } as unknown as File)).rejects.toThrow('不超过');
  expect(arrayBuffer).not.toHaveBeenCalled();
});

it('rejects unknown/path names, corrupt packages and invalid UTF-8 without producing a document', async () => {
  await expect(readLocalDocument(file('x', 'x.exe'))).rejects.toThrow('请选择');
  await expect(readLocalDocument(file('x', '../x.txt'))).rejects.toThrow('文件名');
  await expect(readLocalDocument(file('broken', 'x.pptx'))).rejects.toThrow();
  await expect(readLocalDocument(file(new Uint8Array([0xff]), 'x.txt'))).rejects.toThrow();
  await expect(readLocalDocument(file('中文', 'x.txt'))).resolves.toMatchObject({ text: '中文', bytes: 6 });
});
