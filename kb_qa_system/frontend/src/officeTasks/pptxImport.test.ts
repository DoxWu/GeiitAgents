import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { importPptxReference } from './pptxImport';

const slide = (title: string, text: string, extra = '') => `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>${extra}</p:spTree></p:cSld></p:sld>`;
function pptx(options: { presentation?: string; rels?: string; slides?: Record<string, string>; extras?: Record<string, string> } = {}) {
  const zip = new JSZip();
  const slides = options.slides ?? { 'ppt/slides/slide1.xml': slide('First', 'Text one'), 'ppt/slides/slide2.xml': slide('Second', 'Text two') };
  const names = Object.keys(slides).sort(), two = names.length > 1;
  const presentation = '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>' + (two ? '<p:sldId id="256" r:id="rFirst"/><p:sldId id="257" r:id="rSecond"/>' : '<p:sldId id="256" r:id="rFirst"/>') + '</p:sldIdLst></p:presentation>';
  const relationships = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="' + (two ? names[1].replace('ppt/', '') : names[0]?.replace('ppt/', '')) + '"/>' + (two ? '<Relationship Id="rSecond" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="' + names[0].replace('ppt/', '') + '"/>' : '') + '</Relationships>';
  zip.file('ppt/presentation.xml', options.presentation ?? presentation);
  zip.file('ppt/_rels/presentation.xml.rels', options.rels ?? relationships);
  for (const [name, content] of Object.entries(slides)) zip.file(name, content);
  for (const [name, content] of Object.entries(options.extras ?? {})) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

it('reads slides in presentation order and preserves title, text, bullets and basic tables', async () => {
  const bullet = '<p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>Bullet</a:t></a:r></a:p></p:txBody></p:sp>';
  const table = '<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr><a:tc><a:p><a:r><a:t>Column</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Value</a:t></a:r></a:p></a:tc></a:tr><a:tr><a:tc><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>10</a:t></a:r></a:p></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  const bytes = await pptx({ slides: { 'ppt/slides/slide1.xml': slide('First', 'Text one', bullet + table), 'ppt/slides/slide2.xml': slide('Second', 'Text two') } });
  const result = await importPptxReference(bytes);
  expect(result.markdown.indexOf('Second')).toBeLessThan(result.markdown.indexOf('First'));
  expect(result.markdown).toContain('- Bullet');
  expect(result.markdown).toContain('| Column | Value |\n| --- | --- |\n| Revenue | 10 |');
  expect(result.warnings).toEqual([]);
});

it('warns when images, embedded charts, speaker notes or comments are not imported', async () => {
  const image = '<p:pic><p:blipFill/></p:pic>';
  const chart = '<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>';
  const result = await importPptxReference(await pptx({ slides: { 'ppt/slides/slide1.xml': slide('One', 'Text', image + chart) }, extras: { 'ppt/notesSlides/notesSlide1.xml': '<p:notes/>' , 'ppt/comments/comment1.xml': '<p:cmLst/>' } }));
  expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('图片'), expect.stringContaining('嵌入图表'), expect.stringContaining('演讲者备注'), expect.stringContaining('批注')]));
});

it('extracts grouped text while flagging grouped images', async () => {
  const group = '<p:grpSp><p:sp><p:txBody><a:p><a:r><a:t>Grouped text</a:t></a:r></a:p></p:txBody></p:sp><p:pic/></p:grpSp>';
  const result = await importPptxReference(await pptx({ slides: { 'ppt/slides/slide1.xml': slide('One', 'Text', group) } }));
  expect(result.markdown).toContain('Grouped text');
  expect(result.warnings).toContain('演示文稿含图片或非文本图形；这些内容未识别。');
});

it('rejects invalid packages, relationships, DTDs and excessive slide counts', async () => {
  await expect(importPptxReference(new TextEncoder().encode('not a zip'))).rejects.toThrow('压缩包');
  await expect(importPptxReference(new Uint8Array(5_000_001))).rejects.toThrow('5 MB');
  await expect(importPptxReference(await pptx({ rels: '<!DOCTYPE Relationships [<!ENTITY x "bad">]><Relationships>&x;</Relationships>' }))).rejects.toThrow('文档类型声明');
  await expect(importPptxReference(await pptx({ rels: '<Relationships><Relationship Id="rFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../../outside.xml"/><Relationship Id="rSecond" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>' }))).rejects.toThrow('路径');
  const ids = Array.from({ length: 121 }, (_, index) => `<p:sldId id="${index + 1}" r:id="r${index}"/>`).join('');
  const tooMany = '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>' + ids + '</p:sldIdLst></p:presentation>';
  await expect(importPptxReference(await pptx({ presentation: tooMany }))).rejects.toThrow('120 页');
});

it('rejects malformed slide XML and does not invent content for a text-free deck', async () => {
  await expect(importPptxReference(await pptx({ slides: { 'ppt/slides/slide1.xml': '<p:sld><p:cSld>' } }))).rejects.toThrow('XML 已损坏');
  await expect(importPptxReference(await pptx({ slides: { 'ppt/slides/slide1.xml': slide('', '') } }))).rejects.toThrow('没有可导入');
});
