import type { WorkImage } from '@/types/workbench';
import { imageType, MAX_WORK_IMAGE_BYTES } from '@/services/workbenchImages';

const MAX_PIXELS = 2_500_000;

export async function chartSvgToPng(svg: string, name: string, signal: AbortSignal): Promise<WorkImage> {
  if (!svg.startsWith('<svg ') || svg.length > 1_000_000) throw new Error('图表成果无效或超出转换限制。');
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height || width * height > MAX_PIXELS) throw new Error('图表尺寸超过图片审阅上限，请缩短标题或数据标签。');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('当前设备无法生成图表审阅图片。');
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图表图片编码失败。')), 'image/png'));
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (blob.size < 1 || blob.size > MAX_WORK_IMAGE_BYTES) throw new Error('图表图片超过 1.5 MB 审阅上限，请简化图表后重试。');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (imageType(bytes) !== 'image/png') throw new Error('无法验证生成的图表 PNG。');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { name: name.replace(/\.svg$/i, '.png').slice(0, 240), mimeType: 'image/png', bytes: bytes.length, dataUrl: `data:image/png;base64,${btoa(binary)}` };
  } finally { URL.revokeObjectURL(url); }
}
