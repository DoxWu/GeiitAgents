import type { VaultData } from '@/types/workbench';
import { PrivateVault } from './privateVault';
import { validateVaultBackup } from './vaultBackupSchema';

export const MAX_VAULT_BACKUP_BYTES = 24 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const FORMAT = 'geiit-workbench-backup';
const ITERATIONS = 600000;
const encoder = new TextEncoder(), aad = encoder.encode(FORMAT + ':1');
export interface VaultBackupSummary {
  exportedAt: string;
  workflows: number;
  profiles: number; apiKeys: number; conversations: number; messages: number; tasks: number; artifacts: number;
  personalItems: number; personalDrafts: number; reminderDrafts: number; reminderTemplates: number; organizerRuns: number; fileEditVersions: number; fileEditDrafts: number;
}
export function summarizeVault(data: VaultData, exportedAt: string): VaultBackupSummary {
  return { exportedAt, workflows: data.workflows?.length ?? 0, profiles: data.profiles.length, apiKeys: data.profiles.filter(p => p.apiKey).length, conversations: data.conversations.length, messages: data.conversations.reduce((n, c) => n + c.messages.length, 0),
    tasks: data.taskRuns?.length ?? 0, artifacts: data.artifacts?.length ?? 0, personalItems: data.personalItems?.length ?? 0, personalDrafts: data.personalDrafts?.length ?? 0,
    reminderDrafts: data.reminderDrafts?.length ?? 0, reminderTemplates: data.reminderTemplates?.length ?? 0, organizerRuns: data.organizerRuns?.length ?? 0, fileEditVersions: data.fileEditVersions?.length ?? 0, fileEditDrafts: data.fileEditDraft ? 1 : 0 };
}
function fail(): never { throw new Error('备份格式无效或版本不兼容，当前工作台未更改。'); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value as Record<string, unknown>; }
function encode64(bytes: Uint8Array) {
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text);
}
function decode64(value: unknown, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) fail();
  try { const bytes = Uint8Array.from(atob(value as string), c => c.charCodeAt(0)); if (bytes.length > max) fail(); return bytes; } catch { return fail(); }
}
function passwordCheck(password: string) { if (password.length < 4 || password.length > 256) throw new Error('口令需要 4–256 个字符。'); }
async function derive(password: string, salt: Uint8Array<ArrayBuffer>) {
  passwordCheck(password);
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function exportVaultBackup(source: VaultData, password: string, includeKeys = false): Promise<{ file: Blob; summary: VaultBackupSummary }> {
  passwordCheck(password);
  // JSON snapshot precedes awaits: later UI edits cannot mutate this export.
  const serialized = JSON.stringify(source);
  if (serialized.length > MAX_PAYLOAD_BYTES) throw new Error('工作台数据超过 16 MiB 备份上限。');
  const data = JSON.parse(serialized) as VaultData;
  if (!includeKeys) data.profiles = data.profiles.map(p => ({ ...p, apiKey: '' }));
  await validateVaultBackup(data);
  const exportedAt = new Date().toISOString(), payload = encoder.encode(JSON.stringify({ version: 1, exportedAt, data }));
  if (payload.byteLength > MAX_PAYLOAD_BYTES) throw new Error('工作台数据超过 16 MiB 备份上限。');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await derive(password, salt), payload);
  return { file: new Blob([JSON.stringify({ format: FORMAT, version: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, cipher: 'AES-256-GCM', salt: encode64(salt), iv: encode64(iv), ciphertext: encode64(new Uint8Array(encrypted)) })], { type: 'application/json' }), summary: summarizeVault(data, exportedAt) };
}
export async function importVaultBackup(file: Blob, password: string): Promise<{ data: VaultData; summary: VaultBackupSummary }> {
  passwordCheck(password);
  if (!file.size || file.size > MAX_VAULT_BACKUP_BYTES) throw new Error('备份文件为空或超过 24 MiB。');
  let envelope: Record<string, unknown>;
  try { const bytes = await file.arrayBuffer(); if (bytes.byteLength > MAX_VAULT_BACKUP_BYTES) fail(); envelope = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { return fail(); }
  const fields = ['format', 'version', 'kdf', 'iterations', 'cipher', 'salt', 'iv', 'ciphertext'];
  if (Object.keys(envelope).some(key => !fields.includes(key)) || envelope.format !== FORMAT || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== ITERATIONS || envelope.cipher !== 'AES-256-GCM') return fail();
  const salt = decode64(envelope.salt, 16), iv = decode64(envelope.iv, 12), ciphertext = decode64(envelope.ciphertext, MAX_PAYLOAD_BYTES + 16);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17) return fail();
  const key = await derive(password, salt); let plain: ArrayBuffer;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext); }
  catch { throw new Error('备份口令不正确或文件已损坏，当前工作台未更改。'); }
  let payload: Record<string, unknown>;
  try { payload = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))); } catch { return fail(); }
  if (Object.keys(payload).some(key => !['version', 'exportedAt', 'data'].includes(key)) || payload.version !== 1 || typeof payload.exportedAt !== 'string' || !Number.isFinite(Date.parse(payload.exportedAt))) return fail();
  const data = await validateVaultBackup(payload.data);
  return { data, summary: summarizeVault(data, payload.exportedAt) };
}
/** Prepare the replacement entirely off to the side, using a new local key.
 * No user storage is changed and no plaintext is returned to the UI preview. */
export async function prepareVaultReplacement(file: Blob, backupPassword: string, localPassword: string) {
  passwordCheck(localPassword);
  const { data, summary } = await importVaultBackup(file, backupPassword);
  const memory = new Map<string, string>();
  const storage: Storage = { get length() { return memory.size; }, clear: () => memory.clear(), key: i => [...memory.keys()][i] ?? null, getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); }, removeItem: k => { memory.delete(k); } };
  const candidate = new PrivateVault(storage, 'replacement');
  try { await candidate.unlock(localPassword); await candidate.save(data); return { serialized: storage.getItem('replacement')!, summary }; }
  finally { candidate.lock(); storage.clear(); }
}
