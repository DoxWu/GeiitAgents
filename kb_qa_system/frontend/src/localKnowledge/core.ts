// This module deliberately has no imports from cloud APIs or chat model settings.
export interface EmbeddingProfile {
  repo: string; revision: string; sha256: string; dtype: 'q8' | 'fp32';
  dimensions: number; maxTokens: number; pooling: 'mean' | 'cls';
  normalize: true; queryPrefix: string; passagePrefix: string;
}
export const DEFAULT_PROFILE: EmbeddingProfile = {
  repo: 'Xenova/multilingual-e5-small', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
  dtype: 'q8', dimensions: 384, maxTokens: 512, pooling: 'mean', normalize: true,
  queryPrefix: 'query: ', passagePrefix: 'passage: ',
};
export const LIMITS = { fileBytes: 2 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, documents: 100, chunks: 2000 };
export interface LocalDocument { id: string; name: string; text: string; bytes: number }
export interface Chunk { documentId: string; start: number; end: number; text: string; vector: number[] }
export interface LocalIndex {
  version: 1; revision: string; fingerprint: string; profile: EmbeddingProfile;
  documents: LocalDocument[]; chunks: Chunk[]; updatedAt: string;
}
export interface SearchHit extends Chunk { name: string; score: number }
export function validateProfile(input: EmbeddingProfile): EmbeddingProfile {
  if (!input || !/^[\w-]+\/[\w.-]+$/.test(input.repo) || !/^[a-f0-9]{40}$/.test(input.revision)
    || !/^[a-f0-9]{64}$/.test(input.sha256) || !['q8', 'fp32'].includes(input.dtype)
    || !Number.isInteger(input.dimensions) || input.dimensions < 1 || input.dimensions > 2048
    || !Number.isInteger(input.maxTokens) || input.maxTokens < 16 || input.maxTokens > 512
    || !['mean', 'cls'].includes(input.pooling) || input.normalize !== true
    || typeof input.queryPrefix !== 'string' || typeof input.passagePrefix !== 'string'
    || input.queryPrefix.length > 128 || input.passagePrefix.length > 128) {
    throw new Error('模型配置无效：需要仓库、40 位固定版本、64 位权重 SHA-256，以及有效的维度、前缀和 pooling。');
  }
  return { repo: input.repo, revision: input.revision, sha256: input.sha256, dtype: input.dtype,
    dimensions: input.dimensions, maxTokens: input.maxTokens, pooling: input.pooling,
    normalize: true, queryPrefix: input.queryPrefix, passagePrefix: input.passagePrefix };
}
export function fingerprint(profile: EmbeddingProfile): string {
  return JSON.stringify({ runtime: 'transformers-3.8.1-wasm', chunker: 'unicode-contiguous-v1', ...validateProfile(profile) });
}
export function validateVector(vector: number[], dimensions: number): number[] {
  if (vector.length !== dimensions || vector.some(v => !Number.isFinite(v))) throw new Error('模型输出维度或数值不兼容。');
  const norm = Math.sqrt(vector.reduce((n, v) => n + v * v, 0));
  if (norm < 1e-8) throw new Error('模型输出了空向量。');
  return vector.map(v => v / norm);
}
// Count the actual prefixed input, including special tokens. Preserve exact UTF-16 source offsets.
// Bounds are conservative; no tokenizer truncation or lossy decode/re-encode is used.
export function splitText(text: string, profile: EmbeddingProfile, count: (text: string) => number) {
  const result: { start: number; end: number; text: string }[] = [];
  let offset = 0;
  while (offset < text.length) {
    let candidate = Array.from(text.slice(offset, offset + 4096)).slice(0, 1024);
    // slice may end inside a surrogate pair; a terminal high surrogate belongs to the next chunk.
    if (/^[\uD800-\uDBFF]$/.test(candidate[candidate.length - 1])) candidate = candidate.slice(0, -1);
    let size = candidate.length;
    while (size > 0 && count(profile.passagePrefix + candidate.slice(0, size).join('')) > profile.maxTokens) size = Math.floor(size / 2);
    if (!size) throw new Error('单个字符加模型前缀已超出 token 上限，请检查配置。');
    const part = candidate.slice(0, size).join('');
    result.push({ start: offset, end: offset + part.length, text: part });
    offset += part.length;
    if (result.length > LIMITS.chunks) throw new Error('文档片段太多，首版最多支持 2000 个片段。');
  }
  return result;
}
export function rank(index: LocalIndex, profile: EmbeddingProfile, vector: number[]): SearchHit[] {
  if (index.fingerprint !== fingerprint(profile)) throw new Error('模型与索引不匹配，请重建本地索引。');
  const query = validateVector(vector, profile.dimensions);
  return index.chunks.map(chunk => {
    const values = validateVector(chunk.vector, profile.dimensions);
    return { ...chunk, name: index.documents.find(d => d.id === chunk.documentId)?.name ?? '未知文件',
      score: values.reduce((sum, v, i) => sum + v * query[i], 0) };
  }).sort((a, b) => b.score - a.score).slice(0, 5);
}
export async function readDocument(file: File): Promise<LocalDocument> {
  if (!/\.(md|markdown|txt)$/i.test(file.name) || file.size > LIMITS.fileBytes || file.size === 0) throw new Error('仅支持非空 UTF-8 Markdown/TXT 文件，每个不超过 2 MiB。');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  if (!text.trim() || text.includes('\0')) throw new Error('文件为空或不是有效文本。');
  return { id: crypto.randomUUID(), name: file.name, text, bytes: file.size };
}
