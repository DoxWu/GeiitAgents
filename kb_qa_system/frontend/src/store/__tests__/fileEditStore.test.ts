import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, VAULT_STORAGE_KEY } from '../workbenchStore';
import { MemoryDirectory } from '@/fileOrganizer/testDirectory';
import { PrivateVault } from '@/services/privateVault';
import { snapshotText } from '@/fileOrganizer/textEdit';

const password = 'text-edit-test-1234';
const fixture = () => new MemoryDirectory({ 'a.md': '\ufefforiginal秘密\r\n' });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function edit(directory: MemoryDirectory) {
  await store.getState().openFileEdit(directory, 'a.md', true);
  const draft = store.getState().fileEditDraft!; store.getState().stageFileEdit(draft.id, '# changed私有\n', 'crlf');
  return store.getState().fileEditDraft!;
}
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock(password); });
afterEach(async () => { vi.restoreAllMocks(); await store.getState().lock(); vi.unstubAllGlobals(); });

it('flushes the latest draft on lock, restores it without directory grants, and protects it from replacement', async () => {
  const directory = fixture(), draft = await edit(directory);
  await expect(store.getState().openFileEdit(directory, 'a.md', true)).rejects.toThrow('丢弃');
  await store.getState().lock(); expect(store.getState().fileEditDraft).toBeNull();
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toMatch(/original秘密|changed私有|a.md/);
  await store.getState().unlock(password); expect(store.getState().fileEditDraft).toEqual(draft);
  await store.getState().commitFileEdit(directory, draft.editId, true);
  expect(await directory.files.get('a.md')!.arrayBuffer()).toEqual(new TextEncoder().encode('\ufeff# changed私有\r\n').buffer);
  expect(store.getState().fileEditDraft).toBeNull(); expect(store.getState().fileEditVersions[0].status).toBe('succeeded');
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().fileEditVersions[0].before.text).toBe('\ufefforiginal秘密\r\n');
});
it('restores historical bytes against a fresh preview and appends a new record while preserving newer text', async () => {
  const directory = fixture(), draft = await edit(directory); await store.getState().commitFileEdit(directory, draft.editId, true);
  const original = store.getState().fileEditVersions[0]; directory.put('a.md', 'later external\n');
  await store.getState().openFileEdit(directory, 'a.md', true, original.id);
  const recovery = store.getState().fileEditDraft!; expect(recovery.before.text).toBe('later external\n');
  expect(recovery.restoreText).toBe(original.before.text); expect(directory.closes).toBe(1);
  await store.getState().commitFileEdit(directory, recovery.editId, true);
  expect(store.getState().fileEditVersions).toHaveLength(2);
  expect(store.getState().fileEditVersions[0]).toMatchObject({ restoredFrom: original.id, before: { text: 'later external\n' }, after: original.before });
});
it('requires current preview revision and stops before writes on stale content or failed encrypted preparation', async () => {
  const directory = fixture(), draft = await edit(directory);
  await expect(store.getState().commitFileEdit(directory, 'stale-edit', true)).rejects.toThrow('预览');
  directory.put('a.md', 'external'); await expect(store.getState().commitFileEdit(directory, draft.editId, true)).rejects.toThrow('外部');
  expect(store.getState().fileEditVersions).toHaveLength(0); directory.put('a.md', draft.before.text);
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await expect(store.getState().commitFileEdit(directory, draft.editId, true)).rejects.toThrow('保存失败');
  expect(directory.closes).toBe(0); expect(store.getState().fileEditDraft).toEqual(draft);
  expect(store.getState().fileEditVersions[0].status).toBe('needs-attention');
});
it('retries only persistence after final storage failure, without replaying file writes', async () => {
  const directory = fixture(), draft = await edit(directory), originalSave = localStorage.setItem.bind(localStorage);
  const fail = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (store.getState().fileEditVersions[0]?.status === 'succeeded') throw new Error('quota'); originalSave(key, value);
  });
  await expect(store.getState().commitFileEdit(directory, draft.editId, true)).rejects.toThrow('保存失败');
  expect(store.getState().fileEditVersions[0].status).toBe('succeeded'); expect(store.getState().fileEditDraft).toBeNull();
  expect(directory.closes).toBe(1); fail.mockRestore(); await store.getState().retryStorage(); expect(directory.closes).toBe(1);
  await store.getState().lock(); await store.getState().unlock(password); expect(store.getState().fileEditVersions[0].status).toBe('succeeded');
});
it('keeps interrupted snapshots and performs read-only reconciliation after a lost completion save', async () => {
  const directory = fixture(), draft = await edit(directory), realSave = PrivateVault.prototype.save;
  vi.spyOn(PrivateVault.prototype, 'save').mockImplementation(function (this: PrivateVault, data) {
    if (data.fileEditVersions?.[0]?.status === 'succeeded') return Promise.reject(new Error('quota'));
    return realSave.call(this, data);
  });
  await expect(store.getState().commitFileEdit(directory, draft.editId, true)).rejects.toThrow('保存失败');
  // Simulate forceful memory loss rather than orderly lock's draft flush.
  store.setState({ fileEditSaving: false }); vi.restoreAllMocks(); await store.getState().lock(); await store.getState().unlock(password);
  const record = store.getState().fileEditVersions[0]; expect(record.status).toBe('interrupted');
  await expect(store.getState().commitFileEdit(directory, draft.editId, true)).rejects.toThrow('先核验');
  await expect(store.getState().removeFileEditVersion(record.id)).rejects.toThrow('核验');
  await store.getState().inspectFileEdit(directory, record.id, true);
  expect(store.getState().fileEditVersions[0]).toMatchObject({ status: 'succeeded', inspection: { outcome: 'after' } });
  expect(directory.closes).toBe(1); expect(store.getState().fileEditDraft).toEqual(draft);
});
it('keeps the shared operation fence through lock/unlock while an issued native write finishes', async () => {
  const directory = Object.assign(fixture(), { identity: 'directory-id' }), reached = deferred(), release = deferred();
  const getHandle = directory.getFileHandle.bind(directory); const retain = vi.fn(), revoke = vi.fn(); Object.assign(directory, { retain, release: revoke });
  vi.spyOn(directory, 'getFileHandle').mockImplementation(async name => ({ ...await getHandle(name),
    readText: async () => snapshotText(await directory.files.get(name)!.text(), 'file-id'),
    replaceText: async text => { reached.resolve(); await release.promise; directory.put(name, text); },
  }));
  const draft = await edit(directory); const writing = store.getState().commitFileEdit(directory, draft.editId, true).catch(e => e);
  await reached.promise; await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().organizerBusy).toBe(true);
  await expect(store.getState().runFileOrganizer(directory, [])).rejects.toThrow('正在运行');
  release.resolve(); expect(await writing).toBeInstanceOf(Error); expect(store.getState().organizerBusy).toBe(false);
  expect(store.getState().fileEditVersions[0].status).toBe('interrupted');
  await store.getState().inspectFileEdit(directory, store.getState().fileEditVersions[0].id, true);
  expect(store.getState().fileEditVersions[0].inspection?.outcome).toBe('after'); expect(retain.mock.calls.length).toBe(revoke.mock.calls.length);
});
it('retains a draft when discarding cannot be persisted', async () => {
  const directory = fixture(), draft = await edit(directory);
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await expect(store.getState().discardFileEdit(draft.id)).rejects.toThrow('保存失败'); expect(store.getState().fileEditDraft).toEqual(draft);
});
