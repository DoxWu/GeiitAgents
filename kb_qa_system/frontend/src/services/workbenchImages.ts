import type { GeneratedWorkImage, WorkImage } from '@/types/workbench';
import { validateGeneratedImageAsset } from './generatedImages';
import { base64ByteLength, decodeBase64, encodeBase64 } from './binaryBase64';
import { GENERATED_IMAGE_TOO_LARGE, MAX_GENERATED_IMAGE_BYTES } from './workbenchCapacity';
export { MAX_GENERATED_IMAGE_BYTES, MAX_VAULT_IMAGE_BYTES } from './workbenchCapacity';

export const MAX_WORK_IMAGE_BYTES = 1_500_000;
export const MAX_CONVERSATION_IMAGE_BYTES = 4 * 1024 * 1024;
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
    images.push({ name: file.name.slice(0, 240) || 'image', mimeType, dataUrl: `data:${mimeType};base64,${encodeBase64(bytes)}`, bytes: bytes.byteLength });
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
  // The full base64 alphabet and byte count were checked above. Only decode
  // the signature for validation; saving/reloading must not copy every pixel.
  const decoded = decodeBase64(match[2].slice(0, 16));
  if (imageType(decoded) !== image.mimeType) throw new Error('图片内容与类型不匹配。');
}

export function validateWorkImage(image: WorkImage): void {
  validateImage(image, MAX_WORK_IMAGE_BYTES);
}

export function validateGeneratedWorkImage(image: WorkImage): void {
  validateImage(image, MAX_GENERATED_IMAGE_BYTES);
}

export function downloadGeneratedWorkImage(image: GeneratedWorkImage): void {
  validateGeneratedImageAsset(image);
  const encoded = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1);
  const bytes = decodeBase64(encoded);
  const extension = image.mimeType === 'image/svg+xml' ? 'svg' : image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType.slice('image/'.length);
  const baseName = Array.from(image.name, character => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character).join('')
    .replace(/\.(?:png|jpe?g|webp|svg|gif)$/i, '')
    .replace(/[. ]+$/g, '')
    .slice(0, 200) || 'generated-image';
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = `${baseName}.${extension}`;
  link.hidden = true;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
}

export function workImageFromDataUrl(dataUrl: string, name: string): WorkImage {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_GENERATED_IMAGE_DATA_URL_LENGTH) throw new Error(GENERATED_IMAGE_TOO_LARGE);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw new Error('生图模型返回的数据格式无效。');
  const bytes = base64ByteLength(match[2]);
  if (bytes > MAX_GENERATED_IMAGE_BYTES) throw new Error(GENERATED_IMAGE_TOO_LARGE);
  const mimeType = imageType(decodeBase64(match[2].slice(0, 16)));
  if (!mimeType || mimeType !== match[1]) throw new Error('生图模型返回的数据格式无效。');
  const image = { name: name.slice(0, 240) || 'generated-image.png', mimeType, dataUrl, bytes };
  return image;
}

export function workImageFromBase64(encoded: string, name: string): WorkImage {
  if (encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4) throw new Error(GENERATED_IMAGE_TOO_LARGE);
  const mime = imageType(decodeBase64(encoded.slice(0, 16)));
  if (!mime) throw new Error('生图模型返回的数据格式无效。');
  return workImageFromDataUrl(`data:${mime};base64,${encoded}`, name);
}
