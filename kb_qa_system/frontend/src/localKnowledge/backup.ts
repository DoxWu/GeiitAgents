import { fingerprint, LIMITS, validateProfile, type LocalIndex, type LocalDocument, type Chunk } from './core';

const FORMAT = 'geiit-local-knowledge-encrypted';
const ITERATIONS = 600000;
export const MAX_BACKUP_BYTES = 180 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;
const encoder = new TextEncoder();
function fail(): never { throw new Error('备份内容无效或版本不兼容，原知识库未更改。'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) return fail();
  return value;
}
// Never trust vectors, offsets, source identities or model declarations from an imported file.
// Reconstruct a whitelist-only object so unrelated secrets or arbitrary properties cannot persist.
export function validateBackupIndex(value: unknown): LocalIndex {
  const source = record(value);
  if (source.version !== 1) return fail();
  const profile = validateProfile(record(source.profile) as unknown as LocalIndex['profile']);
  if (source.fingerprint !== fingerprint(profile)) return fail();
  if (!Array.isArray(source.documents) || source.documents.length > LIMITS.documents
    || !Array.isArray(source.chunks) || source.chunks.length > LIMITS.chunks) return fail();
  const ids = new Set<string>();
  let total = 0;
  const documents: LocalDocument[] = source.documents.map(raw => {
    const doc = record(raw);
    const id = boundedText(doc.id, 100), name = boundedText(doc.name, 255);
    const text = boundedText(doc.text, LIMITS.fileBytes);
    const bytes = encoder.encode(text).byteLength;
    if (ids.has(id) || !/\.(md|markdown|txt)$/i.test(name) || /[\\/]/.test(name) || Array.from(name).some(c => c.charCodeAt(0) < 32)
      || !text.trim() || bytes > LIMITS.fileBytes) return fail();
    ids.add(id); total += bytes;
    return { id, name, text, bytes };
  });
  if (total > LIMITS.totalBytes) return fail();
  const byId = new Map(documents.map(doc => [doc.id, doc]));
  const ends = new Map<string, number>();
  const chunks: Chunk[] = source.chunks.map(raw => {
    const chunk = record(raw);
    const documentId = boundedText(chunk.documentId, 100);
    const doc = byId.get(documentId);
    const { start, end, vector } = chunk;
    if (!doc || typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)
      || start !== (ends.get(documentId) ?? 0) || end <= start || end > doc.text.length
      || chunk.text !== doc.text.slice(start, end) || !Array.isArray(vector) || vector.length !== profile.dimensions
      || vector.some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1.001)) return fail();
    const norm = vector.reduce((sum, v) => sum + v * v, 0);
    if (Math.abs(norm - 1) > 0.01) return fail();
    ends.set(documentId, end);
    return { documentId, start, end, text: doc.text.slice(start, end), vector: [...vector] };
  });
  if (documents.some(doc => ends.get(doc.id) !== doc.text.length)) return fail();
  return { version: 1, revision: crypto.randomUUID(), profile, fingerprint: fingerprint(profile), documents, chunks, updatedAt: new Date().toISOString() };
}
function base64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 0x8000) result += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(result);
}
function decode64(value: unknown, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return fail();
  try { const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0)); if (bytes.length > max) return fail(); return bytes; }
  catch { return fail(); }
}
async function derive(password: string, salt: Uint8Array<ArrayBuffer>) {
  if (password.length < 4 || password.length > 256) throw new Error('备份口令需要 4–256 个字符，建议使用较长口令。');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function exportBackup(index: LocalIndex, password: string): Promise<Blob> {
  const clean = validateBackupIndex(index);
  const payload = encoder.encode(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), index: clean }));
  if (payload.byteLength > MAX_PAYLOAD_BYTES) throw new Error('备份超过 128 MiB，请减少本地库文档。');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(FORMAT + ':1') }, key, payload);
  return new Blob([JSON.stringify({ format: FORMAT, version: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS,
    cipher: 'AES-256-GCM', salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(encrypted)) })], { type: 'application/json' });
}
export async function importBackup(file: Blob, password: string): Promise<LocalIndex> {
  if (!file.size || file.size > MAX_BACKUP_BYTES) throw new Error('备份文件为空或超过 180 MiB 限制。');
  let envelope: Record<string, unknown>;
  try { envelope = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()))); }
  catch { return fail(); }
  if (envelope.format !== FORMAT || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256'
    || envelope.iterations !== ITERATIONS || envelope.cipher !== 'AES-256-GCM') return fail();
  const salt = decode64(envelope.salt, 16), iv = decode64(envelope.iv, 12);
  const ciphertext = decode64(envelope.ciphertext, MAX_PAYLOAD_BYTES + 16);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17) return fail();
  const key = await derive(password, salt);
  let plain: ArrayBuffer;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(FORMAT + ':1') }, key, ciphertext); }
  catch { throw new Error('备份口令不正确或文件已损坏，原知识库未更改。'); }
  try {
    const payload = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
    if (payload.version !== 1 || typeof payload.exportedAt !== 'string' || !Number.isFinite(Date.parse(payload.exportedAt))) return fail();
    return validateBackupIndex(payload.index);
  } catch { return fail(); }
}
