import { validateWorkImage } from '@/services/workbenchImages';
import type { WorkImage } from '@/types/workbench';
export interface CompositionShape { id: string; kind: 'rectangle' | 'ellipse' | 'triangle' | 'text' | 'image'; x: number; y: number; w: number; h: number; rotation: number; layer: number; color: string; text: string; description: string; imageIndex?: number }
export interface ImageStudioDraft { prompt: string; shapes: CompositionShape[]; references: WorkImage[]; result?: WorkImage }
export function newCompositionShape(index: number): CompositionShape {
  return { id: crypto.randomUUID(), kind: 'rectangle', x: 10 + index % 5 * 5, y: 10 + index % 5 * 5, w: 30, h: 22, rotation: 0, layer: index + 1, color: '#c66b39', text: '', description: '' };
}
export function validateShapes(value: unknown): CompositionShape[] {
  if (!Array.isArray(value) || value.length > 24) throw new Error('每页最多24个区域。');
  const ids = new Set();
  for (const shape of value) {
    if (!shape || typeof shape !== 'object' || Object.keys(shape).some(k => !['id','kind','x','y','w','h','rotation','layer','color','text','description','imageIndex'].includes(k))
      || typeof shape.id !== 'string' || !shape.id || ids.has(shape.id) || !['rectangle','ellipse','triangle','text','image'].includes(shape.kind)
      || !['x','y','w','h','rotation','layer'].every(k => typeof shape[k] === 'number' && Number.isFinite(shape[k]))
      || shape.x < 0 || shape.y < 0 || shape.w < 3 || shape.h < 3 || shape.x + shape.w > 100.001 || shape.y + shape.h > 100.001
      || shape.rotation < -360 || shape.rotation > 360 || !Number.isSafeInteger(shape.layer) || shape.layer < 0 || shape.layer > 999
      || !/^#[\da-f]{6}$/i.test(shape.color) || typeof shape.text !== 'string' || shape.text.length > 12000
      || typeof shape.description !== 'string' || shape.description.length > 2000
      || shape.imageIndex !== undefined && (!Number.isInteger(shape.imageIndex) || shape.imageIndex < 0 || shape.imageIndex > 49)) throw new Error('区域位置、内容或样式无效。');
    ids.add(shape.id);
  }
  return structuredClone(value);
}
export function validateImageStudio(value: unknown): ImageStudioDraft {
  const d = value as ImageStudioDraft;
  if (!d || typeof d !== 'object' || Object.keys(d).some(k => !['prompt','shapes','references','result'].includes(k)) || typeof d.prompt !== 'string' || d.prompt.length > 1000 || !Array.isArray(d.references) || d.references.length > 2) throw new Error('图片草稿无效。');
  validateShapes(d.shapes); d.references.forEach(validateWorkImage); if (d.result) validateWorkImage(d.result);
  if ([...d.references, ...(d.result ? [d.result] : [])].reduce((n,i) => n+i.bytes,0) > 4*1024*1024) throw new Error('图片草稿素材总量超过4 MiB。');
  return structuredClone(d);
}
export async function renderComposition(shapes: CompositionShape[], images: WorkImage[] = []): Promise<string> {
  const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('画布不可用。');
  ctx.fillStyle = '#f4f3ef'; ctx.fillRect(0,0,960,540);
  for (const s of [...validateShapes(shapes)].sort((a,b) => a.layer-b.layer)) {
    const x=s.x*9.6,y=s.y*5.4,w=s.w*9.6,h=s.h*5.4;
    ctx.save(); ctx.translate(x+w/2,y+h/2);ctx.rotate(s.rotation*Math.PI/180);ctx.translate(-w/2,-h/2);ctx.fillStyle=s.color;
    if (s.kind === 'ellipse') {ctx.beginPath();ctx.ellipse(w/2,h/2,w/2,h/2,0,0,Math.PI*2);ctx.fill();}
    else if (s.kind === 'triangle') {ctx.beginPath();ctx.moveTo(w/2,0);ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();ctx.fill();}
    else if (s.kind === 'image' && images[s.imageIndex ?? -1]) {const img=new Image();img.src=images[s.imageIndex!].dataUrl;await img.decode();ctx.drawImage(img,0,0,w,h);}
    else if (s.kind !== 'text') ctx.fillRect(0,0,w,h);
    ctx.fillStyle=s.kind === 'text' ? s.color : '#202020'; ctx.font='18px sans-serif';ctx.textBaseline='top';
    const label=s.text || s.description || s.kind; let line='', row=0;
    for (const char of label.slice(0,200)) { if(ctx.measureText(line+char).width>w-12){ctx.fillText(line,6,6+row*24);line='';row++;} if(row*24>h-24)break;line+=char; }ctx.fillText(line,6,6+row*24);ctx.restore();
  }
  return canvas.toDataURL('image/png');
}
