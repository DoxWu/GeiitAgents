import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, VAULT_STORAGE_KEY } from '../workbenchStore';
import { personalDraft, type PersonalDraft } from '@/personal/itemDraft';
import { PrivateVault } from '@/services/privateVault';

const password = 'personal-drafts-fixture';
const note = { kind: 'note' as const, title: '正式内容', content: '原文', tags: [] };
function draft(): PersonalDraft { const result = personalDraft(undefined, 'note'); result.input.title = '独立保密草稿'; result.input.content = '**未保存原文**'; return result; }
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock(password); });
afterEach(async () => { vi.restoreAllMocks(); await store.getState().lock(); vi.unstubAllGlobals(); });

it('flushes raw independent drafts on immediate lock, including invalid form input', async () => {
  const first = draft(), second = draft(); first.input.title = ''; first.tagsText = '重复，重复，'; first.dueText = 'incomplete';
  store.getState().stagePersonalDraft(first); store.getState().stagePersonalDraft(second);
  await store.getState().lock(); expect(store.getState().personalDrafts).toEqual([]);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain('保密草稿');
  await store.getState().unlock(password);
  expect(store.getState().personalDrafts).toEqual([second, first]);
  await expect(store.getState().commitPersonalDraft(first.id, first.editId)).rejects.toThrow('标题');
  expect(store.getState().personalItems).toEqual([]);
});
it('commits a raw draft and removes it in the same encrypted record snapshot', async () => {
  const value = draft(); value.tagsText = '工作，工作'; store.getState().stagePersonalDraft(value);
  const saved = await store.getState().commitPersonalDraft(value.id, value.editId);
  expect(saved.tags).toEqual(['工作']); expect(store.getState().personalDrafts).toEqual([]);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().personalItems).toEqual([saved]); expect(store.getState().personalDrafts).toEqual([]);
});
it('does not replace a newer draft while an older commit is awaiting encryption', async () => {
  const value = draft(); store.getState().stagePersonalDraft(value);
  const realSave = PrivateVault.prototype.save;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(PrivateVault.prototype, 'save').mockImplementationOnce(async function (this: PrivateVault, data) { await held; await realSave.call(this, data); });
  const pending = store.getState().commitPersonalDraft(value.id, value.editId).catch(error => error);
  const next = { ...value, editId: crypto.randomUUID(), input: { ...value.input, content: '较新编辑' } };
  store.getState().stagePersonalDraft(next); release();
  expect(await pending).toMatchObject({ message: '草稿已改变，请重新打开。' });
  expect(store.getState().personalItems).toEqual([]); expect(store.getState().personalDraftSaving).toBe(true);
  expect(store.getState().personalDrafts[0].input.content).toBe('较新编辑');
});
it('preserves the persisted raw draft when the final record write and lock flush both fail', async () => {
  const value = draft(); store.getState().stagePersonalDraft(value);
  const realSave = PrivateVault.prototype.save;
  vi.spyOn(PrivateVault.prototype, 'save').mockImplementation(function (this: PrivateVault, data) { return data.personalItems?.length ? Promise.reject(new Error('quota')) : realSave.call(this, data); });
  await expect(store.getState().commitPersonalDraft(value.id, value.editId)).rejects.toThrow('保存失败');
  expect(store.getState().personalItems).toHaveLength(1); expect(store.getState().personalDrafts).toEqual([]);
  await store.getState().lock(); vi.restoreAllMocks(); await store.getState().unlock(password);
  expect(store.getState().personalItems).toEqual([]); expect(store.getState().personalDrafts).toEqual([value]);
  await store.getState().commitPersonalDraft(value.id, value.editId);
  expect(store.getState().personalItems).toHaveLength(1);
});
it('retries a failed final write without creating another record or revision', async () => {
  const value = draft(); store.getState().stagePersonalDraft(value);
  const realSave = PrivateVault.prototype.save;
  vi.spyOn(PrivateVault.prototype, 'save').mockImplementation(function (this: PrivateVault, data) { return data.personalItems?.length ? Promise.reject(new Error('quota')) : realSave.call(this, data); });
  await expect(store.getState().commitPersonalDraft(value.id, value.editId)).rejects.toThrow();
  vi.restoreAllMocks(); await store.getState().retryStorage();
  expect(store.getState().personalDraftSaving).toBe(false);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().personalItems).toHaveLength(1); expect(store.getState().personalItems[0].revision).toBe(1); expect(store.getState().personalDrafts).toEqual([]);
});
it('retains edits across revision conflicts and deletion, and restores a failed discard', async () => {
  const saved = await store.getState().savePersonalItem(crypto.randomUUID(), note, 0), value = personalDraft(saved);
  value.input.content = '未完成修改'; store.getState().stagePersonalDraft(value);
  await store.getState().savePersonalItem(saved.id, { ...note, content: '其他修改' }, 1);
  await expect(store.getState().commitPersonalDraft(value.id, value.editId)).rejects.toThrow('已改变');
  await store.getState().removePersonalItem(saved.id, 2);
  await expect(store.getState().commitPersonalDraft(value.id, value.editId)).rejects.toThrow('已改变');
  const fail = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await expect(store.getState().discardPersonalDraft(value.id, value.editId)).rejects.toThrow('保存失败');
  expect(store.getState().personalDrafts).toEqual([value]);
  fail.mockRestore(); await store.getState().discardPersonalDraft(value.id, value.editId);
  expect(store.getState().personalDrafts).toEqual([]);
});
it('archives a checked batch atomically, preserves todo status, and refuses drafts or stale selections', async () => {
  const a = await store.getState().savePersonalItem(crypto.randomUUID(), note, 0);
  const b = await store.getState().savePersonalItem(crypto.randomUUID(), { ...note, kind: 'todo', dueAt: null, status: 'done', priority: 'high' }, 0);
  const selection = [{ id: a.id, revision: 1 }, { id: b.id, revision: 1 }];
  const value = personalDraft(a); store.getState().stagePersonalDraft(value);
  await expect(store.getState().archivePersonalItems(selection, true)).rejects.toThrow('草稿');
  await store.getState().discardPersonalDraft(value.id, value.editId);
  await expect(store.getState().archivePersonalItems([selection[0], { ...selection[1], revision: 0 }], true)).rejects.toThrow('已改变');
  expect(store.getState().personalItems.every(item => !item.archivedAt)).toBe(true);
  await store.getState().archivePersonalItems(selection, true);
  expect(store.getState().personalItems.find(item => item.id === b.id)).toMatchObject({ status: 'done', completedAt: b.completedAt, revision: 2, archivedAt: expect.any(String) });
  await expect(store.getState().savePersonalItem(a.id, note, 2)).rejects.toThrow('归档');
  await store.getState().lock(); await store.getState().unlock(password);
  await store.getState().archivePersonalItems(selection.map(item => ({ ...item, revision: 2 })), false);
  expect(store.getState().personalItems.every(item => !item.archivedAt && item.revision === 3)).toBe(true);
});
it('limits drafts without evicting earlier edits and rejects locked mutation', async () => {
  const values = Array.from({ length: 100 }, draft); store.setState({ personalDrafts: values });
  expect(() => store.getState().stagePersonalDraft(draft())).toThrow('100');
  expect(store.getState().personalDrafts).toEqual(values);
  store.getState().stagePersonalDraft({ ...values[0], editId: crypto.randomUUID() });
  await store.getState().lock(); expect(() => store.getState().stagePersonalDraft(draft())).toThrow('解锁');
});
