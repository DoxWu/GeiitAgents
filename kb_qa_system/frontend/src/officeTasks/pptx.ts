import pptxgen from 'pptxgenjs';

export const PPTX_CONVERTER_VERSION = 'markdown-pptx/2';
const MAX_SLIDES = 50;
const MAX_INPUT_CHARS = 1_000_000;
const MAX_PARAGRAPH_CHARS = 300;

type SlideBlock = { kind: 'text' | 'bullet' | 'code'; text: string } | { kind: 'table'; rows: string[][] };
interface SlideContent { title: string; body: SlideBlock[] }

function plainText(value: string): string {
  return value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2').replace(/<[^>]*>/g, '')
    .replace(/\\([\\`*_{}()#+.!|>-])/g, '$1').trim();
}

export function markdownSlides(content: string, fallbackTitle: string): SlideContent[] {
  if (!content.trim() || content.length > MAX_INPUT_CHARS || content.includes('\0')) throw new Error('演示文稿内容为空或超过限制。');
  const sections: SlideContent[] = [];
  let current: SlideContent = { title: fallbackTitle.slice(0, 120) || '演示文稿', body: [] }, paragraph: string[] = [], code: string[] = [];
  let table: string[][] = [], inCode = false, hasHeading = false;
  const pushSlide = (title: string) => {
    if (current.body.length || sections.length || hasHeading) sections.push(current);
    current = { title: title.slice(0, 120) || fallbackTitle, body: [] };
    hasHeading = true;
  };
  const addParagraph = (value: string, kind: 'text' | 'bullet' | 'code' = 'text') => {
    const clean = plainText(value);
    if (!clean) return;
    for (let index = 0; index < clean.length; index += MAX_PARAGRAPH_CHARS) current.body.push({ kind, text: clean.slice(index, index + MAX_PARAGRAPH_CHARS) });
  };
  const flushParagraph = () => { if (paragraph.length) addParagraph(paragraph.join(' ')); paragraph = []; };
  const flushTable = () => { if (table.length > 1) current.body.push({ kind: 'table', rows: table }); table = []; };
  for (const raw of content.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      flushParagraph(); flushTable();
      if (inCode) { if (code.length) current.body.push({ kind: 'code', text: code.join('\n') }); code = []; }
      inCode = !inCode; continue;
    }
    if (inCode) { code.push(raw); continue; }
    const heading = raw.match(/^(#{1,2})\s+(.+)$/);
    if (heading) { flushParagraph(); flushTable(); pushSlide(plainText(heading[2])); continue; }
    if (raw.trim().startsWith('|') && raw.trim().endsWith('|')) {
      flushParagraph();
      const cells = raw.trim().slice(1, -1).split('|').map(cell => plainText(cell.trim()));
      if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
      if (table.length && cells.length !== table[0].length) throw new Error('演示文稿表格各行列数必须一致。');
      table.push(cells); continue;
    }
    flushTable();
    const bullet = raw.match(/^\s*(?:[-*+] |\d+[.)] )(.*)$/);
    if (bullet) { flushParagraph(); addParagraph(bullet[1], 'bullet'); continue; }
    if (!raw.trim() || /^\s*---+\s*$/.test(raw)) { flushParagraph(); continue; }
    paragraph.push(raw.trim());
  }
  flushParagraph(); flushTable();
  if (inCode && code.length) current.body.push({ kind: 'code', text: code.join('\n') });
  if (current.body.length || !sections.length) sections.push(current);
  return sections;
}

export async function exportMarkdownPptx(content: string, title: string): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const sections = markdownSlides(content, title), slides: SlideContent[] = [], warnings: string[] = [];
  const continuation = new Set<number>();
  for (const section of sections) {
    let current: SlideContent = { title: section.title, body: [] }, used = 0;
    const addPage = (nextIsContinuation: boolean) => {
        slides.push(current);
      if (nextIsContinuation) continuation.add(slides.length);
      current = { title: section.title, body: [] }; used = 0;
      if (slides.length >= MAX_SLIDES) throw new Error(`内容超过 ${MAX_SLIDES} 页，请拆分后导出。`);
    };
    for (const block of section.body) {
      if (block.kind === 'table') {
        if (block.rows[0].length > 8 || block.rows.some(row => row.some(cell => cell.length > 500))) throw new Error('演示文稿表格最多 8 列，单元格最多 500 字符。');
        for (let start = 1; start < block.rows.length; start += 7) {
          const rows = [block.rows[0], ...block.rows.slice(start, start + 7)];
          const cost = rows.length * 0.43;
          if (used + cost > 4.95 && current.body.length) addPage(true);
          current.body.push({ kind: 'table', rows }); used += cost + 0.24;
          if (start + 7 < block.rows.length) addPage(true);
        }
        continue;
      }
      const cost = Math.min(1.45, 0.4 + Math.ceil(block.text.length / 68) * 0.24);
      if (used + cost > 4.95 && current.body.length) addPage(true);
      current.body.push(block); used += cost + 0.16;
    }
    if (current.body.length || !slides.length) slides.push(current);
  }
  if (slides.length > MAX_SLIDES) throw new Error(`内容超过 ${MAX_SLIDES} 页，请拆分后导出。`);
  if (continuation.size) warnings.push('较长内容已自动分页，建议检查分页位置。');
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'GeiIt Agents';
  pptx.subject = '由工作台 Markdown 成果转换';
  pptx.title = title.slice(0, 120);
  pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos' };
  pptx.defineSlideMaster({
    title: 'GEIIT',
    background: { color: 'F4F6F3' },
    objects: [
      { rect: { x: 0, y: 0, w: 0.14, h: 7.5, line: { color: '187A72', transparency: 100 }, fill: { color: '187A72' } } },
      { line: { x: 0.55, y: 7.05, w: 12.2, h: 0, line: { color: 'D8E0DC', width: 1 } } },
      { text: { text: title.slice(0, 80), options: { x: 0.62, y: 7.12, w: 8.5, h: 0.2, color: '64716C', fontSize: 8, margin: 0 } } },
    ],
    slideNumber: { x: 12.25, y: 7.1, w: 0.4, h: 0.2, color: '64716C', fontSize: 8 },
  });
  for (const [index, item] of slides.entries()) {
    const slide = pptx.addSlide('GEIIT');
    const pageTitle = continuation.has(index) ? `${item.title}（续）` : item.title;
    slide.addText(pageTitle, { x: 0.7, y: 0.55, w: 11.8, h: 0.8, fontFace: 'Aptos Display', fontSize: index === 0 ? 28 : 25, bold: true, color: '202B29', margin: 0, breakLine: false, valign: 'middle', fit: 'shrink' });
    let y = 1.65;
    for (const block of item.body) {
      if (block.kind === 'table') {
        const tableRows = block.rows.map((row, rowIndex) => row.map(text => ({ text, options: { bold: rowIndex === 0, color: rowIndex === 0 ? 'FFFFFF' : '35413D', fill: { color: rowIndex === 0 ? '187A72' : rowIndex % 2 === 0 ? 'F0F5F4' : 'FFFFFF' }, breakLine: false } })));
        slide.addTable(tableRows, { x: 0.78, y, w: 11.65, fontFace: 'Aptos', fontSize: 10, color: '35413D', border: { type: 'solid', color: 'D9E2DF', pt: 0.6 }, margin: 0.08, valign: 'middle', colW: Array.from({ length: block.rows[0].length }, () => 11.65 / block.rows[0].length) });
        y += block.rows.length * 0.42 + 0.2;
        continue;
      }
      const bullet = block.kind === 'bullet', code = block.kind === 'code';
      const estimatedLines = Math.max(1, Math.ceil(block.text.length / 86));
      const h = Math.min(1.35, 0.34 + estimatedLines * (code ? 0.2 : 0.24));
      slide.addText(block.text, { x: bullet ? 1.02 : 0.78, y, w: bullet ? 11.35 : 11.65, h, fontFace: code ? 'Cascadia Code' : 'Aptos', fontSize: code ? 11 : 16, color: code ? '24554F' : '35413D', margin: code ? 0.1 : 0.03, breakLine: false, valign: 'top', fit: 'shrink', ...(code ? { fill: { color: 'EAF1EF' }, line: { color: 'D9E2DF', transparency: 20 } } : {}), ...(bullet ? { bullet: { indent: 18 }, hanging: 4 } : {}) });
      y += h + 0.16;
    }
  }
  const output = await pptx.write({ outputType: 'uint8array', compression: true });
  const bytes = output instanceof Uint8Array ? output : output instanceof ArrayBuffer ? new Uint8Array(output) : null;
  if (!bytes?.length) throw new Error('PPTX 转换器没有生成有效文件。');
  return { bytes, warnings };
}
