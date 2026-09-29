import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { TextDecoder, TextEncoder } from 'node:util';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, VAULT_STORAGE_KEY } from '../workbenchStore';
import * as backup from '@/services/vaultBackup';
import { PrivateVault } from '@/services/privateVault';
import { vaultBackupFixture } from '@/test/vaultBackupFixture';
import { personalDraft } from '@/personal/itemDraft';
import { MemoryDirectory } from '@/fileOrganizer/testDirectory';
import { snapshotText } from '@/fileOrganizer/textEdit';

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder); vi.stubGlobal('TextDecoder', TextDecoder); vi.stubGlobal('Blob', NodeBlob);
  await store.getState().lock(); localStorage.clear();
});
afterEach(async () => { vi.restoreAllMocks(); await store.getState().lock(); vi.unstubAllGlobals(); });
async function fixture() { return (await backup.exportVaultBackup(await vaultBackupFixture(), '1234', true)).file; }

it('exports current debounced drafts even when persistence is out of quota', async () => {
  await store.getState().unlock('old-pass');
  const draft = personalDraft(undefined, 'note'); draft.input.content = 'latest unsaved edit';
  store.getState().stagePersonalDraft(draft);
  const saved = localStorage.getItem(VAULT_STORAGE_KEY);
  const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  const result = await store.getState().exportWorkbenchBackup('1234', false);
  const data = (await backup.importVaultBackup(result.file, '1234')).data;
  expect(data.personalDrafts?.[0].input.content).toBe('latest unsaved edit');
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBe(saved);
  write.mockRestore();
});

it('requires locked preview and confirmation, restores under new password without replay', async () => {
  const file = await fixture(); await store.getState().unlock('old-pass');
  await expect(store.getState().prepareWorkbenchRestore(file, '1234', 'new-pass')).rejects.toThrow('锁定');
  await store.getState().lock(); const old = localStorage.getItem(VAULT_STORAGE_KEY);
  const network = vi.spyOn(globalThis, 'fetch');
  await store.getState().prepareWorkbenchRestore(file, '1234', 'new-pass');
  const preview = store.getState().vaultRestorePreview!;
  expect(preview.replacing).toBe(true); expect(preview.summary.artifacts).toBe(2);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBe(old);
  expect(JSON.stringify(store.getState())).not.toContain('synthetic-backup-key');
  await expect(store.getState().commitWorkbenchRestore('wrong-id')).rejects.toThrow();
  await store.getState().commitWorkbenchRestore(preview.id);
  expect(store.getState().unlocked).toBe(false); expect(store.getState().vaultRestorePreview).toBeNull();
  await expect(store.getState().unlock('old-pass')).rejects.toThrow();
  await store.getState().unlock('new-pass');
  expect(store.getState().profiles[0].hasKey).toBe(true);
  expect(store.getState().fileEditVersions[0].before.text).toBe('\uFEFF# 原文\r\n');
  expect(store.getState().personalDrafts).toHaveLength(2); expect(network).not.toHaveBeenCalled();
});

it('creates a vault on a new device and marks unfinished tasks interrupted only on explicit unlock', async () => {
  const source = await vaultBackupFixture(); source.taskRuns![0].status = 'running'; source.fileEditVersions![0].status = 'running';
  const { file } = await backup.exportVaultBackup(source, '1234');
  await store.getState().prepareWorkbenchRestore(file, '1234', '5678');
  expect(store.getState().vaultRestorePreview?.replacing).toBe(false); expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBeNull();
  await store.getState().commitWorkbenchRestore(store.getState().vaultRestorePreview!.id);
  expect(store.getState().taskRuns).toEqual([]);
  await store.getState().unlock('5678');
  expect(store.getState().taskRuns[0].status).toBe('interrupted'); expect(store.getState().fileEditVersions[0].status).toBe('interrupted');
  expect(store.getState().profiles[0].hasKey).toBe(false);
});

it('refuses to replace a newer ciphertext written by another window after preview', async () => {
  const file = await fixture(); await store.getState().prepareWorkbenchRestore(file, '1234', '5678');
  const id = store.getState().vaultRestorePreview!.id;
  const other = new PrivateVault(localStorage, VAULT_STORAGE_KEY); await other.unlock('other-password');
  const newer = localStorage.getItem(VAULT_STORAGE_KEY);
  await expect(store.getState().commitWorkbenchRestore(id)).rejects.toThrow('未覆盖新数据');
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBe(newer);
});

it('preserves the old vault and preview after quota failure and allows explicit retry', async () => {
  const file = await fixture(); await store.getState().unlock('old-pass'); await store.getState().lock();
  const old = localStorage.getItem(VAULT_STORAGE_KEY);
  await store.getState().prepareWorkbenchRestore(file, '1234', '5678'); const id = store.getState().vaultRestorePreview!.id;
  const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await expect(store.getState().commitWorkbenchRestore(id)).rejects.toThrow('原密钥库未更改');
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBe(old); expect(store.getState().vaultRestorePreview?.id).toBe(id); expect(store.getState().vaultTransferBusy).toBe(false);
  write.mockRestore(); await store.getState().commitWorkbenchRestore(id); await store.getState().unlock('5678');
  expect(store.getState().personalItems).toHaveLength(1);
});

it('invalidates cancelled previews and a late decryption cannot repopulate the preview', async () => {
  const file = await fixture();
  await store.getState().prepareWorkbenchRestore(file, '1234', '5678'); const id = store.getState().vaultRestorePreview!.id;
  store.getState().cancelVaultTransfer(); await expect(store.getState().commitWorkbenchRestore(id)).rejects.toThrow();
  let resolve!: (value: Awaited<ReturnType<typeof backup.prepareVaultReplacement>>) => void;
  const real = await backup.prepareVaultReplacement(file, '1234', '5678');
  vi.spyOn(backup, 'prepareVaultReplacement').mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = store.getState().prepareWorkbenchRestore(file, '1234', '5678');
  await vi.waitFor(() => expect(resolve).toBeDefined());
  await expect(store.getState().unlock('wrong')).rejects.toThrow('处理中');
  store.getState().cancelVaultTransfer(); resolve(real);
  await expect(pending).rejects.toThrow('取消');
  expect(store.getState().vaultRestorePreview).toBeNull(); expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBeNull();
});

it('cancels export results after lock and freezes the click-time snapshot', async () => {
  await store.getState().unlock('old-pass'); const id = store.getState().newConversation(); store.getState().rename(id, 'before');
  let resolve!: (value: Awaited<ReturnType<typeof backup.exportVaultBackup>>) => void;
  const result = await backup.exportVaultBackup({ profiles: [], conversations: [] }, '1234');
  const exporting = vi.spyOn(backup, 'exportVaultBackup').mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = store.getState().exportWorkbenchBackup('1234', false);
  store.getState().rename(id, 'after');
  await vi.waitFor(() => expect(resolve).toBeDefined());
  expect(exporting.mock.calls[0][0].conversations[0].title).toBe('before');
  await store.getState().lock(); resolve(result);
  await expect(pending).rejects.toThrow('取消'); expect(store.getState().vaultTransferBusy).toBe(false);
});

it('rechecks cancellation inside the shared write lock before touching storage', async () => {
  const file = await fixture(); await store.getState().prepareWorkbenchRestore(file, '1234', '5678');
  let enter!: () => void;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn((_name, action) => new Promise((resolve, reject) => { enter = () => { try { resolve(action()); } catch (error) { reject(error); } }; })) } });
  try {
    const pending = store.getState().commitWorkbenchRestore(store.getState().vaultRestorePreview!.id);
    store.getState().cancelVaultTransfer();
    enter(); await expect(pending).rejects.toThrow('取消');
    expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBeNull();
  } finally { Reflect.deleteProperty(navigator, 'locks'); }
});

it('blocks restore until a file operation from the locked session actually finishes', async () => {
  const file = await fixture(); await store.getState().unlock('old-pass');
  const directory = new MemoryDirectory({ 'a.md': 'original' });
  let finish!: () => void;
  const handle = await directory.getFileHandle('a.md'), snapshot = await snapshotText('original');
  handle.readText = () => new Promise(resolve => { finish = () => resolve(snapshot); });
  vi.spyOn(directory, 'getFileHandle').mockResolvedValue(handle);
  const reading = store.getState().openFileEdit(directory, 'a.md', true);
  await vi.waitFor(() => expect(finish).toBeDefined());
  await expect(store.getState().exportWorkbenchBackup('1234', false)).rejects.toThrow('正在运行');
  await store.getState().lock();
  await expect(store.getState().prepareWorkbenchRestore(file, '1234', '5678')).rejects.toThrow('文件操作结束');
  finish(); await expect(reading).rejects.toThrow('锁定');
  await store.getState().prepareWorkbenchRestore(file, '1234', '5678');
  expect(store.getState().vaultRestorePreview).not.toBeNull();
});
