import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiClient, HttpClientError } from '../client';
import { login } from '../auth';

const fetcher = vi.fn();
beforeEach(() => { localStorage.clear(); fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => vi.unstubAllGlobals());

it('preserves HTTP failures and a valid request ID for login diagnostics', async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify({ detail: 'fixture rejection' }), { status: 401, headers: { 'X-Request-ID': 'fixture-request:123' } }));
  await expect(login({ username: 'fixture@example.com', password: 'fixture' })).rejects.toMatchObject({ status: 401, requestId: 'fixture-request:123' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined();
});

it('shows a gateway HTTP status even when its error page is HTML', async () => {
  fetcher.mockResolvedValue(new Response('<h1>Bad gateway</h1>', { status: 502, headers: { 'X-Request-ID': 'invalid id with spaces' } }));
  await expect(apiClient.post('/auth/login', {}, { auth: false })).rejects.toMatchObject({ status: 502, requestId: undefined });
});

it('retains HTTP 200 when a login endpoint returns invalid JSON', async () => {
  fetcher.mockResolvedValue(new Response('<html>wrong route</html>', { status: 200 }));
  await expect(apiClient.post('/auth/login', {}, { auth: false })).rejects.toMatchObject({ status: 200, message: expect.stringContaining('JSON') });
});

it('preserves cancellation during response parsing instead of blaming JSON', async () => {
  const controller = new AbortController();
  const aborted = new DOMException('aborted', 'AbortError');
  fetcher.mockResolvedValue({ ok: true, status: 200, json: async () => { controller.abort(); throw aborted; } });
  try { await apiClient.post('/auth/login', {}, { auth: false, signal: controller.signal }); throw new Error('Expected cancellation'); }
  catch (error) { expect(error).toBe(aborted); expect(error).not.toBeInstanceOf(HttpClientError); }
});
