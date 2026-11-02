import { beforeEach, expect, it, vi } from 'vitest';
import { apiClient } from '@/api/client';
import { generateServerImage } from '../serverImages';

vi.mock('@/api/client', () => ({ apiClient: { post: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
const signal = new AbortController().signal;
it('sends composed prompts and dimensions to the server image endpoint', async () => {
  vi.mocked(apiClient.post).mockResolvedValue({ data_url: 'data:image/png;base64,iVBORw0KGgo=' });
  await generateServerImage('primary', '区域说明'.repeat(500), true, signal, { width: 864, height: 1536 });
  expect(apiClient.post).toHaveBeenCalledWith('/private-models/server-images/generate', {
    endpoint_id: 'primary', prompt: '区域说明'.repeat(500), consent: true, size: '864x1536',
  }, expect.objectContaining({ signal }));
});
it('rejects invalid dimensions and absent consent before sending an HTTP request', async () => {
  await expect(generateServerImage('primary', 'synthetic', true, signal, { width: 513, height: 1024 })).rejects.toThrow('16');
  await expect(generateServerImage('primary', 'synthetic', false, signal)).rejects.toThrow('授权');
  expect(apiClient.post).not.toHaveBeenCalled();
});
