import { getAccountServer, accountFetch } from '@/services/accountServer';
import { apiClient, getStoredTokens } from "@/api/client";

import type { ModelMessageContent, ModelProfile } from "@/types/workbench";
import { finishReason, readModelResponse, type FinishReason } from './modelStream';
import { imageType, workImageFromDataUrl } from './workbenchImages';
import type { WorkImage } from '@/types/workbench';

export const isDesktop = () => "__TAURI_INTERNALS__" in window;

export function validateModelEndpoint(profile: Pick<ModelProfile, "baseUrl" | "mode">): string {
  let url: URL;
  if (profile.baseUrl.length > 2048 || [...profile.baseUrl.trim()].some(c => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)) throw new Error("模型接口地址无效。");
  try { url = new URL(profile.baseUrl.trim()); } catch { throw new Error("模型接口地址无效。"); }
  if (url.username || url.password || url.search || url.hash) throw new Error("接口地址不能含凭据、查询参数或片段。");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (profile.mode === "local") {
    if (!loopback || !["http:", "https:"].includes(url.protocol)) throw new Error("本机模型仅支持 localhost、127.0.0.1 或 [::1]。");
  } else if (url.protocol !== "https:" || loopback || url.port && url.port !== "443") {
    throw new Error("云端模型仅支持 HTTPS 公网地址（443 端口）。");
  }
  return url.href.replace(/\/$/, "");
}

export function validateProfile(profile: Pick<ModelProfile, "baseUrl" | "mode" | "model" | "maxTokens" | "name">): string {
  const baseUrl = validateModelEndpoint(profile);
  if (!profile.model.trim() || !profile.name.trim()) throw new Error("连接名称和模型名称不能为空。");
  if ([...profile.model.trim()].length > 200 || [...profile.model].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)) throw new Error("模型名称过长或包含无效字符。");
  if (profile.maxTokens !== undefined && (!Number.isInteger(profile.maxTokens) || profile.maxTokens < 1 || profile.maxTokens > 2147483647)) throw new Error("输出上限应为有效的正整数。");
  return baseUrl;
}

export function validateImageModel(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const model = value.trim();
  if (model.length > 200 || [...model].some(c => c.charCodeAt(0) <= 32 || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)) throw new Error('生图模型名称过长或包含无效字符。');
  return model;
}

async function readBoundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit || !response.body) throw new Error('图片服务响应无效或超过大小限制。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error('图片服务响应超过大小限制。');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function providerImageUrl(value: string, baseUrl: string): string {
  if (value.length > 2048) throw new Error('图片服务返回的图片地址无效。');
  let url: URL;
  try { url = new URL(value, `${baseUrl}/`); } catch { throw new Error('图片服务返回的图片地址无效。'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.port && url.port !== '443'
      || url.hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(url.hostname)
      || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw new Error('图片服务返回了不安全的图片地址。');
  }
  return url.href;
}

async function providerImageDataUrl(image: { b64_json?: unknown; url?: unknown }, baseUrl: string, signal: AbortSignal): Promise<string> {
  if (typeof image.b64_json === 'string' && image.b64_json.length <= 2_100_000) {
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(image.b64_json), character => character.charCodeAt(0)); } catch { throw new Error('图片服务返回了无效的图片数据。'); }
    const mime = imageType(bytes);
    if (!mime) throw new Error('图片服务返回了不支持的图片格式。');
    return `data:${mime};base64,${image.b64_json}`;
  }
  if (typeof image.url !== 'string') throw new Error('图片服务没有返回可用图片。');
  const url = providerImageUrl(image.url, baseUrl);
  const response = await fetch(url, { method: 'GET', signal, credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'image/png,image/jpeg,image/webp' } });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error('生成图片下载失败。'); }
  const bytes = await readBoundedBody(response, 1_500_000, signal);
  const mime = imageType(bytes);
  if (!mime) throw new Error('图片服务返回了不支持的图片格式。');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

export function requirePrivateRelay(apiKey: string): void {
  const api = new URL(getAccountServer(), window.location.href);
  if (api.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)) {
    throw new Error("云端地址必须使用 HTTPS 才能传输模型密钥。");
  }
  if (!getStoredTokens()?.access_token) throw new Error("请先登录知识库账号，再使用云端转发。");
  if (!apiKey) throw new Error("此连接尚未填写 API Key。");
}

export async function completeModel(
  profile: ModelProfile, apiKey: string,
  messages: { role: string; content: ModelMessageContent }[], signal: AbortSignal,
  onChunk?: (chunk: string) => void,
  onFinish?: (reason: FinishReason) => void,
): Promise<string> {
  validateProfile(profile);
  if (profile.mode === "direct" && !apiKey) throw new Error("此连接尚未填写 API Key。");
  if (signal.aborted) throw new DOMException("已取消", "AbortError");
  if (profile.mode === "relay") {
    requirePrivateRelay(apiKey);
    try {
      const body = { base_url: profile.baseUrl, model: profile.model, messages, ...(profile.maxTokens === undefined ? {} : { max_tokens: profile.maxTokens }) };
      if (onChunk) {
        const result = await relayStream('/private-models/complete/stream', body, signal, onChunk, { 'X-Model-Api-Key': apiKey });
        onFinish?.(result.finishReason); return result.content;
      }
      const result = await apiClient.post<{ content: string }>("/private-models/complete", body, { headers: { "X-Model-Api-Key": apiKey }, signal, cache: "no-store", redirect: "error" });
      return result.content;
    } catch (error) {
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      throw new Error(error instanceof Error ? error.message : "模型请求失败。");
    }
  }
  if (isDesktop()) {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    const requestId = crypto.randomUUID();
    const abort = () => { void invoke("cancel_local_model", { requestId }).catch(() => {}); };
    let accepting = true, callbackFailed = false, streamedLength = 0;
    const channel = onChunk ? new Channel<{ content: string }>(event => {
      if (!accepting || signal.aborted || callbackFailed) return;
      try {
        if (typeof event?.content !== 'string') throw new Error();
        streamedLength += event.content.length;
        if (streamedLength > 1_000_000) throw new Error();
        if (event.content) onChunk(event.content);
      } catch { callbackFailed = true; abort(); }
    }) : undefined;
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      const result = await invoke<{ content: string; finish_reason?: string }>(channel ? "stream_local_model" : "complete_local_model", {
        requestId, baseUrl: profile.baseUrl, apiKey, ...(profile.mode === "direct" ? { direct: true } : {}), model: profile.model, messages, maxTokens: profile.maxTokens,
        ...(channel ? { onChunk: channel } : {}),
      });
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      if (callbackFailed || typeof result?.content !== 'string' || !result.content.trim() || result.content.length > 1_000_000) throw new Error();
      onFinish?.(finishReason(result.finish_reason));
      return result.content;
    } catch {
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      throw new Error(profile.mode === 'local' ? "本机模型请求失败或输出中断，请检查服务、模型名称和接口地址。" : "自购 API 请求失败或输出中断，请检查模型名称、密钥和接口地址。");
    } finally {
      accepting = false;
      if (channel) channel.onmessage = () => {};
      signal.removeEventListener("abort", abort);
    }
  }
  try {
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: profile.model, messages, max_tokens: profile.maxTokens, stream: Boolean(onChunk) }),
      signal, redirect: "error", cache: "no-store", credentials: "omit",
    });
    const result = await readModelResponse(response, signal, onChunk);
    onFinish?.(result.finishReason); return result.content;
  } catch {
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    throw new Error(profile.mode === 'local' ? "本机模型请求失败或输出中断。请检查服务、模型名称和跨域设置。" : "自购 API 请求失败或输出中断。请检查模型名称、密钥和跨域设置。");
  }
}

export async function generateWorkImage(profile: ModelProfile, apiKey: string, prompt: string, signal: AbortSignal): Promise<WorkImage> {
  const model = validateImageModel(profile.imageModel);
  const baseUrl = validateProfile(profile);
  if (!model) throw new Error('请先在模型连接中配置兼容的生图模型名称。');
  if (!prompt.trim() || prompt.length > 1000) throw new Error('图片生成描述需要 1–1000 个字符。');
  if (profile.mode === 'relay') {
    requirePrivateRelay(apiKey);
    const result = await apiClient.post<{ data_url: string }>('/private-models/images/generate', { base_url: baseUrl, model, prompt: prompt.trim() }, {
      signal, headers: { 'X-Model-Api-Key': apiKey }, cache: 'no-store', redirect: 'error',
    });
    return workImageFromDataUrl(result.data_url, 'generated-image.png');
  }
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const requestId = crypto.randomUUID(), abort = () => { void invoke('cancel_local_model', { requestId }).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) throw new Error();
      const encoded = await invoke<string>('generate_local_image', { requestId, baseUrl, apiKey, model, prompt: prompt.trim(), direct: profile.mode === 'direct' });
      if (signal.aborted || typeof encoded !== 'string' || encoded.length > 2_000_000) throw new Error();
      const mime = imageType(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)));
      if (!mime) throw new Error();
      return workImageFromDataUrl(`data:${mime};base64,${encoded}`, 'generated-image.png');
    } catch (error) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      // Tauri rejects before sending the request when a command lacks ACL
      // permission or an older installed host does not implement it. Never
      // display arbitrary native errors, which could contain request secrets.
      const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
      if (/\bgenerate_local_image\b/i.test(message)) {
        if (/not allowed|denied|not permitted|forbidden/i.test(message)) throw new Error('当前桌面版本未授予生图调用权限，请更新客户端后重试。');
        if (/not found|unknown command/i.test(message)) throw new Error('当前桌面版本不支持生图命令，请更新客户端后重试。');
      }
      if (message === 'Too many active requests') throw new Error('当前模型任务已达并发上限，请等待其他任务结束后重试。');
      throw new Error('生图模型请求失败，请检查模型名称、密钥与图片接口兼容性。');
    }
    finally { signal.removeEventListener('abort', abort); }
  }
  try {
    const response = await fetch(`${baseUrl}/images/generations`, { method: 'POST', signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, prompt: prompt.trim(), n: 1, size: '1024x1024', response_format: 'b64_json' }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const data = await readBoundedBody(response, 3 * 1024 * 1024, signal);
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as { data?: { b64_json?: unknown; url?: unknown }[] };
    if (!Array.isArray(payload.data) || payload.data.length !== 1) throw new Error();
    const dataUrl = await providerImageDataUrl(payload.data[0], baseUrl, signal);
    return workImageFromDataUrl(dataUrl, 'generated-image.png');
  } catch (error) {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (error instanceof Error && ['生成图片下载失败。', '图片服务返回的图片地址无效。', '图片服务返回了不安全的图片地址。',
      '图片服务返回了无效的图片数据。', '图片服务返回了不支持的图片格式。', '图片服务响应无效或超过大小限制。',
      '图片服务响应超过大小限制。', '图片服务没有返回可用图片。'].includes(error.message)) throw error;
    throw new Error('生图接口请求失败或未返回可用图片，请检查模型、接口兼容性和跨域设置。');
  }
}

export async function getAccountModel(signal: AbortSignal): Promise<{ model: string } | null> {
  const result = await apiClient.get<{ available: boolean; model?: string }>("/private-models/account", { signal, cache: "no-store", redirect: "error" });
  return result.available && result.model ? { model: result.model } : null;
}

export async function completeAccountModel(
  messages: { role: string; content: ModelMessageContent }[], signal: AbortSignal,
  onChunk?: (chunk: string) => void,
  onFinish?: (reason: FinishReason) => void,
): Promise<{ content: string; model: string }> {
  if (!onChunk) return apiClient.post("/private-models/account/complete", { messages }, { signal, cache: "no-store", redirect: "error" });
  const result = await relayStream('/private-models/account/complete/stream', { messages }, signal, onChunk);
  onFinish?.(result.finishReason); return { content: result.content, model: result.model || '账号云端模型' };
}

async function relayStream(endpoint: string, body: unknown, signal: AbortSignal, onChunk: (text: string) => void, headers: Record<string, string> = {}) {
  const token = getStoredTokens()?.access_token;
  if (!token) throw new Error('请先登录知识库账号。');
  try {
    const response = await accountFetch(`${getAccountServer()}${endpoint}`, { method: 'POST', body: JSON.stringify(body), signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, cache: 'no-store', redirect: 'error', credentials: 'omit' });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new Error(response.status === 401 ? '请重新登录知识库账号。' : '当前账号无权使用此模型连接。');
    }
    return await readModelResponse(response, signal, onChunk, true);
  } catch (error) {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (error instanceof Error && ['请重新登录知识库账号。', '当前账号无权使用此模型连接。'].includes(error.message)) throw error;
    throw new Error('云端模型请求失败或输出中断，请检查连接和模型权限后重试。');
  }
}
