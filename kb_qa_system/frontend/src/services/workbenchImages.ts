import type { WorkImage } from '@/types/workbench';

export const MAX_WORK_IMAGE_BYTES = 1_500_000;
export const MAX_CONVERSATION_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 3;

export async function readWorkImages(files: FileList | File[]): Promise<WorkImage[]> {
  if (files.length > MAX_IMAGES_PER_MESSAGE) throw new Error('每条消息最多附加 3 张图片。');
  const images: WorkImage[] = [];
  let total = 0;
  for (const file of Array.from(files)) {
    if (file.size < 1 || file.size > MAX_WORK_IMAGE_BYTES) throw new Error('每张图片必须小于 1.5 MB。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = imageType(bytes);
    if (!mimeType || file.type && file.type !== mimeType) throw new Error('仅支持内容有效且类型一致的 PNG、JPEG 或 WebP 图片。');
    total += bytes.byteLength;
    if (total > MAX_CONVERSATION_IMAGE_BYTES) throw new Error('本次选择的图片总量超过 4 MiB。');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    images.push({ name: file.name.slice(0, 240) || 'image', mimeType, dataUrl: `data:${mimeType};base64,${btoa(binary)}`, bytes: bytes.byteLength });
  }
  return images;
}

export function imageType(bytes: Uint8Array): WorkImage['mimeType'] | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && String.fromCharCode(...bytes.subarray(1, 4)) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
}

export function validateWorkImage(image: WorkImage): void {
  if (!image || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)
      || typeof image.name !== 'string' || image.name.length > 240 || !Number.isSafeInteger(image.bytes)
      || image.bytes < 1 || image.bytes > MAX_WORK_IMAGE_BYTES) throw new Error('图片附件无效或超限。');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
  if (!match || match[1] !== image.mimeType || match[2].length % 4 !== 0 || Math.floor(match[2].length * 3 / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0) !== image.bytes) throw new Error('图片数据无效。');
  const decoded = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
  if (imageType(decoded) !== image.mimeType) throw new Error('图片内容与类型不匹配。');
}
