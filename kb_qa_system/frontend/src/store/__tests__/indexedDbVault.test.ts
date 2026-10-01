import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { TextDecoder, TextEncoder } from 'node:util';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, VAULT_STORAGE_KEY } from '../workbenchStore';
import { createVaultStorage, IndexedDbVaultStorage, VAULT_CHANGE_CHANNEL, VAULT_WINDOW_ID } from '@/services/privateVaultStorage';
import { PrivateVault } from '@/services/privateVault';
import { exportVaultBackup } from '@/services/vaultBackup';

const password = 'idb-store-fixture';
beforeEach(async () => {
  await store.getState().lock(); localStorage.clear();
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('TextEncoder', TextEncoder); vi.stubGlobal('TextDecoder', TextDecoder);
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(async () => { vi.restoreAllMocks(); await store.getState().lock(); vi.unstubAllGlobals(); });

it('creates and recovers encrypted records after locking with only a localStorage marker', async () => {
  await store.getState().unlock(password);
  const item = await store.getState().savePersonalItem(crypto.randomUUID(), { kind: 'note', title: 'private note', content: 'private body', tags: [] }, 0);
  expect(store.getState().unlocked).toBe(true);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).toMatch(/^geiit-indexeddb-v1:/);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().personalItems).toEqual([item]);
});

it('retains committed IndexedDB data when the localStorage marker cannot be written', async () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await store.getState().unlock(password);
  await store.getState().savePersonalItem(crypto.randomUUID(), { kind: 'note', title: 'committed', content: '', tags: [] }, 0);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().personalItems[0].title).toBe('committed');
});

it('restores a backup through IndexedDB and rejects an intervening newer window write', async () => {
  const { file } = await exportVaultBackup({ profiles: [], conversations: [], personalItems: [] }, 'backup-pass');
  await store.getState().prepareWorkbenchRestore(file, 'backup-pass', password);
  await store.getState().commitWorkbenchRestore(store.getState().vaultRestorePreview!.id);
  await store.getState().unlock(password); await store.getState().lock();
  await store.getState().prepareWorkbenchRestore(file, 'backup-pass', password);
  const id = store.getState().vaultRestorePreview!.id;
  const other = new PrivateVault(createVaultStorage(), VAULT_STORAGE_KEY);
  await other.unlock(password); await other.save({ profiles: [], conversations: [], personalDrafts: [] }); other.lock();
  await expect(store.getState().commitWorkbenchRestore(id)).rejects.toThrow('未覆盖新数据');
});

it('ignores its own notification and locks on another window notification', async () => {
  await store.getState().unlock(password);
  const channel = new BroadcastChannel(VAULT_CHANGE_CHANNEL);
  try {
    channel.postMessage({ key: VAULT_STORAGE_KEY, source: VAULT_WINDOW_ID });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(store.getState().unlocked).toBe(true);
    channel.postMessage({ key: VAULT_STORAGE_KEY, source: 'other-window' });
    await vi.waitFor(() => expect(store.getState().unlocked).toBe(false));
  } finally { channel.close(); }
});

it('reserves restore preparation before an asynchronous read and discards cancellation', async () => {
  const { file } = await exportVaultBackup({ profiles: [], conversations: [] }, 'backup-pass');
  let completeRead!: (value: string | null) => void;
  vi.spyOn(IndexedDbVaultStorage.prototype, 'getItem').mockImplementationOnce(() => new Promise(resolve => { completeRead = resolve; }));
  const preparation = store.getState().prepareWorkbenchRestore(file, 'backup-pass', password);
  expect(store.getState().vaultTransferBusy).toBe(true);
  await expect(store.getState().prepareWorkbenchRestore(file, 'backup-pass', password)).rejects.toThrow('等待文件操作结束');
  store.getState().cancelVaultTransfer(); completeRead(null);
  await expect(preparation).rejects.toThrow('已取消');
  expect(store.getState().vaultRestorePreview).toBeNull();
  expect(store.getState().vaultTransferBusy).toBe(false);
});

it('closes the storage connection after a failed unlock', async () => {
  await store.getState().unlock(password); await store.getState().lock();
  const close = vi.spyOn(IndexedDbVaultStorage.prototype, 'close');
  await expect(store.getState().unlock('incorrect-password')).rejects.toThrow('口令错误');
  expect(close).toHaveBeenCalled();
  expect(store.getState().unlocked).toBe(false);
});
