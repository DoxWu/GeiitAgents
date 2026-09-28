import { afterEach, expect, it, vi } from 'vitest';
import { completeToolModel } from '../officeToolModel';
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: reply }] }))));
  expect(await completeToolModel(profile, '', messages, new AbortController().signal)).toEqual(reply);
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['inspect_csv', 'render_chart', 'create_document']);
  expect(body).not.toHaveProperty('max_tokens'); expect(body.stream).toBe(false);
  expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
});

it('keeps private keys in the relay header and account model choice on the server', async () => {
  vi.mocked(apiClient.post).mockResolvedValue(reply);
  await completeToolModel({ ...profile, mode: 'relay', baseUrl: 'https://models.example/v1', maxTokens: 1234 }, 'fixture-key', messages, new AbortController().signal);
  expect(apiClient.post).toHaveBeenLastCalledWith('/private-models/tools/complete', { base_url: 'https://models.example/v1', model: 'fixture', messages, max_tokens: 1234 }, expect.objectContaining({ headers: { 'X-Model-Api-Key': 'fixture-key' } }));
  await completeToolModel(null, '', messages, new AbortController().signal);
  expect(apiClient.post).toHaveBeenLastCalledWith('/private-models/account/tools/complete', { messages }, expect.not.objectContaining({ headers: expect.anything() }));
});

it('uses and cancels the native structured command without accepting a late reply', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(command => command === 'cancel_local_model' ? Promise.resolve(undefined) : new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = completeToolModel(profile, 'fixture-key', messages, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  const args = vi.mocked(invoke).mock.calls[0][1] as Record<string, unknown>;
  expect(JSON.parse(String(args.body)).tools).toHaveLength(3);
  controller.abort(); finish(reply); await rejected;
  expect(invoke).toHaveBeenCalledWith('cancel_local_model', { requestId: args.requestId });
});

it.each([new Response('fixture-key', { status: 400 }), new Response('not-json'), new Response('x'.repeat(2 * 1024 * 1024 + 1))])('sanitizes malformed and oversized local responses', async response => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(completeToolModel(profile, '', messages, new AbortController().signal)).rejects.toThrow('本机模型工具请求失败');
});
