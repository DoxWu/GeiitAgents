import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { apiClient } from '@/api/client';
import { generateServerImage } from '@/api/serverImages';
import { compositionPrompt, validateImageStudio } from '@/officeTasks/composition';
import { generatedImageFromBase64, generatedImageFromDataUrl } from '../generatedImages';
import { downloadGeneratedWorkImage, validateWorkImage } from '../workbenchImages';
import { imageOutputFields, type ImageOutputOptions } from '../imageGeneration';
import { imageRequest } from '../imageRequest';
import { generateWorkImage } from '../workbenchModel';
import type { ModelProfile, WorkImage } from '@/types/workbench';

vi.mock('@/api/client', () => ({ apiClient: { post: vi.fn() }, getStoredTokens: vi.fn(() => ({ access_token: 'synthetic' })) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="a"><stop stop-color="red"/></linearGradient></defs><path d="M0 0h32v32z" fill="url(#a)"/><text x="2" y="20">测试</text></svg>';
const svgEncoded = Buffer.from(svg).toString('base64');
const gifEncoded = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const profile: ModelProfile = { id: 'image', name: 'image', mode: 'direct', baseUrl: 'https://images.example/v1', model: 'chat', imageModel: 'gpt-image-2.6-sunburst', hasKey: true };
const signal = new AbortController().signal;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([['svg', svgEncoded, 'image/svg+xml'], ['gif', gifEncoded, 'image/gif']] as const)('accepts %s generated outputs without widening reference inputs', (format, encoded, mimeType) => {
  const image = generatedImageFromBase64(encoded);
  expect(image.mimeType).toBe(mimeType);
  expect(generatedImageFromDataUrl(image.dataUrl)).toEqual(image);
  expect(() => validateWorkImage(image as WorkImage)).toThrow();
  const draft = validateImageStudio({ prompt: 'subject', references: [], shapes: [], result: image, output: { format } });
  expect(draft.result?.dataUrl).toBe(image.dataUrl);
});

it.each([
  '<script>alert(1)</script>', '<foreignObject/>', '<image href="data:image/png;base64,aA=="/>',
  '<use href="https://example.test/a.svg#x"/>', '<rect onload="alert(1)"/>',
  '<style>@import "https://example.test/a.css";</style>', '<rect fill="url(https://example.test/x)"/>',
  '<style>rect{fill:u\\72l(https://example.test/x)}</style>', '<animate attributeName="href"/>',
])('rejects active or external SVG content: %s', content => {
  const encoded = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`).toString('base64');
  expect(() => generatedImageFromBase64(encoded)).toThrow();
});

it('accepts static CSS comments and media rules without removing vector styles', () => {
  const xml = '<svg xmlns="http://www.w3.org/2000/svg"><style>/* vector theme */ @media screen {.a{fill:red}}</style><rect class="a" aria-label="help@example.test" width="10" height="10"/></svg>';
  expect(generatedImageFromBase64(Buffer.from(xml).toString('base64')).mimeType).toBe('image/svg+xml');
});

it('uses the documented generation protocol and omits legacy response_format for GPT Image', () => {
  for (const model of ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare']) {
    const request = imageRequest(profile.baseUrl, model, 'loop', '1024x1024', [], { format: 'gif', frameCount: 9, frameDurationMs: 200, autoSize: true });
    expect(request.url).toBe('https://images.example/v1/images/generations');
    expect(JSON.parse(request.body as string)).toEqual({ model, prompt: 'loop', n: 1, size: 'auto', output_format: 'gif', frame_count: 9, frame_duration_ms: 200 });
  }
  expect(() => imageRequest(profile.baseUrl, profile.imageModel!, 'edit', '1024x1024', ['reference'], { format: 'svg' })).toThrow('文字生成');
  expect(() => imageOutputFields({ format: 'gif', frameCount: 65 })).toThrow();
  expect(imageOutputFields({ format: 'svg' })).toEqual({ output_format: 'svg' });
});

it.each(['svg', 'gif'] as const)('preserves %s in browser, native, BYOK and server requests', async format => {
  const encoded = format === 'svg' ? svgEncoded : gifEncoded;
  const output: ImageOutputOptions = format === 'gif' ? { format, frameCount: 12, frameDurationMs: 100, autoSize: true } : { format };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: encoded }] })));
  vi.stubGlobal('fetch', fetcher);
  const browser = await generateWorkImage(profile, 'synthetic', 'subject', signal, undefined, [], output);
  expect(browser.mimeType).toBe(format === 'svg' ? 'image/svg+xml' : 'image/gif');
  expect(JSON.parse(fetcher.mock.calls[0][1].body).output_format).toBe(format);
  vi.stubGlobal('__TAURI_INTERNALS__', {}); vi.mocked(invoke).mockResolvedValue(encoded);
  expect((await generateWorkImage(profile, 'synthetic', 'subject', signal, undefined, [], output)).dataUrl).toBe(browser.dataUrl);
  expect(invoke).toHaveBeenLastCalledWith('generate_local_image', expect.objectContaining({ output }));
  vi.unstubAllGlobals(); vi.mocked(apiClient.post).mockResolvedValue({ data_url: browser.dataUrl });
  await generateWorkImage({ ...profile, mode: 'relay' }, 'synthetic', 'subject', signal, undefined, [], output);
  expect(apiClient.post).toHaveBeenLastCalledWith('/private-models/images/generate', expect.objectContaining({ output_format: format, size: format === 'gif' ? 'auto' : '1024x1024' }), expect.anything());
  const server = await generateServerImage('primary', 'subject', true, signal, undefined, [], output);
  expect(server.dataUrl).toBe(browser.dataUrl);
  expect(apiClient.post).toHaveBeenLastCalledWith('/private-models/server-images/generate', expect.objectContaining({ output_format: format }), expect.anything());
});

it('describes a temporal animation rather than a contact sheet, and keeps manual final prompts independent', () => {
  const draft = { prompt: 'a lantern', references: [], shapes: [], output: { format: 'gif' as const, frameCount: 12, frameDurationMs: 100, autoSize: true } };
  expect(compositionPrompt(draft)).toContain('无缝循环');
  expect(compositionPrompt(draft)).toContain('12帧');
  expect(compositionPrompt(draft)).toContain('不要输出分镜拼图');
  expect(validateImageStudio({ ...draft, finalPrompt: 'user override' }).finalPrompt).toBe('user override');
});

it.each([['svg', svgEncoded], ['gif', gifEncoded]])('downloads original %s bytes with its actual extension', (format, encoded) => {
  let saved: Blob | undefined;
  vi.stubGlobal('URL', class extends URL { static createObjectURL(blob: Blob) { saved = blob; return 'blob:synthetic'; } static revokeObjectURL() {} });
  let filename = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
  const image = generatedImageFromBase64(encoded, 'result.png');
  downloadGeneratedWorkImage(image);
  expect(filename).toBe(`result.${format}`); expect(saved?.size).toBe(image.bytes); expect(saved?.type).toBe(image.mimeType);
});
