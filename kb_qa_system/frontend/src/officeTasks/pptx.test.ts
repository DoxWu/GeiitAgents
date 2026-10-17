import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { exportMarkdownPptx, markdownSlides } from './pptx';

it('turns Markdown sections into a bounded editable PPTX without external resources', async () => {
  const markdown = '# 经营回顾\n\n本月完成重点项目。\n\n## 进展\n\n- 完成上线\n- 收到客户反馈';
  expect(markdownSlides(markdown, '报告')).toEqual([
    { title: '经营回顾', body: ['本月完成重点项目。'] },
    { title: '进展', body: ['• 完成上线', '• 收到客户反馈'] },
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

it('caps presentation size and flags truncated content', async () => {
  const result = await exportMarkdownPptx(`# 长内容\n\n${'说明'.repeat(4500)}`, '报告');
  expect(result.warnings).toContain('过长页面内容已截断。');
});
