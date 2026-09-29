import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, VAULT_STORAGE_KEY } from '../workbenchStore';
import { MemoryDirectory } from '@/fileOrganizer/testDirectory';
import { PrivateVault } from '@/services/privateVault';
import { validateVaultBackup } from '@/services/vaultBackupSchema';
import { snapshotText } from '@/fileOrganizer/textEdit';

const pass = 'batch-test-fixture', rule = { find: 'old', replacement: 'new', newline: 'keep' as const };
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock(pass); });
afterEach(async () => { vi.restoreAllMocks(); await store.getState().lock(); vi.unstubAllGlobals(); });
async function prepare(d: MemoryDirectory) { await store.getState().prepareFileEditBatch(d, [...d.files.keys()], rule, true); return store.getState().textBatchPreview!; }
async function commit(d: MemoryDirectory) { const p = store.getState().textBatchPreview!; await store.getState().commitFileEditBatch(d, p.id, p.rows.filter(r => r.after).map(r => r.id), true); }
it('persists every recovery snapshot before the first write and restores as a new batch after refresh', async () => {
  const d = new MemoryDirectory({ 'a.md': '\ufeffold\r\n', 'b.txt': 'old\n' }); await prepare(d);
  d.onCreateWritable = () => { expect(store.getState().fileEditVersions).toHaveLength(2); expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain('old'); };
  await commit(d); d.onCreateWritable = undefined; expect(d.closes).toBe(2);
  expect(store.getState().fileEditVersions.every(v => v.status === 'succeeded')).toBe(true);
  const batchId = store.getState().fileEditVersions[0].batch!.id;
  await store.getState().lock(); await store.getState().unlock(pass); expect(store.getState().textBatchPreview).toBeNull();
  await store.getState().prepareFileEditBatch(d, [], null, true, batchId); await commit(d);
  expect(store.getState().fileEditVersions).toHaveLength(4); expect(await d.files.get('a.md')!.arrayBuffer()).toEqual(new TextEncoder().encode('\ufeffold\r\n').buffer);
  const data = await new PrivateVault(localStorage, VAULT_STORAGE_KEY).unlock(pass); await expect(validateVaultBackup(data)).resolves.toBeTruthy();
});
it('refuses an external change in any selected file before writing any files', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old', 'b.txt': 'old' }); await prepare(d); d.put('b.txt', 'external');
  await expect(commit(d)).rejects.toThrow('外部'); expect(d.closes).toBe(0); expect(store.getState().fileEditVersions).toEqual([]);
});
it('stops on the second file failure and keeps completed, uncertain and unstarted records', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old', 'b.txt': 'old', 'c.txt': 'old' }); await prepare(d);
  d.onWrite = name => { if (name === 'b.txt') throw new Error('fixture disk failure'); };
  await expect(commit(d)).rejects.toThrow('disk'); expect(d.closes).toBe(1);
  expect(store.getState().fileEditVersions.map(v => v.status)).toEqual(['succeeded', 'needs-attention', 'not-started']);
  expect(await d.files.get('c.txt')!.text()).toBe('old'); d.onWrite = undefined;
  await store.getState().inspectFileEdit(d, store.getState().fileEditVersions[1].id, true); expect(store.getState().fileEditVersions[1].status).toBe('not-applied');
  await store.getState().lock(); await store.getState().unlock(pass); expect(store.getState().fileEditVersions.map(v => v.status)).toEqual(['succeeded', 'not-applied', 'not-started']);
});
it('does no disk write if the whole-batch checkpoint cannot persist and consumes the preview once', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old', 'b.txt': 'old' }), p = await prepare(d);
  const fail = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await expect(commit(d)).rejects.toThrow('保存失败'); expect(d.closes).toBe(0); expect(store.getState().fileEditVersions.every(v => v.status === 'not-started')).toBe(true);
  fail.mockRestore(); await store.getState().retryStorage();
  await expect(store.getState().commitFileEditBatch(d, p.id, p.rows.map(r => r.id), true)).rejects.toThrow('失效'); expect(d.closes).toBe(0);
});
it('stops after a successful file whose final save failed; storage retry never continues the batch', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old', 'b.txt': 'old' }); await prepare(d);
  const save = localStorage.setItem.bind(localStorage); let failed = false;
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { if (failed) throw new Error('quota'); save(key, value); }); d.onClose = () => { failed = true; };
  await expect(commit(d)).rejects.toThrow('保存失败'); expect(d.closes).toBe(1); expect(store.getState().fileEditVersions.map(v => v.status)).toEqual(['succeeded', 'not-started']);
  failed = false; await store.getState().retryStorage(); expect(d.closes).toBe(1);
  await store.getState().lock(); await store.getState().unlock(pass); expect(store.getState().fileEditVersions.map(v => v.status)).toEqual(['succeeded', 'not-started']);
});
it('cancellation after a file completes leaves subsequent files unstarted', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old', 'b.txt': 'old' }); await prepare(d);
  d.onClose = () => store.getState().cancelFileEditBatch(); await expect(commit(d)).rejects.toThrow('停止');
  expect(d.closes).toBe(1); expect(store.getState().fileEditVersions.map(v => v.status)).toEqual(['succeeded', 'not-started']);
});
it('discards a cancelled late read and refuses a different directory or changed history', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old' }), read = d.getFileHandle.bind(d); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  vi.spyOn(d, 'getFileHandle').mockImplementationOnce(async name => { entered(); await held; return read(name); });
  const pending = prepare(d).catch(e => e); await started; store.getState().cancelFileEditBatch(); release(); expect(await pending).toMatchObject({ message: expect.stringContaining('取消') }); expect(store.getState().textBatchPreview).toBeNull();
  const p = await prepare(d); await expect(store.getState().commitFileEditBatch(new MemoryDirectory({ 'a.md': 'old' }), p.id, p.rows.map(r => r.id), true)).rejects.toThrow('失效');
});
it('keeps the operation fence across lock/unlock while an issued native write finishes', async () => {
  const d = Object.assign(new MemoryDirectory({ 'a.md': 'old', 'b.txt': 'old' }), { identity: 'directory-identity' });
  const getHandle = d.getFileHandle.bind(d); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  vi.spyOn(d, 'getFileHandle').mockImplementation(async name => ({ ...await getHandle(name),
    readText: () => d.files.get(name)!.text().then(text => snapshotText(text, name + '-id')),
    replaceText: async text => { entered(); await held; d.put(name, text); },
  }));
  await prepare(d); const pending = commit(d).catch(e => e); await started;
  await store.getState().lock(); await store.getState().unlock(pass);
  expect(store.getState().organizerBusy).toBe(true); await expect(prepare(d)).rejects.toThrow('等待'); release(); expect(await pending).toBeInstanceOf(Error);
  expect(store.getState().fileEditVersions.map(v => v.status)).toEqual(['interrupted', 'not-started']); expect(await d.files.get('b.txt')!.text()).toBe('old');
  await store.getState().inspectFileEdit(d, store.getState().fileEditVersions[0].id, true); expect(store.getState().fileEditVersions[0].inspection?.outcome).toBe('after');
});
it('rejects invalid batch metadata in backup while allowing partial retained histories', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old', 'b.txt': 'old' }); await prepare(d); await commit(d);
  const data = await new PrivateVault(localStorage, VAULT_STORAGE_KEY).unlock(pass);
  const valid = structuredClone(data); valid.fileEditVersions!.pop(); await expect(validateVaultBackup(valid)).resolves.toBeTruthy();
  for (const change of [
    () => { data.fileEditVersions![0].batch!.index = 9; },
    () => { data.fileEditVersions![1].batch!.index = 0; },
    () => { data.fileEditVersions![1].batch!.total = 3; },
    () => { delete data.fileEditVersions![0].batch; data.fileEditVersions![0].status = 'not-started'; },
  ]) {
    data.fileEditVersions = structuredClone(store.getState().fileEditVersions); change(); await expect(validateVaultBackup(data)).rejects.toThrow('无效');
  }
});
