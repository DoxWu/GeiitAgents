import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { exportMarkdownPptx, markdownSlides } from './pptx';

it('turns Markdown sections into a bounded editable PPTX without external resources', async () => {
  const markdown = '# 经营回顾\n\n本月完成重点项目。\n\n## 进展\n\n- 完成上线\n- 收到客户反馈';
  expect(markdownSlides(markdown, '报告')).toEqual([
    { title: '经营回顾', body: [{ kind: 'text', text: '本月完成重点项目。' }] },
    { title: '进展', body: [{ kind: 'bullet', text: '完成上线' }, { kind: 'bullet', text: '收到客户反馈' }] },
  ]);
  const result = await exportMarkdownPptx(markdown, '报告');
  expect(result.warnings).toEqual([]);
  const archive = await JSZip.loadAsync(result.bytes);
  const slideFiles = Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  expect(slideFiles).toHaveLength(2);
  expect(await archive.file('ppt/slides/slide1.xml')!.async('text')).toContain('经营回顾');
  expect(await archive.file('ppt/slides/slide2.xml')!.async('text')).toContain('完成上线');
  const relationships = await Promise.all(Object.entries(archive.files).filter(([name]) => name.startsWith('ppt/slides/_rels/') && name.endsWith('.rels')).map(([, file]) => file.async('text')));
  expect(relationships.join('\n')).not.toContain('TargetMode="External"');
});

it('preserves a title heading when a section heading follows without an introduction', () => {
  expect(markdownSlides('# Deck title\n\n## Summary\n\nText', 'Fallback')).toEqual([
    { title: 'Deck title', body: [] },
    { title: 'Summary', body: [{ kind: 'text', text: 'Text' }] },
  ]);
});

it('paginates long presentation content without dropping text', async () => {
  const result = await exportMarkdownPptx(`# 长内容\n\n${'说明'.repeat(4500)}`, '报告');
  expect(result.warnings).toContain('较长内容已自动分页，建议检查分页位置。');
  const archive = await JSZip.loadAsync(result.bytes);
  const slideFiles = Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const text = (await Promise.all(slideFiles.map(name => archive.file(name)!.async('text')))).join('\n');
  expect(slideFiles.length).toBeGreaterThan(1);
  expect(text.match(/說明/g) ?? []).toHaveLength(0);
  expect(text.match(/说明/g)?.length).toBe(4500);
  expect(text).toContain('长内容（续）');
});

it('keeps Markdown tables as editable formatted tables and repeats their headers across slides', async () => {
  const result = await exportMarkdownPptx('# Results\n\n| Metric | Value |\n| --- | ---: |\n' + Array.from({ length: 15 }, (_, index) => `| Row ${index + 1} | ${index + 1} |`).join('\n'), 'Report');
  const archive = await JSZip.loadAsync(result.bytes);
  const slides = Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  expect(slides.length).toBeGreaterThan(1);
  for (const slide of slides) expect(await archive.file(slide)!.async('text')).toContain('Metric');
});

it('rejects content beyond the slide budget instead of silently dropping sections', async () => {
  const headings = Array.from({ length: 51 }, (_, index) => `## Section ${index + 1}\n\nText`).join('\n\n');
  await expect(exportMarkdownPptx(headings, 'Report')).rejects.toThrow('超过 50 页');
});
