import { webcrypto } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrivateVault } from '../privateVault';
import { IndexedDbVaultStorage } from '../privateVaultStorage';
import type { VaultData } from '@/types/workbench';

const key = 'geiit.workbench.encrypted.v1';
const password = 'idb-test-passphrase';
const data: VaultData = { profiles: [], conversations: [] };
let factory: IDBFactory;
let stores: IndexedDbVaultStorage[];

function storage() {
  const value = new IndexedDbVaultStorage(factory);
  stores.push(value);
  return value;
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder); vi.stubGlobal('TextDecoder', TextDecoder);
  localStorage.clear(); factory = new IDBFactory(); stores = [];
});
afterEach(() => { stores.forEach(value => value.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('migrates a legacy localStorage ciphertext on its first IndexedDB write', async () => {
  const legacy = new PrivateVault(localStorage, key);
  await legacy.unlock(password); await legacy.save(data);
  const previous = localStorage.getItem(key)!;
  const nextData: VaultData = { profiles: [], conversations: [], personalItems: [] };
  const current = new PrivateVault(storage(), key);
  await expect(current.unlock(password)).resolves.toEqual(data);
  await current.save(nextData);
  expect(localStorage.getItem(key)).not.toBe(previous);
  current.lock(); legacy.lock();
  await expect(new PrivateVault(storage(), key).unlock(password)).resolves.toEqual(nextData);
});

it('keeps a snapshot larger than the measured localStorage limit in encrypted IndexedDB', async () => {
  const current = new PrivateVault(storage(), key);
  await current.unlock(password);
  const large: VaultData = { profiles: [], conversations: [], personalItems: [], reminderDrafts: [] };
  large.conversations = [{ id: 'large', title: 'large', profileId: '', updatedAt: new Date().toISOString(), messages: [
    { id: 'message', role: 'user', content: 'x'.repeat(6 * 1024 * 1024), createdAt: new Date().toISOString() },
  ] }];
  await current.save(large);
  expect(localStorage.getItem(key)).toMatch(/^geiit-indexeddb-v1:/);
  current.lock();
  const reopened = new PrivateVault(storage(), key);
  const restored = await reopened.unlock(password);
  expect(restored.conversations[0].messages[0].content).toHaveLength(6 * 1024 * 1024);
  reopened.lock();
});

it('rejects a stale cross-window replacement without changing the newer ciphertext', async () => {
  const first = storage(), second = storage();
  await first.setItem(key, 'initial');
  expect(await second.getItem(key)).toBe('initial');
  await first.setItem(key, 'newer', 'initial');
  await expect(second.setItem(key, 'stale', 'initial')).rejects.toThrow('另一窗口改变');
  expect(await second.getItem(key)).toBe('newer');
});

it('checks cancellation inside the transaction before replacing ciphertext', async () => {
  const current = storage(); await current.setItem(key, 'initial');
  await expect(current.setItem(key, 'replacement', 'initial', () => { throw new Error('cancelled'); })).rejects.toThrow('cancelled');
  expect(await current.getItem(key)).toBe('initial');
});

it('allows only one simultaneous creation when Web Locks are unavailable', async () => {
  const first = storage(), second = storage();
  const results = await Promise.allSettled([first.setItem(key, 'first'), second.setItem(key, 'second')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(['first', 'second']).toContain(await first.getItem(key));
});

it('rejects synchronous write errors without escaping the event handler or replacing data', async () => {
  const current = storage(); await current.setItem(key, 'initial');
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await expect(current.setItem(key, 'replacement', 'initial')).rejects.toThrow('无法更新');
  expect(await current.getItem(key)).toBe('initial');
});
