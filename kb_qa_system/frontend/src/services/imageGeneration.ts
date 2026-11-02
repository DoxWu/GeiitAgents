export interface ImageSize { width: number; height: number }
export const DEFAULT_IMAGE_SIZE: ImageSize = { width: 1024, height: 1024 };
export const MAX_IMAGE_PROMPT_LENGTH = 6000;
export const IMAGE_SIZE_PRESETS = [
  { label: '正方形 1:1', width: 1024, height: 1024 },
  { label: '横向 3:2', width: 1536, height: 1024 },
  { label: '竖向 2:3', width: 1024, height: 1536 },
  { label: '宽屏 16:9', width: 1536, height: 864 },
  { label: '竖屏 9:16', width: 864, height: 1536 },
  { label: '横向 4:3', width: 1024, height: 768 },
  { label: '竖向 3:4', width: 768, height: 1024 },
];

export function imageSizeValue(size: ImageSize = DEFAULT_IMAGE_SIZE): string {
  if (!size || ![size.width, size.height].every(value => Number.isInteger(value) && value >= 512 && value <= 2048 && value % 16 === 0)) {
    throw new Error('图片宽高应为512–2048之间的16的倍数。');
  }
  return `${size.width}x${size.height}`;
}

export function validateImagePrompt(prompt: string): string {
  if (!prompt.trim() || [...prompt].length > MAX_IMAGE_PROMPT_LENGTH) throw new Error(`最终生图提示词需要1–${MAX_IMAGE_PROMPT_LENGTH}个字符，请缩短提示词或区域描述。`);
  return prompt.trim();
}
