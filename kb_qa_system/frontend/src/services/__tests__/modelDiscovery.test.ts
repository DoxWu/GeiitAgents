import { afterEach, expect, it, vi } from 'vitest';
import { discoverModels, normalizeModelList } from '../modelDiscovery';
import { apiClient } from '@/api/client';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@/api/client', () => ({ apiClient: { post: vi.fn() }, getStoredTokens: vi.fn(() => ({ access_token: 'fixture-token' })) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const endpoint = { id: 'test', mode: 'local' as const, baseUrl: 'http://127.0.0.1:11434/v1/' };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('reads only IDs without assuming capabilities and bounds duplicates, invalid IDs and long catalogs', () => {
  expect(normalizeModelList({ data: [{ id: 'chat', capabilities: ['vision'] }, { id: 'chat' }, null, { id: 'bad\n' }, { id: 'bad\x7f' }, { id: 'x'.repeat(201) }] })).toEqual({ models: [{ id: 'chat' }], truncated: true });
  const result = normalizeModelList({ data: Array.from({ length: 501 }, (_, id) => ({ id: String(id) })) });
  expect(result.models).toHaveLength(500); expect(result.truncated).toBe(true);
  expect(normalizeModelList({ data: [] })).toEqual({ models: [], truncated: false });
  expect(normalizeModelList({ data: [], has_more: true }).truncated).toBe(true);
});

it('uses local GET, omits cookies and rejects redirects without requiring a model name', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'local-chat' }] })));
  vi.stubGlobal('fetch', fetcher);
  expect(await discoverModels(endpoint, '', new AbortController().signal)).toEqual({ models: [{ id: 'local-chat' }], truncated: false });
  expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:11434/v1/models', expect.objectContaining({ method: 'GET', headers: {}, credentials: 'omit', cache: 'no-store', redirect: 'error' }));
  expect(apiClient.post).not.toHaveBeenCalled();
});

it('relays only base URL in the body, sends the key in a header and filters metadata again', async () => {
  vi.mocked(apiClient.post).mockResolvedValue({ models: [{ id: 'relay-chat', secret: 'ignored' }], truncated: true });
  expect(await discoverModels({ ...endpoint, mode: 'relay', baseUrl: 'https://models.example/v1' }, 'fixture-key', new AbortController().signal)).toEqual({ models: [{ id: 'relay-chat' }], truncated: true });
  expect(apiClient.post).toHaveBeenCalledWith('/private-models/models', { base_url: 'https://models.example/v1' }, expect.objectContaining({ headers: { 'X-Model-Api-Key': 'fixture-key' }, redirect: 'error', cache: 'no-store' }));
});

it.each(['https://example.com/v1', 'http://127.0.0.1/v1?key=x', 'http://user:password@localhost/v1'])('rejects unsafe local endpoint %s before fetch', async baseUrl => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(discoverModels({ ...endpoint, baseUrl }, 'fixture-key', new AbortController().signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([new Response('fixture-secret', { status: 403 }), new Response('fixture-secret'), new Response('x'.repeat(1024 * 1024 + 1)), new Response('{"data":{}}')])('sanitizes unsupported, malformed and oversized provider responses', async response => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(discoverModels(endpoint, 'fixture-secret', new AbortController().signal)).rejects.toThrow('可继续手填');
});

it('does not issue an already cancelled request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController(); controller.abort();
  await expect(discoverModels(endpoint, '', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
});

it('uses the desktop bridge and cancels native work, ignoring a late response', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(command => command === 'list_local_models' ? new Promise(r => { resolve = r; }) : Promise.resolve(undefined));
  const controller = new AbortController();
  const pending = discoverModels(endpoint, '', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('list_local_models', expect.objectContaining({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' })));
  controller.abort(); resolve({ models: [{ id: 'late' }], truncated: false });
  await rejected;
  expect(invoke).toHaveBeenCalledWith('cancel_local_model', { requestId: (vi.mocked(invoke).mock.calls[0][1] as Record<string, unknown>).requestId });
});

it('times out an unresponsive provider and aborts its request', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => new Promise(() => {})); vi.stubGlobal('fetch', fetcher);
  const pending = discoverModels(endpoint, '', new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(20_000); await rejected;
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
it('discovers purchased provider models without an account relay', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{"data":[{"id":"paid"}]}')); vi.stubGlobal('fetch', fetcher);
  await expect(discoverModels({ ...endpoint, mode: 'direct', baseUrl: 'https://provider.example/v1' }, 'provider-fixture', new AbortController().signal)).resolves.toEqual({ models: [{ id: 'paid' }], truncated: false });
  expect(apiClient.post).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer provider-fixture' }, credentials: 'omit', redirect: 'error' }));
});
