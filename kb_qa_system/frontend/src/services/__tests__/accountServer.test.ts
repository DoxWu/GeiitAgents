import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { accountFetch, getAccountServer, normalizeAccountServer, setAccountServer } from '../accountServer';
import { apiClient, getStoredTokens, refreshAccessToken, storeTokens } from '@/api/client';
import { useAuthStore } from '@/store/authStore';
import * as authApi from '@/api/auth';
import type { TokenResponse } from '@/types/user';

vi.mock('@/api/auth', () => ({ login: vi.fn(), guestLogin: vi.fn() }));
vi.mock('@/store/documentStore', () => ({ useDocumentStore: { getState: () => ({ reset: vi.fn() }) } }));
const tokens = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', user: { id: 1 }, token_type: 'bearer', expires_in: 3600 } as TokenResponse;
beforeEach(() => { localStorage.clear(); setAccountServer('https://accounts-one.example'); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('canonicalizes server roots and preserves reverse proxy prefixes', () => {
  expect(normalizeAccountServer('https://api.geiit.online/')).toBe('https://api.geiit.online/api/v1');
  expect(normalizeAccountServer('https://org.example/kb/api/v1/')).toBe('https://org.example/kb/api/v1');
  expect(normalizeAccountServer('http://localhost:8000')).toBe('http://localhost:8000/api/v1');
  expect(normalizeAccountServer('/api/v1')).toBe(`${window.location.origin}/api/v1`);
});
it.each(['http://org.example', 'https://user:pass@org.example', 'https://org.example/?key=x', 'https://org.example/#other', 'file:///tmp'])('rejects unsafe account server %s', value => {
  expect(() => normalizeAccountServer(value)).toThrow();
});
it('switching servers clears authentication and never sends the old bearer to the new host', async () => {
  storeTokens(tokens); useAuthStore.setState({ isAuthenticated: true, user: tokens.user, tokens });
  setAccountServer('https://accounts-two.example');
  expect(useAuthStore.getState().isAuthenticated).toBe(false); expect(getStoredTokens()).toBeNull();
  const fetcher = vi.fn().mockResolvedValue(new Response('{}')); vi.stubGlobal('fetch', fetcher);
  await apiClient.get('/auth/me');
  expect(fetcher).toHaveBeenCalledWith('https://accounts-two.example/api/v1/auth/me', expect.objectContaining({ headers: { 'Content-Type': 'application/json' }, redirect: 'error', credentials: 'omit' }));
});
it('aborts pending account requests and rejects stale URLs before any retry', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetcher);
  const old = getAccountServer(); const pending = accountFetch(`${old}/auth/me`);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  setAccountServer('https://accounts-two.example'); expect(signal.aborted).toBe(true);
  finish(new Response('{}')); await rejected;
  await expect(accountFetch(`${old}/auth/me`, { headers: { Authorization: 'Bearer new-fixture' } })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('ignores a login response that arrives after a server switch', async () => {
  let finish!: (value: TokenResponse) => void;
  vi.mocked(authApi.login).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = useAuthStore.getState().login({ username: 'fixture@example.com', password: 'fixture' });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  setAccountServer('https://accounts-two.example'); finish(tokens); await rejected;
  expect(getStoredTokens()).toBeNull(); expect(useAuthStore.getState().isAuthenticated).toBe(false);
});
it('discards an account body parsed after a server switch', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) }));
  const pending = apiClient.get('/auth/me');
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  setAccountServer('https://accounts-two.example'); finish({ id: 'old-account-fixture' }); await rejected;
});
it('a late old-server refresh cannot replace new-server tokens', async () => {
  storeTokens(tokens);
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })));
  const pending = refreshAccessToken();
  setAccountServer('https://accounts-two.example'); storeTokens({ ...tokens, access_token: 'new-server-fixture' });
  finish(new Response(JSON.stringify(tokens))); await expect(pending).resolves.toBeNull();
  expect(getStoredTokens()?.access_token).toBe('new-server-fixture');
});
