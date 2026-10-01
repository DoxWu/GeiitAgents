import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { importDocxReference } from './docxImport';

function docx(body: string, extra: Record<string, string> = {}) {
  const zip = new JSZip();
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
const paragraph = (text: string, properties = '') => `<w:p>${properties}<w:r><w:t>${text}</w:t></w:r></w:p>`;

it('imports headings, paragraphs, numbering, line breaks and tables as Markdown', async () => {
  const body = [
    paragraph('周报', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    '<w:p><w:r><w:t>第一行</w:t><w:br/><w:t>第二行</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>列表项</w:t></w:r></w:p>',
    '<w:tbl><w:tr><w:tc>' + paragraph('项目') + '</w:tc><w:tc>' + paragraph('进度') + '</w:tc></w:tr><w:tr><w:tc>' + paragraph('甲') + '</w:tc><w:tc>' + paragraph('50%') + '</w:tc></w:tr></w:tbl>',
  ].join('');
  await expect(importDocxReference(await docx(body))).resolves.toMatchObject({
    markdown: '# 周报\n\n第一行\n第二行\n\n- 列表项\n\n| 项目 | 进度 |\n| --- | --- |\n| 甲 | 50% |', warnings: [],
  });
});

it('warns about non-text content and document parts omitted from the text import', async () => {
  const body = paragraph('正文', '<w:r><w:drawing><w:inline/></w:drawing></w:r>');
  const result = await importDocxReference(await docx(body, { 'word/header1.xml': '<w:hdr/>' }));
  expect(result.markdown).toBe('正文');
  expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('图片'), expect.stringContaining('页眉')]));
});

it('does not import tracked deleted text and marks nested table layout as lossy', async () => {
  const body = '<w:p><w:r><w:t>保留</w:t></w:r><w:del><w:r><w:delText>删除</w:delText></w:r></w:del></w:p><w:tbl><w:tr><w:tc>' + paragraph('单元格') + '<w:tbl><w:tr><w:tc>' + paragraph('嵌套') + '</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>';
  const result = await importDocxReference(await docx(body));
  expect(result.markdown).toContain('保留'); expect(result.markdown).not.toContain('删除');
  expect(result.warnings).toContain('正文含嵌套表格；嵌套层级未完整保留。');
});

it('rejects invalid packages, DTDs, missing body text and oversized content', async () => {
  await expect(importDocxReference(new TextEncoder().encode('not a zip'))).rejects.toThrow('压缩包');
  await expect(importDocxReference(await docx('<!DOCTYPE document [<!ENTITY x "bad">]><w:p><w:r><w:t>&x;</w:t></w:r></w:p>'))).rejects.toThrow();
  await expect(importDocxReference(await docx('<w:tbl/>'))).rejects.toThrow('没有可导入');
  await expect(importDocxReference(await docx(paragraph('x'.repeat(50_001))))).rejects.toThrow('50000');
  await expect(importDocxReference(new Uint8Array(2_000_001))).rejects.toThrow('2 MB');
});

it('rejects zip entries with unsafe paths or excessive expansion', async () => {
  const unsafe = new JSZip(); unsafe.file('../escape.xml', 'bad'); unsafe.file('word/document.xml', '<document><body/></document>');
  await expect(importDocxReference(await unsafe.generateAsync({ type: 'uint8array' }))).rejects.toThrow('不安全路径');
  const bomb = new JSZip(); bomb.file('word/document.xml', 'x'.repeat(9_000_001));
  await expect(importDocxReference(await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } }))).rejects.toThrow('大小限制');
});
