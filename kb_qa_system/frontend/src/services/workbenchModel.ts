import { apiClient, getStoredTokens } from "@/api/client";
import { API_BASE_URL } from "@/utils/constants";
import type { ModelProfile } from "@/types/workbench";

export const isDesktop = () => "__TAURI_INTERNALS__" in window;

export function validateProfile(profile: Pick<ModelProfile, "baseUrl" | "mode" | "model" | "maxTokens" | "name">): string {
  let url: URL;
  try { url = new URL(profile.baseUrl.trim()); } catch { throw new Error("模型接口地址无效。"); }
  if (url.username || url.password || url.search || url.hash) throw new Error("接口地址不能含凭据、查询参数或片段。");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (profile.mode === "local") {
    if (!loopback || !["http:", "https:"].includes(url.protocol)) throw new Error("本机模型仅支持 localhost、127.0.0.1 或 [::1]。");
  } else if (url.protocol !== "https:" || loopback || url.port && url.port !== "443") {
    throw new Error("云端转发仅支持 HTTPS 公网地址（443 端口）。");
  }
  if (!profile.model.trim() || !profile.name.trim()) throw new Error("连接名称和模型名称不能为空。");
  if (profile.maxTokens !== undefined && (!Number.isInteger(profile.maxTokens) || profile.maxTokens < 1 || profile.maxTokens > 2147483647)) throw new Error("输出上限应为有效的正整数。");
  return url.href.replace(/\/$/, "");
}

export async function completeModel(
  profile: ModelProfile, apiKey: string,
  messages: { role: string; content: string }[], signal: AbortSignal,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  validateProfile(profile);
  if (signal.aborted) throw new DOMException("已取消", "AbortError");
  if (profile.mode === "relay") {
    const api = new URL(API_BASE_URL, window.location.href);
    if (api.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)) {
      throw new Error("云端地址必须使用 HTTPS 才能传输模型密钥。");
    }
    if (!getStoredTokens()?.access_token) throw new Error("请先登录知识库账号，再使用云端转发。");
    if (!apiKey) throw new Error("此连接尚未填写 API Key。");
    try {
      const result = await apiClient.post<{ content: string }>("/private-models/complete", {
        base_url: profile.baseUrl, model: profile.model, messages, max_tokens: profile.maxTokens,
      }, { headers: { "X-Model-Api-Key": apiKey }, signal, cache: "no-store", redirect: "error" });
      return result.content;
    } catch (error) {
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      throw new Error(error instanceof Error ? error.message : "模型请求失败。");
    }
  }
  if (isDesktop()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const requestId = crypto.randomUUID();
    const abort = () => { void invoke("cancel_local_model", { requestId }).catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      const result = await invoke<{ content: string }>("complete_local_model", {
        requestId, baseUrl: profile.baseUrl, apiKey, model: profile.model, messages, maxTokens: profile.maxTokens,
      });
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      return result.content;
    } catch {
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      throw new Error("本机模型请求失败，请检查服务、模型名称和接口地址。");
    } finally { signal.removeEventListener("abort", abort); }
  }
  try {
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: profile.model, messages, max_tokens: profile.maxTokens, stream: Boolean(onChunk) }),
      signal, redirect: "error", cache: "no-store", credentials: "omit",
    });
    if (!response.ok) throw new Error();
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let size = 0;
    const streamed = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
    let content = "";
    let sseBuffer = "";
    const consumeSse = (chunk: string) => {
      sseBuffer += chunk;
      const lines = sseBuffer.split(/\r?\n/);
      sseBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const value = line.slice(5).trim();
        if (!value || value === "[DONE]") continue;
        const delta = JSON.parse(value).choices?.[0]?.delta?.content;
        if (typeof delta === "string") { content += delta; onChunk?.(delta); }
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
        const text = decoder.decode(value, { stream: true });
        if (streamed) consumeSse(text); else body += text;
      }
      const finalText = decoder.decode();
      if (streamed) consumeSse(finalText + "\n\n"); else body += finalText;
    } finally { reader.releaseLock(); }
    if (streamed) {
      if (!content.trim() || content.length > 1_000_000) throw new Error();
      return content;
    }
    const data = JSON.parse(body);
    content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim() || content.length > 1_000_000) throw new Error();
    onChunk?.(content);
    return content;
  } catch {
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    throw new Error("无法连接本机模型。请检查服务和模型名称；浏览器需允许跨域，桌面版无需配置浏览器跨域。");
  }
}

export async function getAccountModel(signal: AbortSignal): Promise<{ model: string } | null> {
  const result = await apiClient.get<{ available: boolean; model?: string }>("/private-models/account", { signal, cache: "no-store", redirect: "error" });
  return result.available && result.model ? { model: result.model } : null;
}

export async function completeAccountModel(messages: { role: string; content: string }[], signal: AbortSignal): Promise<{ content: string; model: string }> {
  return apiClient.post("/private-models/account/complete", { messages }, { signal, cache: "no-store", redirect: "error" });
}
