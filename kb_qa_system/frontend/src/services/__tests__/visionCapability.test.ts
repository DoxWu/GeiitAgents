import { expect, it, vi } from 'vitest';
import { createVisionProbe, matchesVisionProbe } from '../visionCapability';

const image = 'data:image/png;base64,iVBORw0KGgo=';

it('creates a bounded synthetic PNG probe with two randomized swatch orders', () => {
  const context = { fillStyle: '', fillRect: vi.fn() } as unknown as CanvasRenderingContext2D;
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toDataURL: () => image } as unknown as HTMLCanvasElement;
  const sequence = [0, 0, 0, 0, 0, 0]; let offset = 0;
  const probe = createVisionProbe(() => sequence[offset++], () => canvas);
  expect(canvas.width).toBe(96); expect(canvas.height).toBe(64);
  expect(context.fillRect).toHaveBeenCalledTimes(6);
  expect(probe.message.content).toEqual([
    expect.objectContaining({ type: 'text' }),
    { type: 'image_url', image_url: { url: image } },
  ]);
  expect(probe.expected.split(' / ')[0]).not.toBe(probe.expected.split(' / ')[1]);
  expect(probe.expected.replace(' / ', ' ').split(' ').sort()).toEqual(['blue', 'blue', 'green', 'green', 'red', 'red']);
});

it('accepts only an exact color sequence and ignores case and harmless punctuation', () => {
  expect(matchesVisionProbe(' RED green blue / blue red green. ', 'red green blue / blue red green')).toBe(true);
  expect(matchesVisionProbe('red green blue / red green blue', 'red green blue / blue red green')).toBe(false);
  expect(matchesVisionProbe('The colors are red green blue / blue red green', 'red green blue / blue red green')).toBe(false);
});

it('fails closed when the canvas cannot produce a PNG', () => {
  const context = { fillStyle: '', fillRect: vi.fn() } as unknown as CanvasRenderingContext2D;
  const canvas = { getContext: () => context, toDataURL: () => 'data:image/jpeg;base64,AA==' } as unknown as HTMLCanvasElement;
  expect(() => createVisionProbe(Math.random, () => canvas)).toThrow('视觉测试图片生成失败');
});
