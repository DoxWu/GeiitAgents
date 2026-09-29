import { apiClient, getStoredTokens } from "@/api/client";
import { API_BASE_URL } from "@/utils/constants";
import type { ModelProfile } from "@/types/workbench";
import { finishReason, readModelResponse, type FinishReason } from './modelStream';

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
    throw new Error("云端转发仅支持 HTTPS 公网地址（443 端口）。");
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

export function requirePrivateRelay(apiKey: string): void {
  const api = new URL(API_BASE_URL, window.location.href);
  if (api.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)) {
    throw new Error("云端地址必须使用 HTTPS 才能传输模型密钥。");
  }
  if (!getStoredTokens()?.access_token) throw new Error("请先登录知识库账号，再使用云端转发。");
  if (!apiKey) throw new Error("此连接尚未填写 API Key。");
}

export async function completeModel(
  profile: ModelProfile, apiKey: string,
  messages: { role: string; content: string }[], signal: AbortSignal,
  onChunk?: (chunk: string) => void,
  onFinish?: (reason: FinishReason) => void,
): Promise<string> {
  validateProfile(profile);
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
        requestId, baseUrl: profile.baseUrl, apiKey, model: profile.model, messages, maxTokens: profile.maxTokens,
        ...(channel ? { onChunk: channel } : {}),
      });
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      if (callbackFailed || typeof result?.content !== 'string' || !result.content.trim() || result.content.length > 1_000_000) throw new Error();
      onFinish?.(finishReason(result.finish_reason));
      return result.content;
    } catch {
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      throw new Error("本机模型请求失败或输出中断，请检查服务、模型名称和接口地址。");
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
    throw new Error("本机模型请求失败或输出中断。请检查服务、模型名称和跨域设置。");
  }
}

export async function getAccountModel(signal: AbortSignal): Promise<{ model: string } | null> {
  const result = await apiClient.get<{ available: boolean; model?: string }>("/private-models/account", { signal, cache: "no-store", redirect: "error" });
  return result.available && result.model ? { model: result.model } : null;
}

export async function completeAccountModel(
  messages: { role: string; content: string }[], signal: AbortSignal,
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
    const response = await fetch(`${API_BASE_URL}${endpoint}`, { method: 'POST', body: JSON.stringify(body), signal,
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
