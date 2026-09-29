export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'unknown';
export const finishReason = (value: unknown): FinishReason => value === 'stop' || value === 'length' || value === 'content_filter' || value === 'tool_calls' ? value : 'unknown';
export const finishLabel = (reason?: FinishReason) => ({ stop: '模型已结束生成', length: '已达到模型输出上限，回答可能不完整', content_filter: '输出受到模型服务限制，回答可能不完整', tool_calls: '模型请求了工具；此对话未执行工具', unknown: '传输已结束，模型未提供可识别的停止原因' })[reason ?? 'unknown'];

type Event = { data: string; error: boolean };
/** Incremental SSE framing: CR/LF/CRLF, BOM via TextDecoder, multi-line data. */
class Frames {
  private line = '';
  private data: string[] = [];
  private error = false;
  private afterCR = false;
  constructor(private emit: (event: Event) => void, private done: () => boolean) {}
  push(text: string) {
    for (const char of text) {
      if (this.done()) break;
      if (this.afterCR && char === '\n') { this.afterCR = false; continue; }
      this.afterCR = char === '\r';
      if (char === '\r' || char === '\n') this.consume(); else this.line += char;
    }
  }
  private consume() {
    const line = this.line; this.line = '';
    if (!line) { this.emit({ data: this.data.join('\n'), error: this.error }); this.data = []; this.error = false; return; }
    const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value); else if (field === 'event') this.error = value === 'error';
  }
  finish() { if (!this.done()) { if (this.line) this.consume(); if (!this.done()) this.emit({ data: this.data.join('\n'), error: this.error }); } }
}
function firstChoice(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = data.choices;
  if (!Array.isArray(choices)) throw new Error('Invalid choices');
  return choices.find(choice => choice && typeof choice === 'object' && (choice.index === 0 || choices.length === 1 && choice.index == null));
}

/** Strict reader used only by workbench models; cloud knowledge SSE is separate. */
export async function readModelResponse(response: Response, signal: AbortSignal, onChunk?: (text: string) => void, relay = false): Promise<{ content: string; finishReason: FinishReason; model?: string }> {
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error('Model response unavailable'); }
  const sse = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream';
  if (relay && !sse) { await response.body.cancel().catch(() => {}); throw new Error('Expected model stream'); }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, content = '', body = '', done = false, reason: FinishReason = 'unknown', model: string | undefined;
  const check = () => { if (signal.aborted) throw new DOMException('已取消', 'AbortError'); };
  const append = (value: unknown) => {
    check(); if (typeof value !== 'string' || content.length + value.length > 1_000_000) throw new Error('Invalid model content');
    content += value; if (value) onChunk?.(value); check();
  };
  const frames = new Frames(event => {
    check(); if (event.error) throw new Error('Model stream failed');
    const raw = event.data.trim(); if (!raw) return;
    if (!relay && raw === '[DONE]') { done = true; return; }
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || value.error != null) throw new Error('Invalid model event');
    if (relay) {
      if (value.type === 'chunk') append(value.content);
      else if (value.type === 'done') {
        if (typeof value.content !== 'string' || content && value.content !== content) throw new Error('Model stream content mismatch');
        if (!content) append(value.content);
        reason = finishReason(value.finish_reason); model = typeof value.model === 'string' && value.model.length <= 200 ? value.model : undefined; done = true;
      } else throw new Error('Model stream failed');
    } else {
      const choice = firstChoice(value);
      if (choice) {
        const delta = choice.delta as { content?: unknown } | undefined;
        if (delta != null && (typeof delta !== 'object' || Array.isArray(delta))) throw new Error('Invalid model delta');
        if (delta?.content != null) append(delta.content);
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) { reason = finishReason(choice.finish_reason); done = true; }
      }
    }
  }, () => done);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    check();
    while (!done) {
      const next = await reader.read(); check(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > (relay ? 16 : 2) * 1024 * 1024) throw new Error('Model response too large');
      const text = decoder.decode(next.value, { stream: true }); if (sse) frames.push(text); else body += text;
    }
    if (!done) {
      const tail = decoder.decode();
      if (sse) { frames.push(tail); frames.finish(); }
      else {
        const data = JSON.parse(body + tail); if (data?.error != null) throw new Error('Model failed');
        const choice = firstChoice(data), message = choice?.message as { content?: unknown } | undefined;
        append(message?.content); reason = finishReason(choice?.finish_reason); done = true;
      }
    }
    check(); if (!done || !content.trim()) throw new Error('Model stream ended before completion');
    return { content, finishReason: reason, ...(model ? { model } : {}) };
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
