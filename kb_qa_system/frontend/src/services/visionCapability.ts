import type { ModelProfile, ModelMessageContent } from '@/types/workbench';
import { completeModel } from './workbenchModel';

const colors = [
  { name: 'red', value: '#ef4444' },
  { name: 'green', value: '#22c55e' },
  { name: 'blue', value: '#3b82f6' },
] as const;

export function createVisionProbe(random = Math.random, createCanvas = () => document.createElement('canvas')) {
  const shuffle = () => {
    const result = [...colors];
    for (let index = result.length - 1; index > 0; index--) {
      const selected = Math.floor(random() * (index + 1));
      [result[index], result[selected]] = [result[selected], result[index]];
    }
    return result;
  };
  const upper = shuffle(), lower = shuffle();
  if (upper.every((color, index) => color.name === lower[index].name)) {
    [lower[0], lower[1]] = [lower[1], lower[0]];
  }
  const canvas = createCanvas();
  canvas.width = 96;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法生成本机视觉测试图片。');
  [...upper, ...lower].forEach((color, index) => {
    context.fillStyle = color.value;
    context.fillRect(index % 3 * 32, Math.floor(index / 3) * 32, 32, 32);
  });
  const imageUrl = canvas.toDataURL('image/png');
  if (!imageUrl.startsWith('data:image/png;base64,') || imageUrl.length > 20_000) throw new Error('本机视觉测试图片生成失败。');
  const expected = `${upper.map(color => color.name).join(' ')} / ${lower.map(color => color.name).join(' ')}`;
  const content: ModelMessageContent = [
    { type: 'text', text: '图中有上下两排色块，每排从左到右各有红、绿、蓝三种颜色，但顺序随机。请识别上排再识别下排，只按“red green blue / blue red green”这种格式输出六个英文颜色名。' },
    { type: 'image_url', image_url: { url: imageUrl } },
  ];
  return { expected, message: { role: 'user', content } };
}

export function matchesVisionProbe(answer: string, expected: string): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[.,;:!?]/g, '').replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ');
  return normalize(answer) === normalize(expected);
}

export async function probeVisionModel(profile: ModelProfile, apiKey: string, signal: AbortSignal): Promise<boolean> {
  const probe = createVisionProbe();
  const answer = await completeModel(profile, apiKey, [probe.message], signal);
  return matchesVisionProbe(answer, probe.expected);
}
