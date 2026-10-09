import { safeStorage } from '@/utils/safeStorage';

export const DEFAULT_ACCOUNT_SERVER = 'https://api.geiit.online/api/v1';
const SERVER_KEY = 'kb_account_server';
const listeners = new Set<() => void>();
export function normalizeAccountServer(value: string): string {
  let url: URL;
  try { url = value.trim().startsWith('/') && !value.trim().startsWith('//') ? new URL(value.trim(), window.location.origin) : new URL(value.trim()); } catch { throw new Error('请输入有效的账号服务器地址。'); }
  if (url.username || url.password || url.search || url.hash || /[\s\\]/.test(value.trim())) throw new Error('服务器地址不能包含凭据、查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('账号服务器必须使用 HTTPS；本机开发地址可使用 HTTP。');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/api/v1') ? path : `${path}/api/v1`;
  return url.href.replace(/\/$/, '');
}
const configured = import.meta.env.VITE_API_BASE_URL || DEFAULT_ACCOUNT_SERVER;
let server = normalizeAccountServer(configured);
try { const saved = safeStorage.getItem(SERVER_KEY); if (saved) server = normalizeAccountServer(saved); } catch { /* Ignore invalid saved addresses. */ }
if (!safeStorage.getItem('kb_auth_server') && ('__TAURI_INTERNALS__' in window || safeStorage.getItem(SERVER_KEY) || !import.meta.env.VITE_API_BASE_URL)) {
  safeStorage.removeItem('kb_auth_tokens'); safeStorage.removeItem('kb_auth_user');
}
let generation = 0;
let lifetime = new AbortController();
export const getAccountServer = () => server;
export const getAccountGeneration = () => generation;
export const getAccountSignal = () => lifetime.signal;
export function subscribeAccountServer(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function setAccountServer(value: string): void {
  const next = normalizeAccountServer(value);
  if (next === server) return;
  lifetime.abort(); lifetime = new AbortController(); generation++;
  server = next;
  safeStorage.setItem(SERVER_KEY, server);
  safeStorage.removeItem('kb_auth_tokens'); safeStorage.removeItem('kb_auth_user');
  listeners.forEach(listener => listener());
}

// A server change aborts account requests; redirects must never forward credentials.
export async function accountFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const address = input instanceof Request ? input.url : String(input);
  if (!address.startsWith(`${server}/`)) throw new DOMException('账号服务器已切换或请求地址无效', 'AbortError');
  const version = generation;
  const response = await fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal, redirect: 'error', credentials: 'omit' });
  if (version !== generation) { await response.body?.cancel(); throw new DOMException('账号服务器已切换', 'AbortError'); }
  return response;
}
