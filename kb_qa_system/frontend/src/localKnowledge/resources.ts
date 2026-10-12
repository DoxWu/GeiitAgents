import { DEFAULT_PROFILE, type EmbeddingProfile } from './core';
import { MODEL_CACHE } from './storage';
const DEFAULT_HASHES: Record<string, string> = {
  'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
  'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
};
export async function checkHash(data: ArrayBuffer, expected: string) {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data))).map(b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== expected) throw new Error('模型资源 SHA-256 校验失败；请清除模型缓存后重试。');
}
export async function prepareResources(profile: EmbeddingProfile, report: (message: string) => void) {
  const cache = await caches.open(MODEL_CACHE);
  const weight = profile.dtype === 'q8' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx';
  const verified = new Set<string>();
  const aliases = new Map<string, string>();
  for (const file of ['config.json', 'tokenizer_config.json', 'tokenizer.json', weight]) {
    const url = `https://huggingface.co/${profile.repo}/resolve/${profile.revision}/${file}`;
    for (const key of [url, `https://huggingface.co/${profile.repo}/resolve/main/${file}`,
      `/models/${profile.repo}/${file}`, `models/${profile.repo}/${file}`]) aliases.set(key, url);
    const existing = await cache.match(url);
    report(`${existing ? '校验缓存' : '下载'} ${file}`);
    let data: ArrayBuffer;
    if (existing) data = await existing.arrayBuffer();
    else {
      const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body) throw new Error(`模型下载失败（HTTP ${response.status}），可重试或检查网络。`);
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let bytes = 0, last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 300 * 1024 * 1024) { await reader.cancel(); throw new Error('单个模型文件超过首版 300 MiB 限制。'); }
        parts.push(value);
        if (bytes - last > 1024 * 1024) { report(`下载 ${file} · ${(bytes / 1048576).toFixed(1)} MiB`); last = bytes; }
      }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const part of parts) { combined.set(part, offset); offset += part.length; }
      data = combined.buffer;
    }
    const hash = file === weight ? profile.sha256 : profile.repo === DEFAULT_PROFILE.repo && profile.revision === DEFAULT_PROFILE.revision ? DEFAULT_HASHES[file] : undefined;
    try { if (hash) await checkHash(data, hash); }
    catch (error) { await cache.delete(url); throw error; }
    if (!existing) await cache.put(url, new Response(data));
    verified.add(url);
  }
  return {
    match: async (key: string | Request | URL) => {
      const source = aliases.get(key instanceof Request ? key.url : String(key));
      return source && verified.has(source) ? (await cache.match(source)) ?? undefined : undefined;
    },
    put: async () => { throw new Error('不允许写入未校验的模型资源。'); },
  };
}
