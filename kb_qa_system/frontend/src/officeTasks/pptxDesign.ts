import pptxgen from 'pptxgenjs';
import { validateWorkImage } from '@/services/workbenchImages';
import type { WorkImage } from '@/types/workbench';
import { validateShapes, type CompositionShape } from './composition';

export type PptxSlideLayout = 'title' | 'bullets' | 'split' | 'quote' | 'image' | 'custom';
export interface PptxDesignSlide {
  id: string;
  title: string;
  layout: PptxSlideLayout;
  content: string;
  topic: string;
  image?: WorkImage;
  regions?: CompositionShape[];
}
export interface PptxDesignDeck {
  title: string;
  theme: { primary: string; secondary: string; background: string; surface: string; text: string };
  slides: PptxDesignSlide[];
}

const layouts: PptxSlideLayout[] = ['title', 'bullets', 'split', 'quote', 'image', 'custom'];
const hex = (value: string) => /^#[\da-f]{6}$/i.test(value);

export function validatePptxDesign(value: unknown): PptxDesignDeck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PPT 设计数据无效。');
  const deck = value as Partial<PptxDesignDeck>;
  if (Object.keys(deck).some(key => !['title', 'theme', 'slides'].includes(key))
    || typeof deck.title !== 'string' || !deck.title.trim() || deck.title.length > 120) throw new Error('演示文稿标题需要 1–120 个字符。');
  const colors = deck.theme;
  if (!colors || Object.keys(colors).some(key => !['primary', 'secondary', 'background', 'surface', 'text'].includes(key))
    || !['primary', 'secondary', 'background', 'surface', 'text'].every(key => hex(colors[key as keyof typeof colors] ?? ''))) throw new Error('主题颜色无效。');
  if (!Array.isArray(deck.slides) || deck.slides.length < 1 || deck.slides.length > 50) throw new Error('演示文稿需要 1–50 页。');
  const ids = new Set<string>();
  let imageBytes = 0;
  for (const slide of deck.slides) {
    if (!slide || Object.keys(slide).some(key => !['id', 'title', 'layout', 'content', 'topic', 'image', 'regions'].includes(key))
      || typeof slide.id !== 'string' || !slide.id || ids.has(slide.id) || typeof slide.title !== 'string' || !slide.title.trim() || slide.title.length > 120
      || typeof slide.content !== 'string' || slide.content.length > 12000 || slide.content.includes('\0')
      || typeof slide.topic !== 'string' || slide.topic.length > 2000 || !layouts.includes(slide.layout)) throw new Error('PPT 页面内容或版式无效。');
    ids.add(slide.id);
    if (slide.regions !== undefined) {
      validateShapes(slide.regions);
      if (slide.regions.some(r => r.imageIndex !== undefined && r.imageIndex !== 0)) throw new Error('本页图片区域只能引用本页素材。');
    }
    if (slide.image) {
      if (Object.keys(slide.image).some(key => !['name', 'mimeType', 'dataUrl', 'bytes'].includes(key))) throw new Error('PPT 图片字段无效。');
      validateWorkImage(slide.image); imageBytes += slide.image.bytes;
    }
  }
  if (deck.slides.filter(slide => slide.image).length > 50 || imageBytes > 4 * 1024 * 1024) throw new Error('PPT 最多附加 50 张图片，图片总量不能超过 4 MiB。');
  return structuredClone(deck as PptxDesignDeck);
}

export async function exportDesignedPptx(value: PptxDesignDeck): Promise<Uint8Array> {
  const deck = validatePptxDesign(value), pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'GeiIt Agents';
  pptx.subject = '可视化页面设计';
  pptx.title = deck.title;
  pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos' };
  for (const [index, item] of deck.slides.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: deck.theme.background.slice(1) };
    if (item.layout === 'custom') {
      for (const region of [...(item.regions ?? [])].sort((a,b) => a.layer-b.layer)) {
        const box = { x: region.x*13.333333/100, y: region.y*7.5/100, w: region.w*13.333333/100, h: region.h*7.5/100, rotate: (region.rotation+360)%360 };
        if (region.kind === 'image' && item.image) slide.addImage({ ...box, data: item.image.dataUrl });
        else if (region.kind !== 'text') slide.addShape(region.kind === 'ellipse' ? pptx.ShapeType.ellipse : region.kind === 'triangle' ? pptx.ShapeType.triangle : pptx.ShapeType.rect, { ...box, fill: { color: region.color.slice(1) }, line: { transparency: 100 } });
        if (region.text) slide.addText(region.text, { ...box, color: region.kind === 'text' ? region.color.slice(1) : deck.theme.text.slice(1), fontSize: 18, margin: 0.08, fit: 'shrink', valign: 'middle' });
      }
      continue;
    }
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.14, h: 7.5, line: { color: deck.theme.primary.slice(1), transparency: 100 }, fill: { color: deck.theme.primary.slice(1) } });
    slide.addText(item.title, { x: item.layout === 'title' ? 0.85 : 0.78, y: item.layout === 'title' ? 1.1 : 0.55, w: 11.8, h: item.layout === 'title' ? 1.2 : 0.75, fontFace: 'Aptos Display', fontSize: item.layout === 'title' ? 34 : 25, bold: true, color: deck.theme.text.slice(1), margin: 0.02, fit: 'shrink', valign: 'middle' });
    const body = item.content.trim();
    if (item.layout === 'quote') {
      slide.addText(body || '在此输入引用或核心观点', { x: 1.2, y: 2.1, w: 10.8, h: 3.2, fontFace: 'Aptos Display', fontSize: 25, italic: true, color: deck.theme.primary.slice(1), align: 'center', valign: 'middle', margin: 0.18, fit: 'shrink' });
    } else if (item.layout === 'image' || item.layout === 'split') {
      const imageBox = item.layout === 'split' ? { x: 7.1, y: 1.65, w: 5.3, h: 4.75 } : { x: 0.85, y: 1.55, w: 11.5, h: 2.9 };
      if (item.image) slide.addImage({ data: item.image.dataUrl, ...imageBox });
      else slide.addText('图片素材预留位置', { ...imageBox, shape: pptx.ShapeType.rect, color: deck.theme.text.slice(1), fill: { color: deck.theme.surface.slice(1) }, line: { color: deck.theme.secondary.slice(1), transparency: 15, dashType: 'dash' }, align: 'center', valign: 'middle', fontSize: 14 });
      if (item.layout === 'split') slide.addText(body || '在此编辑本页文字', { x: 0.85, y: 1.65, w: 5.8, h: 4.75, color: deck.theme.text.slice(1), fontSize: 17, valign: 'middle', breakLine: false, margin: 0.16, fit: 'shrink' });
      else slide.addText(body || '在此编辑本页文字', { x: 0.85, y: 4.65, w: 11.5, h: 1.55, color: deck.theme.text.slice(1), fontSize: 17, valign: 'middle', breakLine: false, margin: 0.16, fit: 'shrink' });
    } else {
      const lines = body ? body.split(/\r?\n/).map(line => line.replace(/^\s*(?:[-*+] |\d+[.)] )/, '').trim()).filter(Boolean) : ['在此添加页面正文或要点'];
      const bullet = item.layout === 'bullets';
      const startY = item.layout === 'title' ? 2.65 : 1.65;
      const content = bullet ? lines.map(line => `• ${line}`).join('\n') : lines.join('\n');
      slide.addText(content, { x: bullet ? 1.05 : 0.85, y: startY, w: 11.3, h: 4.3, color: deck.theme.text.slice(1), fontSize: bullet ? 18 : 16, valign: 'top', margin: 0.1, fit: 'shrink' });
    }
    slide.addShape(pptx.ShapeType.line, { x: 0.78, y: 7.05, w: 11.95, h: 0, line: { color: deck.theme.secondary.slice(1), transparency: 55, width: 1 } });
    slide.addText(`${deck.title}  ·  ${index + 1}`, { x: 0.8, y: 7.11, w: 10, h: 0.18, color: deck.theme.text.slice(1), transparency: 30, fontSize: 8, margin: 0 });
  }
  const output = await pptx.write({ outputType: 'uint8array', compression: true });
  const bytes = output instanceof Uint8Array ? output : output instanceof ArrayBuffer ? new Uint8Array(output) : null;
  if (!bytes?.length) throw new Error('PPTX 生成器没有生成有效文件。');
  return bytes;
}
