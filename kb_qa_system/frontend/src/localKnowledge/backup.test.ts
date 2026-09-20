import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportBackup, importBackup, MAX_BACKUP_BYTES, validateBackupIndex } from './backup';
import { DEFAULT_PROFILE, fingerprint, type LocalIndex } from './core';
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, 'Blob', { configurable: true, value: NodeBlob });
});
const profile = { ...DEFAULT_PROFILE, dimensions: 2 };
const sample = (): LocalIndex => ({ version: 1, revision: 'original', profile, fingerprint: fingerprint(profile), updatedAt: '',
  documents: [{ id: 'd1', name: '制度.md', text: '中文保密内容', bytes: 18 }],
  chunks: [{ documentId: 'd1', start: 0, end: 6, text: '中文保密内容', vector: [0.6, 0.8] }] });
describe('encrypted portable local backups', () => {
  it('round trips text, profile and vectors with fresh revision, no plaintext metadata', async () => {
    const blob = await exportBackup(sample(), 'test-password');
    const text = await blob.text();
    expect(text).not.toContain('中文保密内容'); expect(text).not.toContain('制度.md'); expect(text).not.toContain('Xenova');
    const restored = await importBackup(blob, 'test-password');
    expect(restored.documents).toEqual(sample().documents); expect(restored.chunks).toEqual(sample().chunks);
    expect(restored.profile).toEqual(profile); expect(restored.revision).not.toBe('original');
  });
  it('uses new salt/IV for every export and rejects wrong passwords or altered ciphertext', async () => {
    const first = await exportBackup(sample(), '1234'); const second = await exportBackup(sample(), '1234');
    expect(await first.text()).not.toBe(await second.text());
    await expect(importBackup(first, 'wrong')).rejects.toThrow('口令不正确');
    const data = JSON.parse(await first.text());
    data.ciphertext = (data.ciphertext[0] === 'A' ? 'B' : 'A') + data.ciphertext.slice(1);
    await expect(importBackup(new Blob([JSON.stringify(data)]), '1234')).rejects.toThrow('损坏');
  });
  it('refuses uncontrolled KDF cost, malformed envelopes and over-limit files before crypto', async () => {
    const blob = await exportBackup(sample(), '1234'); const data = JSON.parse(await blob.text());
    data.iterations = 999999999;
    await expect(importBackup(new Blob([JSON.stringify(data)]), '1234')).rejects.toThrow('无效');
    await expect(importBackup(new Blob(['not-json']), '1234')).rejects.toThrow('无效');
    await expect(importBackup({ size: MAX_BACKUP_BYTES + 1 } as Blob, '1234')).rejects.toThrow('180 MiB');
    await expect(exportBackup(sample(), '12')).rejects.toThrow('4–256');
  });
  it.each(['dimension', 'nan', 'zero', 'offset', 'text', 'missing', 'duplicate', 'fingerprint', 'path', 'version'])('rejects incompatible %s data', kind => {
    const index = sample();
    switch (kind) {
      case 'dimension': index.chunks[0].vector = [1]; break;
      case 'nan': index.chunks[0].vector = [NaN, 1]; break;
      case 'zero': index.chunks[0].vector = [0, 0]; break;
      case 'offset': index.chunks[0].start = 1; break;
      case 'text': index.chunks[0].text = 'tamper'; break;
      case 'missing': index.chunks = []; break;
      case 'duplicate': index.documents.push(index.documents[0]); break;
      case 'fingerprint': index.profile = { ...profile, pooling: 'cls' }; break;
      case 'path': index.documents[0].name = '../../data.md'; break;
      case 'version': Object.assign(index, { version: 2 }); break;
    }
    expect(() => validateBackupIndex(index)).toThrow();
  });
  it('whitelists fields and recomputes sizes instead of importing unrelated secrets', () => {
    const index = sample(); Object.assign(index, { apiKey: 'not-exportable' }); index.documents[0].bytes = 0;
    const clean = validateBackupIndex(index);
    expect(clean).not.toHaveProperty('apiKey'); expect(clean.documents[0].bytes).toBe(18);
  });
});
