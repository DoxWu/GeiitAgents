import { expect, it } from 'vitest';
import { readWorkImages, validateWorkImage } from '../workbenchImages';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

it('accepts PNG bytes and ignores a misleading filename extension', async () => {
  const [image] = await readWorkImages([new File([png], 'chart.jpg', { type: 'image/png' })]);
  expect(image).toMatchObject({ name: 'chart.jpg', mimeType: 'image/png', bytes: 8, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  expect(() => validateWorkImage(image)).not.toThrow();
});

it('rejects MIME mismatches, spoofed data URLs, and too many attachments', async () => {
  await expect(readWorkImages([new File([png], 'chart.png', { type: 'image/jpeg' })])).rejects.toThrow('类型一致');
  expect(() => validateWorkImage({ name: 'chart.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAAAAAAAAA=', bytes: 8 })).toThrow('内容与类型不匹配');
  await expect(readWorkImages(Array.from({ length: 4 }, (_, index) => new File([png], `${index}.png`, { type: 'image/png' })))).rejects.toThrow('最多附加 3 张');
});
