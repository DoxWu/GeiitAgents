import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { markdownToDocx } from './docx';

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
