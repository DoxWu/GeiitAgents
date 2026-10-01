import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { markdownToDocx } from './docx';
import { docxRegressionFixture } from './docxRegressionFixture';

it('exports Chinese, formatting, ordered lists, repeated table headers and literal code to real OOXML', async () => {
  const source = '# 项目周报\n\n## 进展\n\n**已完成**与*待确认*，~~删除~~和`a < b`。\n\n3. 评审\n4. 发布\n\n- [x] 完成\n  - 子任务\n\n| 工作 | 状态 |\n| --- | --- |\n| 登录 | 完成 |\n\n```ts\nconst x = "<safe>";\n```';
  const result = await markdownToDocx(source, '项目周报');
  const zip = await JSZip.loadAsync(result.bytes);
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('项目周报'); expect(xml).toContain('a &lt; b');
  expect(xml).toContain('w:pStyle w:val="Title"'); expect(xml).toContain('w:pStyle w:val="Heading2"');
  expect(xml).toContain('<w:b/>'); expect(xml).toContain('<w:i/>'); expect(xml).toContain('<w:strike/>');
  expect(xml).toContain('<w:tblHeader/>'); expect(xml).toContain('[x] '); expect(xml).toContain('子任务');
  expect(xml).toContain('const x = &quot;&lt;safe&gt;&quot;;');
  const numbering = await zip.file('word/numbering.xml')!.async('string');
  expect(numbering).toContain('w:start w:val="3"'); expect(numbering).toContain('w:numFmt w:val="decimal"');
  const styles = await zip.file('word/styles.xml')!.async('string');
  expect(styles).toContain('Microsoft YaHei'); expect(styles).toContain('w:color w:val="000000"');
  expect(result.warnings).toEqual([]);
});

it('applies the selected local style without changing Markdown content', async () => {
  const standard = await markdownToDocx('# 标题\n\n正文', '样式', 'standard');
  const business = await markdownToDocx('# 标题\n\n正文', '样式', 'business');
  const meeting = await markdownToDocx('# 标题\n\n正文', '样式', 'meeting');
  const standardZip = await JSZip.loadAsync(standard.bytes), businessZip = await JSZip.loadAsync(business.bytes), meetingZip = await JSZip.loadAsync(meeting.bytes);
  const standardXml = await standardZip.file('word/document.xml')!.async('string');
  const businessXml = await businessZip.file('word/document.xml')!.async('string');
  const meetingXml = await meetingZip.file('word/document.xml')!.async('string');
  const businessStyles = await businessZip.file('word/styles.xml')!.async('string');
  const meetingStyles = await meetingZip.file('word/styles.xml')!.async('string');
  expect(standardXml).toContain('w:pgSz w:w="12240" w:h="15840"');
  expect(businessXml).toContain('w:pgSz w:w="11906" w:h="16838"');
  expect(meetingXml).toContain('w:pgSz w:w="11906" w:h="16838"');
  expect(businessStyles).toContain('w:color w:val="1F4E79"');
  expect(meetingStyles).toContain('w:color w:val="0F6B78"');
  expect(business.converterVersion).toBe('markdown-docx/2:business');
  expect(meeting.converterVersion).toBe('markdown-docx/2:meeting');
  expect(await businessZip.file('word/document.xml')!.async('string')).toContain('正文');
});

it('rejects unknown style IDs instead of falling back silently', async () => {
  await expect(markdownToDocx('# 标题', '样式', 'custom' as never)).rejects.toThrow('受支持');
});

it('keeps untrusted HTML, links, images and footnotes inert and explains fidelity limits', async () => {
  const result = await markdownToDocx('# 安全\n\n[网站](https://example.test?q=1) ![示意图](https://example.test/a.png)\n\n<script>alert(1)</script>\n\n[引用][r]\n\n[r]: https://example.test/ref\n\n文本[^n]\n\n[^n]: 备注', '安全');
  const zip = await JSZip.loadAsync(result.bytes);
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('https://example.test/a.png'); expect(xml).toContain('https://example.test/ref');
  expect(xml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(xml).toContain('备注');
  expect(xml).not.toMatch(/<w:hyperlink|<w:drawing|<w:altChunk/);
  for (const file of Object.values(zip.files).filter(file => file.name.endsWith('.rels'))) expect(await file.async('string')).not.toContain('TargetMode="External"');
  expect(result.warnings).toHaveLength(4);
});

it('rejects oversized, invalid and overly wide content instead of silently truncating', async () => {
  await expect(markdownToDocx('x'.repeat(200001), 'large')).rejects.toThrow('200000');
  await expect(markdownToDocx('bad\0text', 'invalid')).rejects.toThrow('有效');
  await expect(markdownToDocx('|a|b|c|d|e|f|g|h|i|\n|--|--|--|--|--|--|--|--|--|\n|1|2|3|4|5|6|7|8|9|', 'wide')).rejects.toThrow('8 列');
});

it('preserves all content of long Chinese prose, a 120-row table and 80 code lines in well-formed OOXML', async () => {
  const result = await markdownToDocx(docxRegressionFixture(), '长文档回归样例');
  const zip = await JSZip.loadAsync(result.bytes);
  const doc = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const text = Array.from(doc.getElementsByTagNameNS(ns, 't')).map(node => node.textContent).join('\n');
  for (let index = 1; index <= 18; index++) expect(text).toContain(`段落-${index}：`);
  for (let index = 1; index <= 120; index++) expect(text).toContain(`行-${index}\n`);
  for (let index = 1; index <= 80; index++) expect(text).toContain(`line_${index}: check("<中文 & data>");`);
  expect(text).toContain('结束标记：全文应完整保留。');
  expect(doc.getElementsByTagNameNS(ns, 'tr')).toHaveLength(121);
  expect(doc.getElementsByTagNameNS(ns, 'tc')).toHaveLength(363);
  const headers = Array.from(doc.getElementsByTagNameNS(ns, 'tblHeader'));
  expect(headers.filter(node => !['false', '0', 'off'].includes(node.getAttributeNS(ns, 'val') ?? 'true'))).toHaveLength(1);
  expect(doc.getElementsByTagNameNS(ns, 'trHeight')).toHaveLength(0);
  // Structural protection only: this does not assert native Word pagination.
  expect(result.warnings).toEqual([]);
});
