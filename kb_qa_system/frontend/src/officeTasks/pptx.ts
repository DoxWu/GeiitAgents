import pptxgen from 'pptxgenjs';

export const PPTX_CONVERTER_VERSION = 'markdown-pptx/1';
const MAX_SLIDES = 50;
const MAX_BODY_CHARS = 8000;

interface SlideContent { title: string; body: string[] }

function plainText(value: string): string {
  return value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2').replace(/<[^>]*>/g, '')
    .replace(/\\([\\`*_{}()#+.!|>-])/g, '$1').trim();
}

export function markdownSlides(content: string, fallbackTitle: string): SlideContent[] {
  if (!content.trim() || content.length > 1_000_000 || content.includes('\0')) throw new Error('演示文稿内容为空或超过限制。');
  const slides: SlideContent[] = [];
  let current: SlideContent = { title: fallbackTitle.slice(0, 120) || '演示文稿', body: [] };
  let hasContent = false;
  for (const raw of content.split(/\r?\n/)) {
    const heading = raw.match(/^#{1,2}\s+(.+)$/);
    if (heading) {
      if (hasContent || current.body.length) slides.push(current);
      current = { title: plainText(heading[1]).slice(0, 120) || fallbackTitle, body: [] };
      hasContent = true;
    } else if (/^\s*\|?\s*:?-{3,}/.test(raw) || /^\s*---+\s*$/.test(raw)) {
      continue;
    } else if (raw.trim()) {
      const tableCells = raw.trim().startsWith('|') ? raw.trim().replace(/^\||\|$/g, '').split('|').map(cell => plainText(cell.trim())) : null;
      const line = tableCells ? tableCells.join('   ·   ') : plainText(raw.replace(/^\s*(?:[-*+] |\d+[.)] )/, '• '));
      if (line) current.body.push(line);
    }
    if (current.body.join('\n').length > MAX_BODY_CHARS) {
      current.body = [...current.body.join('\n').slice(0, MAX_BODY_CHARS - 18).split('\n'), '[本页内容已截断]'];
    }
    if (slides.length >= MAX_SLIDES) break;
  }
  if (current.body.length || !slides.length) slides.push(current);
  if (slides.length > MAX_SLIDES) slides.length = MAX_SLIDES;
  return slides;
}

export async function exportMarkdownPptx(content: string, title: string): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const slides = markdownSlides(content, title), warnings: string[] = [];
  if (slides.length >= MAX_SLIDES) warnings.push(`演示文稿最多导出 ${MAX_SLIDES} 页，后续内容已省略。`);
  if (content.length > MAX_BODY_CHARS * slides.length) warnings.push('过长页面内容已截断。');
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
    slide.addText(item.title, { x: 0.7, y: 0.55, w: 11.8, h: 0.8, fontFace: 'Aptos Display', fontSize: index === 0 ? 28 : 25, bold: true, color: '202B29', margin: 0, breakLine: false, valign: 'middle', fit: 'shrink' });
    const paragraphs = item.body.length ? item.body : [' '];
    let y = 1.65;
    for (const text of paragraphs) {
      const bullet = text.startsWith('• ');
      const clean = bullet ? text.slice(2) : text;
      const estimatedLines = Math.max(1, Math.ceil(clean.length / 88));
      const h = Math.min(0.82, 0.28 + estimatedLines * 0.24);
      slide.addText(clean, { x: bullet ? 1.02 : 0.78, y, w: bullet ? 11.35 : 11.65, h, fontFace: 'Aptos', fontSize: 16, color: '35413D', margin: 0.03, breakLine: false, valign: 'top', fit: 'shrink', ...(bullet ? { bullet: { indent: 18 }, hanging: 4 } : {}) });
      y += h + 0.16;
      if (y > 6.55) break;
    }
  }
  const output = await pptx.write({ outputType: 'uint8array', compression: true });
  const bytes = output instanceof Uint8Array ? output : output instanceof ArrayBuffer ? new Uint8Array(output) : null;
  if (!bytes?.length) throw new Error('PPTX 转换器没有生成有效文件。');
  return { bytes, warnings };
}
