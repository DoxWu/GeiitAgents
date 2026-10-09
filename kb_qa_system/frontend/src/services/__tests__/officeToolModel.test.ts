import { afterEach, expect, it, vi } from 'vitest';
import { completeToolModel, probeToolCallModel } from '../officeToolModel';
import { apiClient } from '@/api/client';
import { invoke } from '@tauri-apps/api/core';
import type { ModelProfile } from '@/types/workbench';
import type { ToolMessage } from '@/officeTasks/toolProtocol';
vi.mock('@/api/client', () => ({ apiClient: { post: vi.fn() }, getStoredTokens: vi.fn(() => ({ access_token: 'fixture' })) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const profile: ModelProfile = { id: 'local', name: 'Local', mode: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', hasKey: false };
const messages: ToolMessage[] = [{ role: 'user', content: 'goal' }];
const reply = { content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'inspect_csv', arguments: '{}' } }] };
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it('sends fixed tool schemas through local HTTP without a default output limit', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response(JSON.stringify({ choices: [{ message: reply }] }))));
  expect(await completeToolModel(profile, '', messages, new AbortController().signal)).toEqual(reply);
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['inspect_csv', 'render_chart', 'create_document']);
  expect(body).not.toHaveProperty('max_tokens'); expect(body.stream).toBe(false);
  expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
});

it('calls a purchased provider directly without the account relay', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: reply }] }))); vi.stubGlobal('fetch', fetcher);
  await expect(completeToolModel({ ...profile, mode: 'direct', baseUrl: 'https://provider.example/v1' }, 'provider-fixture', messages, new AbortController().signal)).resolves.toEqual(reply);
  expect(apiClient.post).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledWith('https://provider.example/v1/chat/completions', expect.objectContaining({ credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer provider-fixture' } }));
});

it('accepts only the requested inert empty-argument tool call as a capability probe', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response(JSON.stringify({ choices: [{ message: reply }] }))));
  await expect(probeToolCallModel(profile, '', new AbortController().signal)).resolves.toBeUndefined();
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('inspect_csv exactly once') }]);
  const answers = [
    { content: 'I can help', tool_calls: [] },
    { content: null, tool_calls: [{ ...reply.tool_calls[0], function: { ...reply.tool_calls[0].function, name: 'create_document' } }] },
    { content: null, tool_calls: [{ ...reply.tool_calls[0], function: { ...reply.tool_calls[0].function, arguments: '{"extra":true}' } }] },
    { content: null, tool_calls: [{ ...reply.tool_calls[0], function: { ...reply.tool_calls[0].function, arguments: '[]' } }] },
  ];
  for (const answer of answers) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: answer }] }))));
    await expect(probeToolCallModel(profile, '', new AbortController().signal)).rejects.toThrow('未执行任何工具');
  }
});

it('keeps private keys in the relay header and account model choice on the server', async () => {
  vi.mocked(apiClient.post).mockResolvedValue(reply);
  await completeToolModel({ ...profile, mode: 'relay', baseUrl: 'https://models.example/v1', maxTokens: 1234 }, 'fixture-key', messages, new AbortController().signal);
  expect(apiClient.post).toHaveBeenLastCalledWith('/private-models/tools/complete', { base_url: 'https://models.example/v1', model: 'fixture', messages, max_tokens: 1234 }, expect.objectContaining({ headers: { 'X-Model-Api-Key': 'fixture-key' } }));
  await completeToolModel(null, '', messages, new AbortController().signal);
  expect(apiClient.post).toHaveBeenLastCalledWith('/private-models/account/tools/complete', { messages }, expect.not.objectContaining({ headers: expect.anything() }));
});

it('advertises web search only after explicit consent on every model path', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response(JSON.stringify({ choices: [{ message: reply }] }))));
  await completeToolModel(profile, '', messages, controller.signal);
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).tools).toHaveLength(3);
  await completeToolModel(profile, '', messages, controller.signal, true);
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)).tools.at(-1).function.name).toBe('search_wikipedia');

  vi.mocked(apiClient.post).mockResolvedValue(reply);
  await completeToolModel({ ...profile, mode: 'relay', baseUrl: 'https://models.example/v1' }, 'fixture-key', messages, controller.signal, true);
  expect(apiClient.post).toHaveBeenLastCalledWith('/private-models/tools/complete', expect.objectContaining({ allow_web_search: true }), expect.anything());
  await completeToolModel(null, '', messages, controller.signal, true);
  expect(apiClient.post).toHaveBeenLastCalledWith('/private-models/account/tools/complete', expect.objectContaining({ messages, allow_web_search: true }), expect.anything());
});

it('uses and cancels the native structured command without accepting a late reply', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(command => command === 'cancel_local_model' ? Promise.resolve(undefined) : new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = completeToolModel(profile, 'fixture-key', messages, controller.signal, true);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  const args = vi.mocked(invoke).mock.calls[0][1] as Record<string, unknown>;
  expect(JSON.parse(String(args.body)).tools.at(-1).function.name).toBe('search_wikipedia');
  controller.abort(); finish(reply); await rejected;
  expect(invoke).toHaveBeenCalledWith('cancel_local_model', { requestId: args.requestId });
});

it.each([new Response('fixture-key', { status: 400 }), new Response('not-json'), new Response('x'.repeat(2 * 1024 * 1024 + 1))])('sanitizes malformed and oversized local responses', async response => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(completeToolModel(profile, '', messages, new AbortController().signal)).rejects.toThrow('本机模型工具请求失败');
});
