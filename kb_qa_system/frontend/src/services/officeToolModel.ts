import { apiClient } from '@/api/client';
import type { ModelProfile } from '@/types/workbench';
import { OFFICE_TOOLS, normalizeToolReply, validateToolMessages, type ToolMessage, type ToolReply } from '@/officeTasks/toolProtocol';
import { isDesktop, requirePrivateRelay, validateProfile } from './workbenchModel';

export async function completeToolModel(profile: ModelProfile | null, apiKey: string, messages: ToolMessage[], signal: AbortSignal): Promise<ToolReply> {
  validateToolMessages(messages);
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  if (!profile) {
    const reply = await apiClient.post('/private-models/account/tools/complete', { messages }, { signal, cache: 'no-store', redirect: 'error' });
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    return normalizeToolReply(reply);
  }
  const baseUrl = validateProfile(profile);
  if (profile.mode === 'relay') {
    requirePrivateRelay(apiKey);
    const reply = await apiClient.post('/private-models/tools/complete', { base_url: baseUrl, model: profile.model, messages, ...(profile.maxTokens === undefined ? {} : { max_tokens: profile.maxTokens }) },
      { signal, headers: { 'X-Model-Api-Key': apiKey }, cache: 'no-store', redirect: 'error' });
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    return normalizeToolReply(reply);
  }
  const body = { model: profile.model, messages, tools: OFFICE_TOOLS, tool_choice: 'auto', stream: false, ...(profile.maxTokens === undefined ? {} : { max_tokens: profile.maxTokens }) };
  try {
    if (isDesktop()) {
      const { invoke } = await import('@tauri-apps/api/core');
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      const requestId = crypto.randomUUID();
      const abort = () => { void invoke('cancel_local_model', { requestId }).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await invoke('complete_local_tools', { requestId, baseUrl, apiKey, body: JSON.stringify(body) });
        if (signal.aborted) throw new DOMException('已取消', 'AbortError');
        return normalizeToolReply(result);
      } finally { signal.removeEventListener('abort', abort); }
    }
    const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, text = '';
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 2 * 1024 * 1024) throw new Error();
        text += decoder.decode(value, { stream: true });
      }
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      return normalizeToolReply(JSON.parse(text + decoder.decode()).choices?.[0]?.message);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    throw new Error('本机模型工具请求失败或格式无效，请检查模型的工具调用支持与接口配置。');
  }
}
