export interface ImageSize { width: number; height: number }
export interface ImageOutputOptions { format: 'png' | 'svg' | 'gif'; frameCount?: number; frameDurationMs?: number; autoSize?: boolean }
export function imageOutputFields(options?: ImageOutputOptions, references: string[] = []): Record<string, string | number> {
  if (!options) return {};
  if (!['png', 'svg', 'gif'].includes(options.format)) throw new Error('输出格式无效。');
  if (options.format === 'png') {
    if (options.frameCount !== undefined || options.frameDurationMs !== undefined || options.autoSize) throw new Error('动画参数仅适用于GIF。');
    return {};
  }
  if (references.length) throw new Error('SVG/GIF仅支持文字生成，请切回普通图片使用参考图编辑。');
  if (options.format === 'svg') {
    if (options.frameCount !== undefined || options.frameDurationMs !== undefined || options.autoSize) throw new Error('动画参数仅适用于GIF。');
    return { output_format: 'svg' };
  }
  const count = options.frameCount ?? 9, duration = options.frameDurationMs ?? 200;
  if (!Number.isInteger(count) || count < 2 || count > 64 || !Number.isInteger(duration) || duration < 20 || duration > 2000 || options.autoSize !== undefined && typeof options.autoSize !== 'boolean') throw new Error('GIF需要2–64帧，每帧20–2000毫秒。');
  return { output_format: 'gif', frame_count: count, frame_duration_ms: duration, ...(options.autoSize ? { size: 'auto' } : {}) };
}

export function requireImageOutputModel(model: string, options?: ImageOutputOptions): void {
  // These named models have a documented protocol. Other compatible providers
  // may expose custom IDs; let their server decide capability rather than guessing.
  if (!options || options.format === 'png') return;
  if (/^gpt-image-/i.test(model) && !/^gpt-image-2\.6-(?:sunburst|flare)(?:-|$)/i.test(model)
      || /^(?:qwen|wan|dall-e)[-.]/i.test(model)) throw new Error('所选模型未声明SVG/GIF输出能力，请使用gpt-image-2.6-sunburst、gpt-image-2.6-flare或支持该格式的兼容模型。');
}
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
  { label: '4K 宽屏 16:9', width: 3840, height: 2160 },
  { label: '4K 竖屏 9:16', width: 2160, height: 3840 },
  { label: '4K 正方形', width: 4096, height: 4096 },
];

export function imageSizeValue(size: ImageSize = DEFAULT_IMAGE_SIZE): string {
  if (!size || ![size.width, size.height].every(value => Number.isInteger(value) && value >= 512 && value <= 4096 && value % 16 === 0)) {
    throw new Error('图片宽高应为512–4096之间的16的倍数。');
  }
  return `${size.width}x${size.height}`;
}

export function validateImagePrompt(prompt: string): string {
  if (!prompt.trim() || [...prompt].length > MAX_IMAGE_PROMPT_LENGTH) throw new Error(`最终生图提示词需要1–${MAX_IMAGE_PROMPT_LENGTH}个字符，请缩短提示词或区域描述。`);
  return prompt.trim();
}
