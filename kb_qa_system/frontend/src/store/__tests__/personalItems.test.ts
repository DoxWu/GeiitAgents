import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, VAULT_STORAGE_KEY } from '../workbenchStore';
import { PrivateVault } from '@/services/privateVault';

const password = 'test-only-passphrase';
const note = { kind: 'note' as const, title: '保密笔记', content: '笔记完整内容\n**测试**', tags: ['事务'] };
const todo = { ...note, kind: 'todo' as const, title: '测试待办', status: 'open' as const, priority: 'high' as const, dueAt: '2026-10-01T01:00:00.000Z' };
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder); vi.stubGlobal('TextDecoder', TextDecoder);
  localStorage.clear(); await store.getState().unlock(password);
});
afterEach(async () => { vi.restoreAllMocks(); await store.getState().lock(); vi.unstubAllGlobals(); });

it('encrypts notes and todos, clears locked memory, restores content and completion', async () => {
  const noteId = crypto.randomUUID(), todoId = crypto.randomUUID();
  await store.getState().savePersonalItem(noteId, note, 0);
  await store.getState().savePersonalItem(todoId, todo, 0);
  const done = await store.getState().savePersonalItem(todoId, { ...todo, status: 'done' }, 1);
  expect(done.completedAt).toBeTruthy();
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain(note.title);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain(todo.dueAt);
  await store.getState().lock(); expect(store.getState().personalItems).toEqual([]);
  await store.getState().unlock(password);
  expect(store.getState().personalItems.find(item => item.id === noteId)).toMatchObject(note);
  expect(store.getState().personalItems.find(item => item.id === todoId)).toEqual(done);
  const reopened = await store.getState().savePersonalItem(todoId, todo, 2);
  expect(reopened.completedAt).toBeNull();
  await store.getState().removePersonalItem(noteId, 1);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().personalItems).toHaveLength(1);
});

it('rejects stale edits/deletes, type mutation and invalid input without losing the current revision', async () => {
  const id = crypto.randomUUID();
  await store.getState().savePersonalItem(id, note, 0);
  const editing = store.getState().savePersonalItem(id, { ...note, title: '更新' }, 1);
  await expect(store.getState().savePersonalItem(id, note, 1)).rejects.toThrow('已改变');
  await editing;
  await expect(store.getState().removePersonalItem(id, 1)).rejects.toThrow('已改变');
  await expect(store.getState().savePersonalItem(id, todo, 2)).rejects.toThrow('类型');
  await expect(store.getState().savePersonalItem(crypto.randomUUID(), { ...note, title: '' }, 0)).rejects.toThrow();
  expect(store.getState().personalItems[0]).toMatchObject({ title: '更新', revision: 2 });
});

it('retains a failed write in memory and retries persistence without duplicating items', async () => {
  const id = crypto.randomUUID();
  const fail = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await expect(store.getState().savePersonalItem(id, note, 0)).rejects.toThrow('保存失败');
  expect(store.getState().personalItems).toHaveLength(1);
  expect(store.getState().storageError).toBeTruthy();
  fail.mockRestore(); await store.getState().retryStorage();
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().personalItems).toHaveLength(1);
  expect(store.getState().personalItems[0].revision).toBe(1);
});

it('does not acknowledge a save as successful after a lock; recovers its actual persisted outcome', async () => {
  const id = crypto.randomUUID();
  const pending = store.getState().savePersonalItem(id, note, 0);
  const rejected = expect(pending).rejects.toThrow('锁定');
  await store.getState().lock(); await rejected;
  expect(store.getState().personalItems).toHaveLength(0);
  await expect(store.getState().savePersonalItem(id, note, 0)).rejects.toThrow('解锁');
  await store.getState().unlock(password);
  expect(store.getState().personalItems[0]).toMatchObject(note);
});

it('opens legacy vaults without personal fields as an empty list', async () => {
  await store.getState().lock(); localStorage.clear();
  const old = new PrivateVault(localStorage, VAULT_STORAGE_KEY);
  await old.unlock(password); await old.save({ profiles: [], conversations: [] }); old.lock();
  await store.getState().unlock(password);
  expect(store.getState().personalItems).toEqual([]);
});
