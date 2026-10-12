import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROFILE } from './core';
import { checkHash, prepareResources } from './resources';
const bytes = new TextEncoder().encode('model');
let saved: Map<string, Response>;
let put: ReturnType<typeof vi.fn>;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  saved = new Map();
  put = vi.fn(async (key: string, response: Response) => { saved.set(key, response.clone()); });
  vi.stubGlobal('caches', { open: vi.fn(async () => ({
    match: async (key: string) => saved.get(key)?.clone(), put,
    delete: async (key: string) => saved.delete(key),
  })) });
  fetcher = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return { ...DEFAULT_PROFILE, repo: 'example/test-model', sha256: Buffer.from(digest).toString('hex') };
}
describe('explicit model resource preparation', () => {
  it('checks SHA-256 and rejects corrupt content', async () => {
    const p = await fixture(); await expect(checkHash(bytes.buffer, p.sha256)).resolves.toBeUndefined();
    await expect(checkHash(new Uint8Array([0]).buffer, p.sha256)).rejects.toThrow('校验失败');
  });
  it('loads four fixed files, checks cache offline and disallows unverified resources', async () => {
    const profile = await fixture();
    const cache = await prepareResources(profile, vi.fn());
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(args => String(args[0]).includes(`/resolve/${profile.revision}/`))).toBe(true);
    await expect(cache.match(`/models/${profile.repo}/config.json`)).resolves.toBeInstanceOf(Response);
    await expect(cache.match(`https://huggingface.co/${profile.repo}/resolve/main/config.json`)).resolves.toBeInstanceOf(Response);
    expect(await cache.match('https://untrusted.test/model.onnx')).toBeUndefined();
    await expect(cache.put()).rejects.toThrow('未校验');
    fetcher.mockRejectedValue(new Error('offline'));
    await expect(prepareResources(profile, vi.fn())).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('evicts a corrupt cached weight and never reports initialization success', async () => {
    const profile = await fixture(); await prepareResources(profile, vi.fn());
    const key = `https://huggingface.co/${profile.repo}/resolve/${profile.revision}/onnx/model_quantized.onnx`;
    saved.set(key, new Response('damaged'));
    await expect(prepareResources(profile, vi.fn())).rejects.toThrow('校验失败');
    expect(saved.has(key)).toBe(false);
  });
  it('propagates cache quota failure instead of a false ready state', async () => {
    put.mockRejectedValue(new Error('QuotaExceededError'));
    await expect(prepareResources(await fixture(), vi.fn())).rejects.toThrow('QuotaExceededError');
  });
});
