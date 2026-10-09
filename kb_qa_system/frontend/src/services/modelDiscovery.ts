import { apiClient } from '@/api/client';
import type { ModelProfile } from '@/types/workbench';
import { isDesktop, requirePrivateRelay, validateModelEndpoint } from './workbenchModel';

export interface ModelCatalog { models: { id: string }[]; truncated: boolean }
export type ModelEndpoint = Pick<ModelProfile, 'id' | 'baseUrl' | 'mode'>;
const LIST_ERROR = '无法获取模型列表。服务可能不支持列表或未允许跨域；可继续手填模型名称。';

// Discard provider-specific metadata: /models is not a capability contract.
export function normalizeModelList(value: unknown): ModelCatalog {
  if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) throw new Error(LIST_ERROR);
  const models: { id: string }[] = [], seen = new Set<string>();
  let truncated = 'has_more' in value && value.has_more === true;
  for (const item of value.data) {
    const id = item?.id;
    if (typeof id !== 'string' || !id.trim() || id !== id.trim() || [...id].length > 200 || [...id].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)) { truncated = true; continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    if (models.length < 500) models.push({ id }); else truncated = true;
  }
  return { models, truncated };
}

async function discoverModelsRequest(endpoint: ModelEndpoint, apiKey: string, signal: AbortSignal): Promise<ModelCatalog> {
  const baseUrl = validateModelEndpoint(endpoint);
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  if (endpoint.mode === 'relay') {
    requirePrivateRelay(apiKey);
    const result = await apiClient.post<ModelCatalog>('/private-models/models', { base_url: baseUrl }, {
      signal, headers: { 'X-Model-Api-Key': apiKey }, cache: 'no-store', redirect: 'error',
    });
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    return normalizeModelList({ data: result.models, has_more: result.truncated });
  }
  try {
    if (isDesktop()) {
      const { invoke } = await import('@tauri-apps/api/core');
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      const requestId = crypto.randomUUID();
      const abort = () => { void invoke('cancel_local_model', { requestId }).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await invoke<ModelCatalog>('list_local_models', { requestId, baseUrl, apiKey, ...(endpoint.mode === 'direct' ? { direct: true } : {}) });
        if (signal.aborted) throw new DOMException('已取消', 'AbortError');
        return normalizeModelList({ data: result.models, has_more: result.truncated });
      } finally { signal.removeEventListener('abort', abort); }
    }
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET', headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(LIST_ERROR); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '', bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) throw new Error(LIST_ERROR);
        text += decoder.decode(value, { stream: true });
      }
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      return normalizeModelList(JSON.parse(text + decoder.decode()));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    throw new Error(LIST_ERROR);
  }
}

export async function discoverModels(endpoint: ModelEndpoint, apiKey: string, signal: AbortSignal): Promise<ModelCatalog> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
  try {
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new DOMException('已取消', 'AbortError'));
      if (controller.signal.aborted) fail(); else controller.signal.addEventListener('abort', fail, { once: true });
    });
    return await Promise.race([discoverModelsRequest(endpoint, apiKey, controller.signal), aborted]);
  } catch (error) {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (timedOut) throw new Error('获取模型列表超时（20 秒），请检查地址和网络后重试；也可手填模型名称。');
    throw new Error(error instanceof Error ? error.message : LIST_ERROR);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
