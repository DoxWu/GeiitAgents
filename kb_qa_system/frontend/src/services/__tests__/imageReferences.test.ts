import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { apiClient } from '@/api/client';
import { generateServerImage } from '@/api/serverImages';
import type { ModelProfile, WorkImage } from '@/types/workbench';
import { generateWorkImage } from '../workbenchModel';
import { imageReferenceData, imageRequest, imageRequestError, isDashScopeImageEndpoint } from '../imageRequest';

vi.mock('@/api/client', () => ({ apiClient: { post: vi.fn() }, getStoredTokens: vi.fn(() => ({ access_token: 'synthetic' })) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const reference: WorkImage = { name: 'fixture.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', bytes: 8 };
const profile: ModelProfile = { id: 'image', name: 'image', mode: 'direct', baseUrl: 'https://images.example/v1', model: 'chat', imageModel: 'image-edit', hasKey: true };
const signal = new AbortController().signal;
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('sends original reference data through desktop, relay and server requests', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {}); vi.mocked(invoke).mockResolvedValue('iVBORw0KGgo=');
  await generateWorkImage(profile, 'synthetic', 'edit', signal, undefined, [reference]);
  expect(invoke).toHaveBeenCalledWith('generate_local_image', expect.objectContaining({ referenceImages: [reference.dataUrl] }));
  vi.unstubAllGlobals(); vi.mocked(apiClient.post).mockResolvedValue({ data_url: reference.dataUrl });
  await generateWorkImage({ ...profile, mode: 'relay' }, 'synthetic', 'edit', signal, undefined, [reference]);
  expect(apiClient.post).toHaveBeenLastCalledWith('/private-models/images/generate', expect.objectContaining({ reference_images: [reference.dataUrl] }), expect.anything());
  await generateServerImage('primary', 'edit', true, signal, undefined, [reference]);
  expect(apiClient.post).toHaveBeenLastCalledWith('/private-models/server-images/generate', expect.objectContaining({ reference_images: [reference.dataUrl], consent: true }), expect.anything());
});

it.each([1, 2])('sends %s original file(s) using multipart image edits in browsers', async count => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] })));
  vi.stubGlobal('fetch', fetcher);
  await generateWorkImage(profile, 'synthetic', 'edit', signal, undefined, Array(count).fill(reference));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, request] = fetcher.mock.calls[0];
  expect(url).toBe('https://images.example/v1/images/edits');
  expect(request.headers).not.toHaveProperty('Content-Type');
  const files = (request.body as FormData).getAll(count === 1 ? 'image' : 'image[]') as File[];
  expect(files).toHaveLength(count);
  for (const file of files) {
    const dataUrl = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); });
    expect(dataUrl).toBe(reference.dataUrl);
  }
});

it('sends Qwen reference images to the same-origin native editing endpoint and parses its URL result', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgo='), c => c.charCodeAt(0));
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: 'https://cdn.example/edited.png' }] } }] } })))
    .mockResolvedValueOnce(new Response(png));
  vi.stubGlobal('fetch', fetcher);
  const baseUrl = 'https://ws-fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  await generateWorkImage({ ...profile, baseUrl }, 'synthetic', 'keep subject', signal, { width: 1536, height: 864 }, [reference, reference]);
  expect(fetcher.mock.calls[0][0]).toBe('https://ws-fixture.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.input.messages[0].content).toEqual([{ image: reference.dataUrl }, { image: reference.dataUrl }, { text: 'keep subject' }]);
  expect(body.parameters.size).toBe('1536*864');
  expect(fetcher.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
});

it.each([
  [404, {}, '支持图片编辑'],
  [403, { code: 'AllocationQuota.FreeTierOnly', message: 'secret synthetic echo' }, '仅使用免费额度'],
  [401, { message: 'secret synthetic echo' }, '拒绝认证'],
])('reports safe edit failure %s without retrying as text generation', async (status, body, expected) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })); vi.stubGlobal('fetch', fetcher);
  await expect(generateWorkImage(profile, 'synthetic', 'edit', signal, undefined, [reference])).rejects.toThrow(expected as string);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects invalid references before any model request and limits official host detection', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(generateWorkImage(profile, 'synthetic', 'edit', signal, undefined, [{ ...reference, mimeType: 'image/jpeg' }])).rejects.toThrow();
  expect(() => imageReferenceData([reference, reference, reference])).toThrow('2张');
  expect(fetcher).not.toHaveBeenCalled();
  for (const host of ['dashscope.aliyuncs.com.evil.example', 'evil.cn-beijing.maas.aliyuncs.com.evil.example', 'other.aliyuncs.com']) expect(isDashScopeImageEndpoint(new URL(`https://${host}`))).toBe(false);
  expect(isDashScopeImageEndpoint(new URL('https://ws-fixture.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'))).toBe(true);
  const textOnly = imageRequest(profile.baseUrl, 'image', 'text', '1024x1024', []);
  expect(textOnly.url).toContain('/images/generations');
  expect(JSON.parse(textOnly.body as string)).toMatchObject({ model: 'image', prompt: 'text', size: '1024x1024' });
});

it('sends text-only 4K requests to the native DashScope endpoint with its size format', () => {
  const baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const request = imageRequest(baseUrl, 'qwen-image-3.0-pro', 'a synthetic scene', '3840x2160', []);
  expect(request.url).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  expect(request.json).toBe(true);
  expect(JSON.parse(request.body as string)).toEqual({
    model: 'qwen-image-3.0-pro',
    input: { messages: [{ role: 'user', content: [{ text: 'a synthetic scene' }] }] },
    parameters: { n: 1, size: '3840*2160', prompt_extend: false, watermark: false },
  });
});

it('explains 4K parameter rejections without exposing provider bodies', () => {
  const error = imageRequestError(422, new TextEncoder().encode('{"message":"secret fixture"}'), false);
  expect(error.message).toContain('所选宽高');
  expect(error.message).toContain('4K');
  expect(error.message).not.toContain('secret fixture');
  expect(imageRequestError(422, new Uint8Array(), true).message).toContain('参考图格式');
});

it('maps native quota errors without exposing arbitrary provider text', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {}); vi.mocked(invoke).mockRejectedValue('IMAGE_EDIT_QUOTA');
  await expect(generateWorkImage(profile, 'synthetic', 'edit', signal, undefined, [reference])).rejects.toThrow('仅使用免费额度');
});

it('reports unsupported image edits even when the provider sends an empty error body', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 404 })); vi.stubGlobal('fetch', fetcher);
  await expect(generateWorkImage(profile, 'synthetic', 'edit', signal, undefined, [reference])).rejects.toThrow('支持图片编辑');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('downloads and returns generated images above the reference upload limit', async () => {
  const bytes = new Uint8Array(25_000_000); bytes.set(Uint8Array.from(atob('iVBORw0KGgo='), c => c.charCodeAt(0)));
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/large.png' }] })))
    .mockResolvedValueOnce(new Response(bytes)); vi.stubGlobal('fetch', fetcher);
  const image = await generateWorkImage(profile, 'synthetic', 'edit', signal);
  expect(image.bytes).toBe(25_000_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each(['IMAGE_RESULT_TOO_LARGE', 'IMAGE_RESULT_INVALID_FORMAT', 'IMAGE_RESULT_DOWNLOAD_FAILED', 'IMAGE_RESPONSE_TOO_LARGE'])('explains the native image reception failure %s', async code => {
  vi.stubGlobal('__TAURI_INTERNALS__', {}); vi.mocked(invoke).mockRejectedValue(code);
  await expect(generateWorkImage(profile, 'synthetic', 'image', signal)).rejects.toThrow(code === 'IMAGE_RESULT_TOO_LARGE' ? '64 MiB' : code === 'IMAGE_RESPONSE_TOO_LARGE' ? '88 MiB' : code === 'IMAGE_RESULT_INVALID_FORMAT' ? 'PNG' : '下载');
});

it.each([true, false])('explains oversize URL downloads with declared length=%s', async declared => {
  const bytes = new Uint8Array(64 * 1024 * 1024 + 1);
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/oversize.png' }] })))
    .mockResolvedValueOnce(new Response(bytes, { headers: declared ? { 'Content-Length': String(bytes.length) } : {} }));
  vi.stubGlobal('fetch', fetcher);
  await expect(generateWorkImage(profile, 'synthetic', 'image', signal)).rejects.toThrow('超过64 MiB');
});
