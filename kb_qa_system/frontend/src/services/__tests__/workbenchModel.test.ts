import { afterEach, expect, it, vi } from "vitest";
import { completeModel, generateWorkImage, validateProfile } from "../workbenchModel";
import { apiClient, getStoredTokens } from "@/api/client";
import type { ModelProfile } from "@/types/workbench";
import { invoke } from '@tauri-apps/api/core';

vi.mock("@/api/client", () => ({ apiClient: { post: vi.fn(), streamPost: vi.fn() }, getStoredTokens: vi.fn(() => ({ access_token: "account-token" })) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const profile: ModelProfile = { id: "test", name: "test", mode: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "test", hasKey: false };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([
  ['Command generate_local_image not allowed by ACL', '未授予生图调用权限'],
  [new Error('generate_local_image not allowed. Permissions associated with this command: allow-local-model'), '未授予生图调用权限'],
  ['Command generate_local_image not found', '不支持生图命令'],
  ['Too many active requests', '并发上限'],
  ['Provider rejected secret-fixture-key https://private.example/?token=secret', '生图模型请求失败'],
])('reports safe desktop image failures (%s)', async (failure, expected) => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.mocked(invoke).mockRejectedValueOnce(failure);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(generateWorkImage({ ...profile, imageModel: 'qwen-image-3.0-pro' }, '', 'Synthetic image', new AbortController().signal)).rejects.toThrow(expected);
  expect(fetcher).not.toHaveBeenCalled();
});

it('uses the native image command for a desktop direct API connection', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.mocked(invoke).mockResolvedValueOnce('iVBORw0KGgo=');
  const image = await generateWorkImage({ ...profile, mode: 'direct', baseUrl: 'https://models.example/v1', imageModel: 'qwen-image-3.0-pro' }, 'fixture-key', 'Synthetic image', new AbortController().signal);
  expect(image.mimeType).toBe('image/png');
  expect(invoke).toHaveBeenCalledWith('generate_local_image', expect.objectContaining({ baseUrl: 'https://models.example/v1', apiKey: 'fixture-key', model: 'qwen-image-3.0-pro', direct: true }));
});

it.each([undefined, 100000])("omits an unset limit and preserves an explicit one in browser requests (%s)", async (limit) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
  vi.stubGlobal("fetch", fetcher);
  await completeModel({ ...profile, maxTokens: limit }, "", [{ role: "user", content: "hello" }], new AbortController().signal);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  if (limit === undefined) expect(body).not.toHaveProperty("max_tokens");
  else expect(body.max_tokens).toBe(limit);
});

it('downloads Qwen image URLs without forwarding the model API key', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://images.example/result.png?sig=synthetic' }] })))
    .mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png' } }));
  vi.stubGlobal('fetch', fetcher);

  const image = await generateWorkImage(
    { ...profile, mode: 'direct', name: 'Qwen', baseUrl: 'https://models.example/v1', imageModel: 'qwen-image-3.0-pro' },
    'fixture-key', 'Synthetic test image', new AbortController().signal,
  );

  expect(image).toMatchObject({ mimeType: 'image/png', bytes: png.length });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][0]).toContain('/images/generations');
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-key');
  expect(fetcher.mock.calls[1][0]).toBe('https://images.example/result.png?sig=synthetic');
  expect(fetcher.mock.calls[1][1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
  expect(fetcher.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
});

it.each(['http://images.example/result', 'https://127.0.0.1/private', 'https://user:pass@images.example/result', 'https://images.example:8443/result'])('rejects unsafe generated image URL %s before downloading', async resultUrl => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ url: resultUrl }] })));
    vi.stubGlobal('fetch', fetcher);
    await expect(generateWorkImage(
      { ...profile, mode: 'direct', name: 'Qwen', baseUrl: 'https://models.example/v1', imageModel: 'qwen-image-3.0-pro' },
      'fixture-key', 'Synthetic test image', new AbortController().signal,
    )).rejects.toThrow('不安全的图片地址');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

it("omits an unset limit from the serialized relay payload", async () => {
  vi.mocked(getStoredTokens).mockReturnValue({ access_token: "test" } as ReturnType<typeof getStoredTokens>);
  vi.mocked(apiClient.post).mockResolvedValue({ content: "ok" });
  await completeModel({ ...profile, mode: "relay", baseUrl: "https://models.example/v1" }, "fixture", [{ role: "user", content: "hi" }], new AbortController().signal);
  expect(JSON.parse(JSON.stringify(vi.mocked(apiClient.post).mock.calls[0][1]))).not.toHaveProperty("max_tokens");
});

it("streams relay completions through the authenticated SSE endpoint", async () => {
  vi.mocked(getStoredTokens).mockReturnValue({ access_token: "test" } as ReturnType<typeof getStoredTokens>);
  const wire = [{ type: 'chunk', content: '第一段' }, { type: 'chunk', content: '第二段' }, { type: 'done', content: '第一段第二段', finish_reason: 'length' }].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(wire, { headers: { 'content-type': 'text/event-stream' } })));
  const received: string[] = [];
  const finished = vi.fn();
  await expect(completeModel({ ...profile, mode: "relay", baseUrl: "https://models.example/v1" }, "fixture-key", [{ role: "user", content: "hi" }], new AbortController().signal, chunk => received.push(chunk), finished)).resolves.toBe("第一段第二段");
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/private-models/complete/stream'), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test', 'X-Model-Api-Key': 'fixture-key' }), cache: 'no-store', redirect: 'error' }));
  expect(finished).toHaveBeenCalledExactlyOnceWith('length');
  expect(received).toEqual(["第一段", "第二段"]);
});

it("streams account model completions when a callback is supplied", async () => {
  const wire = [{ type: 'chunk', content: '账号模型回答' }, { type: 'done', content: '账号模型回答', model: 'server-model' }].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(wire, { headers: { 'content-type': 'text/event-stream' } })));
  const { completeAccountModel } = await import("../workbenchModel");
  const received: string[] = [];
  await expect(completeAccountModel([{ role: "user", content: "hi" }], new AbortController().signal, chunk => received.push(chunk))).resolves.toEqual({ content: "账号模型回答", model: "server-model" });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/private-models/account/complete/stream'), expect.objectContaining({ headers: expect.not.objectContaining({ 'X-Model-Api-Key': expect.anything() }) }));
  expect(received).toEqual(["账号模型回答"]);
});

it.each([0, -1, 1.5, NaN, 2147483648])("rejects an invalid explicit limit (%s)", (limit) => {
  expect(() => validateProfile({ ...profile, maxTokens: limit })).toThrow();
});

it('renders OpenAI-compatible local SSE chunks incrementally and returns the same final text', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { const encoder = new TextEncoder(); chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk))); controller.close(); },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/event-stream' } })));
  const received: string[] = [];
  await expect(completeModel(profile, '', [{ role: 'user', content: 'hello' }], new AbortController().signal, chunk => received.push(chunk))).resolves.toBe('你好，世界');
  expect(received).toEqual(['你好', '，世界']);
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1].body)).stream).toBe(true);
});
