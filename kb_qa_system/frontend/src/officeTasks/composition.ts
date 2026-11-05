import { MAX_VAULT_IMAGE_BYTES, validateWorkImage } from '@/services/workbenchImages';
import { validateGeneratedImageAsset } from '@/services/generatedImages';
import type { GeneratedWorkImage, WorkImage } from '@/types/workbench';
import { imageOutputFields, imageSizeValue, validateImagePrompt, type ImageOutputOptions, type ImageSize } from '@/services/imageGeneration';
export interface CompositionShape { id: string; kind: 'rectangle' | 'ellipse' | 'triangle' | 'text' | 'image'; x: number; y: number; w: number; h: number; rotation: number; layer: number; color: string; text: string; description: string; imageIndex?: number }
export interface ImageCanvas extends ImageSize { background: string }
export const DEFAULT_IMAGE_CANVAS: ImageCanvas = { width: 1024, height: 1024, background: '#f4f3ef' };
// Old drafts used a fixed 16:9 preview. Preserve their geometry on load.
export const LEGACY_IMAGE_CANVAS: ImageCanvas = { width: 1536, height: 864, background: '#f4f3ef' };
export interface AnimationBrief { action: string; motion: string; loop: 'seamless' | 'pingpong' | 'once' }
export const DEFAULT_ANIMATION: AnimationBrief = { action: '主体轻轻上下漂浮，完成一次自然眨眼后回到起始姿态', motion: '缓慢、平滑，固定镜头和背景', loop: 'seamless' };
export interface ImageStudioDraft { prompt: string; finalPrompt?: string; shapes: CompositionShape[]; references: WorkImage[]; canvas?: ImageCanvas; result?: GeneratedWorkImage; output?: ImageOutputOptions; animation?: AnimationBrief }
export interface ImageStudioTask { id: string; name: string; updatedAt: string; draft: ImageStudioDraft }
export function validateImageTasks(value: unknown): ImageStudioTask[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('最多保存50个图片任务。');
  const ids = new Set<string>();
  for (const task of value) {
    if (!task || typeof task !== 'object' || Object.keys(task).some(k => !['id', 'name', 'updatedAt', 'draft'].includes(k))
      || typeof task.id !== 'string' || !task.id || task.id.length > 100 || ids.has(task.id)
      || typeof task.name !== 'string' || !task.name.trim() || task.name.length > 100
      || typeof task.updatedAt !== 'string' || !Number.isFinite(Date.parse(task.updatedAt))) throw new Error('图片任务无效。');
    validateImageStudio(task.draft); ids.add(task.id);
  }
  return structuredClone(value);
}
export function imageStudioBytes(data: { imageDraft?: ImageStudioDraft | null; imageTasks?: ImageStudioTask[] }): number {
  return [...(data.imageDraft ? [data.imageDraft] : []), ...(data.imageTasks ?? []).map(task => task.draft)]
    .flatMap(draft => [...draft.references, ...(draft.result ? [draft.result] : [])]).reduce((sum, image) => sum + image.bytes, 0);
}
export function imageCanvas(value?: ImageCanvas): ImageCanvas {
  const canvas = value ?? LEGACY_IMAGE_CANVAS;
  if (!canvas || typeof canvas !== 'object' || Object.keys(canvas).some(key => !['width', 'height', 'background'].includes(key)) || typeof canvas.background !== 'string' || !/^#[\da-f]{6}$/i.test(canvas.background)) throw new Error('画布设置无效。');
  imageSizeValue(canvas);
  return { ...canvas };
}
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
  if (!d || typeof d !== 'object' || Object.keys(d).some(k => !['prompt','finalPrompt','shapes','references','canvas','result','output','animation'].includes(k)) || typeof d.prompt !== 'string' || d.prompt.length > 1000 || d.finalPrompt !== undefined && (typeof d.finalPrompt !== 'string' || d.finalPrompt.length > 6000) || !Array.isArray(d.references) || d.references.length > 2) throw new Error('图片草稿无效。');
  if (d.output) {
    if (Object.keys(d.output).some(key => !['format','frameCount','frameDurationMs','autoSize'].includes(key))) throw new Error('输出设置无效。');
    imageOutputFields(d.output);
  }
  if (d.animation && (Object.keys(d.animation).some(key => !['action','motion','loop'].includes(key)) || typeof d.animation.action !== 'string' || d.animation.action.length > 500 || typeof d.animation.motion !== 'string' || d.animation.motion.length > 300 || !['seamless','pingpong','once'].includes(d.animation.loop))) throw new Error('动画描述无效。');
  imageCanvas(d.canvas);
  validateShapes(d.shapes); d.references.forEach(validateWorkImage); if (d.result) validateGeneratedImageAsset(d.result);
  if ([...d.references, ...(d.result ? [d.result] : [])].reduce((n,i) => n+i.bytes,0) > MAX_VAULT_IMAGE_BYTES) throw new Error('图片草稿素材总量超过128 MiB。');
  return structuredClone(d);
}
export function compositionPrompt(draft: ImageStudioDraft, prompt = draft.prompt): string {
  const canvas = imageCanvas(draft.canvas);
  const regions = validateShapes(draft.shapes).sort((a, b) => a.layer - b.layer).map((shape, index) => {
    const n = (value: number) => Math.round(value * 100) / 100;
    return `区域${index + 1}：左上角(${n(shape.x)}%,${n(shape.y)}%)，宽${n(shape.w)}%、高${n(shape.h)}%，旋转${n(shape.rotation)}°，层${shape.layer}，颜色${shape.color}，示意形状${shape.kind}。主题：${shape.description || '未指定'}。${shape.text ? `需要展示的文字：${JSON.stringify(shape.text)}。` : '不绘制示意标签文字。'}${shape.imageIndex !== undefined ? `使用随请求提供的图${shape.imageIndex + 1}作为此区域的参考素材。` : ''}`;
  });
  return validateImagePrompt([
    `内容与风格：${prompt.trim() || '根据下列区域主题生成图片。'}`,
    ...(draft.output?.format === 'svg' ? ['输出静态SVG矢量图，使用可编辑路径、形状与文字。无脚本、外部资源、嵌入位图或动画；优先清晰轮廓、简洁图层和适量配色。'] : []),
    ...(draft.output?.format === 'gif' ? (() => { const a = draft.animation ?? DEFAULT_ANIMATION; return [
      `生成一段完整动画GIF，不要输出分镜拼图或精灵图。动作：${a.action}。方向、速度和镜头：${a.motion}。`,
      `循环设计：${a.loop === 'seamless' ? '无缝循环，结尾自然衔接开头，主体回到起始位置和姿态' : a.loop === 'pingpong' ? '一个来回动作，末尾回到起点并顺畅循环' : '完整单次动作叙事；播放重复次数由模型输出文件决定'}。保持主体外观、比例、背景、光照与非运动区域一致，避免抖动、突然切镜、物体变形与无关文字。`,
      `时间设置：${draft.output.frameCount ?? 9}帧，每帧${draft.output.frameDurationMs ?? 200}毫秒。构图区域描述初始场景；仅按动作描述移动，保留其他元素和空白。${draft.output.autoSize ? '帧尺寸由接口自动选择，画布宽高仅作为构图比例参考。' : ''}`,
    ]; })() : []),
    `构图约束（布局冲突时以此为准）：画布${canvas.width}×${canvas.height}，背景${canvas.background}。坐标从左上角起，x向右、y向下，均按整张画布百分比计算；层号越大越靠前。保留主体大小、位置、重叠及空白，不擅自居中、放大主体或裁切。区域为元素包围框示意，除明确要求外，不把矩形、椭圆、颜色块或区域标签画成实体或文字。旋转绕区域中心，超出画布的部分裁切。`,
    ...regions,
  ].join('\n'));
}

export async function renderComposition(shapes: CompositionShape[], images: WorkImage[] = [], settings: ImageCanvas = LEGACY_IMAGE_CANVAS): Promise<string> {
  const { width, height, background } = imageCanvas(settings);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('画布不可用。');
  ctx.fillStyle = background; ctx.fillRect(0,0,width,height);
  for (const s of [...validateShapes(shapes)].sort((a,b) => a.layer-b.layer)) {
    const x=s.x*width/100,y=s.y*height/100,w=s.w*width/100,h=s.h*height/100;
    ctx.save(); ctx.translate(x+w/2,y+h/2);ctx.rotate(s.rotation*Math.PI/180);ctx.translate(-w/2,-h/2);ctx.fillStyle=s.color;
    if (s.kind === 'ellipse') {ctx.beginPath();ctx.ellipse(w/2,h/2,w/2,h/2,0,0,Math.PI*2);ctx.fill();}
    else if (s.kind === 'triangle') {ctx.beginPath();ctx.moveTo(w/2,0);ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();ctx.fill();}
    else if (s.kind === 'image' && images[s.imageIndex ?? -1]) {const img=new Image();img.src=images[s.imageIndex!].dataUrl;await img.decode();const scale=Math.min(w/img.naturalWidth,h/img.naturalHeight),iw=img.naturalWidth*scale,ih=img.naturalHeight*scale;ctx.fillRect(0,0,w,h);ctx.drawImage(img,(w-iw)/2,(h-ih)/2,iw,ih);}
    else if (s.kind !== 'text') ctx.fillRect(0,0,w,h);
    ctx.beginPath();ctx.rect(0,0,w,h);ctx.clip();
    ctx.fillStyle=s.kind === 'text' ? s.color : '#202020'; ctx.font=`${Math.round(width/54)}px sans-serif`;ctx.textBaseline='top';
    const label=s.text || s.description || s.kind; let line='', row=0;
    for (const char of label.slice(0,200)) { if(ctx.measureText(line+char).width>w-12){ctx.fillText(line,6,6+row*24);line='';row++;} if(row*24>h-24)break;line+=char; }ctx.fillText(line,6,6+row*24);ctx.restore();
  }
  return canvas.toDataURL('image/png');
}
