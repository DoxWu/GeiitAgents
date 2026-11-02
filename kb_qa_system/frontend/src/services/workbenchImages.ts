import type { WorkImage } from '@/types/workbench';

export const MAX_WORK_IMAGE_BYTES = 1_500_000;
export const MAX_CONVERSATION_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_VAULT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_GENERATED_IMAGE_BYTES = MAX_VAULT_IMAGE_BYTES;
const MAX_GENERATED_IMAGE_DATA_URL_LENGTH = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 32;
export const MAX_IMAGES_PER_MESSAGE = 3;
export const MAX_IMAGES_PER_TASK = 50;

export async function readWorkImages(files: FileList | File[]): Promise<WorkImage[]> {
  if (files.length > MAX_IMAGES_PER_MESSAGE) throw new Error('每条消息最多附加 3 张图片。');
  const images: WorkImage[] = [];
  let total = 0;
  for (const file of Array.from(files)) {
    if (file.size < 1 || file.size > MAX_WORK_IMAGE_BYTES) throw new Error('每张输入图片不能超过 1.5 MiB。');
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

function validateImage(image: WorkImage, maxBytes: number): void {
  if (!image || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)
      || typeof image.name !== 'string' || image.name.length > 240 || !Number.isSafeInteger(image.bytes)
      || image.bytes < 1 || image.bytes > maxBytes) throw new Error('图片附件无效或超限。');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
  if (!match || match[1] !== image.mimeType || match[2].length % 4 !== 0 || Math.floor(match[2].length * 3 / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0) !== image.bytes) throw new Error('图片数据无效。');
  const decoded = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
  if (imageType(decoded) !== image.mimeType) throw new Error('图片内容与类型不匹配。');
}

export function validateWorkImage(image: WorkImage): void {
  validateImage(image, MAX_WORK_IMAGE_BYTES);
}

export function validateGeneratedWorkImage(image: WorkImage): void {
  validateImage(image, MAX_GENERATED_IMAGE_BYTES);
}

export function workImageFromDataUrl(dataUrl: string, name: string): WorkImage {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_GENERATED_IMAGE_DATA_URL_LENGTH) throw new Error('模型生成图片超过8 MiB工作台图片容量，请降低输出尺寸后重试。');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw new Error('生图模型返回的数据格式无效。');
  const decoded = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
  const mimeType = imageType(decoded);
  if (!mimeType || mimeType !== match[1] || decoded.length > MAX_GENERATED_IMAGE_BYTES) throw new Error('模型生成图片格式无效或超过8 MiB工作台图片容量。');
  const image = { name: name.slice(0, 240) || 'generated-image.png', mimeType, dataUrl, bytes: decoded.length };
  validateGeneratedWorkImage(image);
  return image;
}
