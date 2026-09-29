import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { TextDecoder, TextEncoder } from 'node:util';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { exportVaultBackup, importVaultBackup, prepareVaultReplacement, MAX_VAULT_BACKUP_BYTES } from '../vaultBackup';
import { validateVaultBackup } from '../vaultBackupSchema';
import { PrivateVault } from '../privateVault';
import { vaultBackupFixture } from '@/test/vaultBackupFixture';
import { sha256Text } from '@/officeTasks/document';
import type { VaultData } from '@/types/workbench';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder); vi.stubGlobal('TextDecoder', TextDecoder); vi.stubGlobal('Blob', NodeBlob);
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

it('roundtrips every vault collection and omits keys by default without mutating the source', async () => {
  const source = await vaultBackupFixture();
  const { file, summary } = await exportVaultBackup(source, '1234');
  expect(summary).toMatchObject({ profiles: 1, apiKeys: 0, messages: 1, artifacts: 2, personalDrafts: 2, fileEditDrafts: 1 });
  const text = await file.text();
  for (const secret of ['synthetic-backup-key', '工作报告', 'exportedAt', 'personalItems']) expect(text).not.toContain(secret);
  const imported = await importVaultBackup(file, '1234');
  const expected = structuredClone(source); expected.profiles[0].apiKey = '';
  expect(imported.data).toEqual(expected); expect(imported.summary).toEqual(summary);
  expect(source.profiles[0].apiKey).toBe('synthetic-backup-key');
  expect(imported.data.profiles[0]).not.toHaveProperty('maxTokens');
});

it('includes keys only by opt-in and uses independent salt/nonces for each export', async () => {
  const source = await vaultBackupFixture();
  const a = await exportVaultBackup(source, '1234', true), b = await exportVaultBackup(source, '1234', true);
  expect((await importVaultBackup(a.file, '1234')).data).toEqual(source);
  const first = JSON.parse(await a.file.text()), second = JSON.parse(await b.file.text());
  expect(first.salt).not.toBe(second.salt); expect(first.iv).not.toBe(second.iv); expect(first.ciphertext).not.toBe(second.ciphertext);
});

it('freezes the snapshot before any crypto await', async () => {
  const source = await vaultBackupFixture(), expected = structuredClone(source);
  const exporting = exportVaultBackup(source, '1234', true);
  source.conversations[0].title = 'changed'; source.profiles[0].apiKey = 'changed'; source.personalItems!.length = 0;
  expect((await importVaultBackup((await exporting).file, '1234')).data).toEqual(expected);
});

it('prepares isolated ciphertext under the new password without changing user storage', async () => {
  const source = await vaultBackupFixture(), backup = await exportVaultBackup(source, '1234', true);
  localStorage.setItem('vault', 'original'); localStorage.setItem('unrelated', 'untouched');
  const candidate = await prepareVaultReplacement(backup.file, '1234', '5678');
  expect(localStorage.getItem('vault')).toBe('original'); expect(localStorage.getItem('unrelated')).toBe('untouched');
  expect(JSON.stringify(candidate)).not.toContain('synthetic-backup-key');
  localStorage.setItem('restored', candidate.serialized);
  await expect(new PrivateVault(localStorage, 'restored').unlock('1234')).rejects.toThrow();
  expect(await new PrivateVault(localStorage, 'restored').unlock('5678')).toEqual(source);
});

it('rejects wrong passwords, tampering, unrecognized envelopes and oversized files', async () => {
  const { file } = await exportVaultBackup({ profiles: [], conversations: [] }, '1234');
  await expect(importVaultBackup(file, '4321')).rejects.toThrow('口令不正确或文件已损坏');
  const original = JSON.parse(await file.text());
  const tampered = { ...original, ciphertext: (original.ciphertext[0] === 'A' ? 'B' : 'A') + original.ciphertext.slice(1) };
  await expect(importVaultBackup(new Blob([JSON.stringify(tampered)]), '1234')).rejects.toThrow('口令不正确或文件已损坏');
  for (const patch of [{ version: 2 }, { iterations: 1 }, { extra: true }, { salt: '!!!!' }, { iv: 'AAAA' }, { ciphertext: '' }]) {
    await expect(importVaultBackup(new Blob([JSON.stringify({ ...original, ...patch })]), '1234')).rejects.toThrow('格式无效');
  }
  const arrayBuffer = vi.fn();
  await expect(importVaultBackup({ size: MAX_VAULT_BACKUP_BYTES + 1, arrayBuffer } as unknown as Blob, '1234')).rejects.toThrow('24 MiB');
  expect(arrayBuffer).not.toHaveBeenCalled();
  await expect(importVaultBackup(new Blob(), '1234')).rejects.toThrow();
  await expect(importVaultBackup(new Blob([new Uint8Array([0xff])]), '1234')).rejects.toThrow();
  await expect(exportVaultBackup({ profiles: [], conversations: [] }, '123')).rejects.toThrow('口令');
});

it.each([
  ['unknown nested field', (d: VaultData) => Object.assign(d.profiles[0], { refreshToken: 'do-not-echo' })],
  ['duplicate IDs', (d: VaultData) => d.conversations.push(structuredClone(d.conversations[0]))],
  ['missing task member', (d: VaultData) => d.taskRuns![0].artifactIds.pop()],
  ['missing tool artifact', (d: VaultData) => { d.toolRuns![0].sourceArtifactId = 'absent'; }],
  ['bad digest', (d: VaultData) => { d.artifacts![0].content += 'changed'; }],
  ['future parent version', (d: VaultData) => { d.artifacts![1].parentArtifactId = d.artifacts![0].id; }],
  ['unsafe filename', (d: VaultData) => { d.organizerRuns![0].changes[0].source = '../outside.md'; }],
  ['modified text snapshot', (d: VaultData) => { d.fileEditVersions![0].before.text = 'changed'; }],
  ['invalid todo state', (d: VaultData) => { Object.assign(d.personalItems![0], { status: 'other' }); }],
] as const)('rejects %s without echoing imported content', async (_name, change) => {
  const source = await vaultBackupFixture(); change(source);
  await expect(validateVaultBackup(source)).rejects.toThrow('备份内容无效、超限或版本不兼容，当前工作台未更改。');
});

it.each(['<script>alert(1)</script>', '<image href="https://example.test/image"/>', '<rect onload="alert(1)"/>', '<rect fill="url(https://example.test/a)"/>', '<foreignObject/>'])('rejects active SVG even with a valid digest: %s', async body => {
  const source = await vaultBackupFixture(), artifact = source.artifacts![0];
  artifact.content = `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`; artifact.sha256 = await sha256Text(artifact.content);
  await expect(validateVaultBackup(source)).rejects.toThrow();
});

it('accepts older minimal vaults and rejects unknown newer fields without dropping them', async () => {
  await expect(validateVaultBackup({ profiles: [], conversations: [] })).resolves.toEqual({ profiles: [], conversations: [] });
  await expect(validateVaultBackup({ profiles: [], conversations: [], newFeature: [] })).rejects.toThrow();
});

it('rejects authenticated but invalid payloads before preparing any replacement', async () => {
  const source = await vaultBackupFixture(); Object.assign(source.profiles[0], { unknown: 'private-import-fixture' });
  const encoder = new TextEncoder(), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', encoder.encode('1234'), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('geiit-workbench-backup:1') }, key, encoder.encode(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data: source })));
  const file = new Blob([JSON.stringify({ format: 'geiit-workbench-backup', version: 1, kdf: 'PBKDF2-SHA256', iterations: 600000, cipher: 'AES-256-GCM', salt: Buffer.from(salt).toString('base64'), iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') })]);
  localStorage.setItem('original', 'unchanged');
  await expect(prepareVaultReplacement(file, '1234', '5678')).rejects.toThrow('备份内容无效');
  expect(localStorage.getItem('original')).toBe('unchanged');
});
