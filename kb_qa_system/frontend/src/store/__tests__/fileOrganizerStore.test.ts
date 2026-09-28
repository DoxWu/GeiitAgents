import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, VAULT_STORAGE_KEY } from '../workbenchStore';
import { MemoryDirectory } from '@/fileOrganizer/testDirectory';
import { PrivateVault } from '@/services/privateVault';
import type { RenamePlan } from '@/fileOrganizer/plan';

const password = 'organizer-test-1234';
const plan: RenamePlan[] = [
  { source: 'confidential-a.txt', target: 'archive-a.txt', size: 1, status: 'ready' },
  { source: 'b.txt', target: 'archive-b.txt', size: 1, status: 'ready' },
];
const fixture = () => new MemoryDirectory({ 'confidential-a.txt': 'A', 'b.txt': 'B' });
const names = (directory: MemoryDirectory) => [...directory.files.keys()].sort();
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock(password); });
afterEach(async () => { vi.restoreAllMocks(); await store.getState().lock(); vi.unstubAllGlobals(); });

it('persists encrypted metadata, reloads it, and undoes with the original content', async () => {
  const directory = fixture(), id = await store.getState().runFileOrganizer(directory, plan);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain('confidential-a');
  await store.getState().lock(); expect(store.getState().organizerRuns).toEqual([]);
  await store.getState().unlock(password);
  expect(store.getState().organizerRuns[0]).toMatchObject({ id, status: 'succeeded', kind: 'rename' });
  await store.getState().runFileOrganizer(directory, [], id);
  expect(store.getState().organizerRuns.map(run => run.status)).toEqual(['succeeded', 'undone']);
  expect(names(directory)).toEqual(['b.txt', 'confidential-a.txt']);
  expect(await directory.files.get('confidential-a.txt')!.text()).toBe('A');
  await expect(store.getState().runFileOrganizer(directory, [], id)).rejects.toThrow();
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().organizerRuns.map(run => run.status)).toEqual(['succeeded', 'undone']);
});
it('refuses edited content or occupied original names before recording an undo', async () => {
  const directory = fixture(), id = await store.getState().runFileOrganizer(directory, plan);
  directory.put('archive-a.txt', 'Z');
  await expect(store.getState().runFileOrganizer(directory, [], id)).rejects.toThrow('不能撤销');
  directory.put('archive-a.txt', 'A'); directory.put('confidential-a.txt', 'new');
  await expect(store.getState().runFileOrganizer(directory, [], id)).rejects.toThrow('冲突');
  expect(await directory.files.get('confidential-a.txt')!.text()).toBe('new');
  expect(store.getState().organizerRuns).toHaveLength(1);
});
it('makes no disk changes if the encrypted preparation cannot be saved', async () => {
  const directory = fixture();
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full'); });
  await expect(store.getState().runFileOrganizer(directory, plan)).rejects.toThrow('保存失败');
  expect(names(directory)).toEqual(['b.txt', 'confidential-a.txt']); expect(directory.closes).toBe(0);
  expect(store.getState().organizerRuns[0].status).toBe('failed');
  expect(store.getState().storageError).toBeTruthy();
});
it('retains a completed in-memory result when final saving fails; retry never replays disk work', async () => {
  const directory = fixture(), original = localStorage.setItem.bind(localStorage);
  const failure = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (store.getState().organizerRuns[0]?.status === 'succeeded') throw new Error('full');
    return original(key, value);
  });
  await expect(store.getState().runFileOrganizer(directory, plan)).rejects.toThrow('保存失败');
  expect(store.getState().organizerRuns[0].status).toBe('succeeded');
  expect(names(directory)).toEqual(['archive-a.txt', 'archive-b.txt']);
  await expect(store.getState().runFileOrganizer(directory, plan)).rejects.toThrow('重试本机保存');
  const writes = directory.closes; failure.mockRestore(); await store.getState().retryStorage();
  expect(directory.closes).toBe(writes);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().organizerRuns[0].status).toBe('succeeded');
});
it('reconciles a completed operation after its final save was lost, without writing files', async () => {
  const directory = fixture(), realSave = PrivateVault.prototype.save;
  vi.spyOn(PrivateVault.prototype, 'save').mockImplementation(function (this: PrivateVault, data) {
    if (data.organizerRuns?.[0]?.status === 'succeeded') return Promise.reject(new Error('full'));
    return realSave.call(this, data);
  });
  await expect(store.getState().runFileOrganizer(directory, plan)).rejects.toThrow('保存失败');
  vi.restoreAllMocks(); await store.getState().lock(); await store.getState().unlock(password);
  const run = store.getState().organizerRuns[0]; expect(run.status).toBe('interrupted');
  await expect(store.getState().removeOrganizerRun(run.id)).rejects.toThrow('未核实');
  const writes = directory.closes; await store.getState().inspectOrganizerRun(directory, run.id);
  expect(directory.closes).toBe(writes); expect(store.getState().organizerRuns[0].status).toBe('succeeded');
});
it('keeps the disk fence across lock and immediate unlock until compensation finishes', async () => {
  const directory = fixture(), reached = deferred(), release = deferred(), remove = directory.removeEntry.bind(directory);
  vi.spyOn(directory, 'removeEntry').mockImplementation(async name => {
    await remove(name);
    if (name === 'confidential-a.txt') { reached.resolve(); await release.promise; }
  });
  const work = store.getState().runFileOrganizer(directory, plan).catch(error => error);
  await reached.promise;
  const locking = store.getState().lock(); expect(store.getState().organizerRuns).toEqual([]); await locking;
  await store.getState().unlock(password);
  const run = store.getState().organizerRuns[0]; expect(run.status).toBe('interrupted');
  expect(store.getState().organizerBusy).toBe(true);
  await expect(store.getState().runFileOrganizer(directory, plan)).rejects.toThrow('正在运行');
  await expect(store.getState().inspectOrganizerRun(directory, run.id)).rejects.toThrow('等待');
  release.resolve(); expect(await work).toMatchObject({ name: 'AbortError' });
  expect(store.getState().organizerBusy).toBe(false); expect(names(directory)).toEqual(['b.txt', 'confidential-a.txt']);
  await store.getState().inspectOrganizerRun(directory, run.id);
  expect(store.getState().organizerRuns[0].status).toBe('failed');
});
it('retains recovery records and copies after incomplete rollback', async () => {
  const directory = fixture();
  directory.onRemove = name => { if (name === 'b.txt') throw new Error('delete failed'); };
  directory.onWrite = name => { if (name === 'confidential-a.txt') throw new Error('restore failed'); };
  await expect(store.getState().runFileOrganizer(directory, plan)).rejects.toThrow('副本');
  const run = store.getState().organizerRuns[0]; expect(run.status).toBe('needs-attention');
  expect(run.retainedFiles).toContain('archive-a.txt');
  await expect(store.getState().removeOrganizerRun(run.id)).rejects.toThrow('未核实');
  const writes = directory.closes; await store.getState().inspectOrganizerRun(directory, run.id);
  expect(store.getState().organizerRuns[0].status).toBe('needs-attention'); expect(directory.closes).toBe(writes);
});
it('records a cleanup warning as success and protects its retained-copy history', async () => {
  const directory = fixture(); directory.onRemove = name => { if (name.startsWith('.geiit-stage-')) throw new Error('cleanup failed'); };
  const id = await store.getState().runFileOrganizer(directory, plan);
  expect(store.getState().organizerRuns[0]).toMatchObject({ status: 'succeeded', warnings: [expect.any(String)] });
  await expect(store.getState().removeOrganizerRun(id)).rejects.toThrow('副本');
});
it('reconciles an interrupted completed undo and marks its original as undone', async () => {
  const directory = fixture(), id = await store.getState().runFileOrganizer(directory, plan), realSave = PrivateVault.prototype.save;
  vi.spyOn(PrivateVault.prototype, 'save').mockImplementation(function (this: PrivateVault, data) {
    if (data.organizerRuns?.[0]?.kind === 'undo' && data.organizerRuns[0].status === 'succeeded') return Promise.reject(new Error('full'));
    return realSave.call(this, data);
  });
  await expect(store.getState().runFileOrganizer(directory, [], id)).rejects.toThrow('保存失败');
  vi.restoreAllMocks(); await store.getState().lock(); await store.getState().unlock(password);
  const undo = store.getState().organizerRuns[0]; expect(undo.status).toBe('interrupted');
  await expect(store.getState().removeOrganizerRun(id)).rejects.toThrow('关联撤销');
  await expect(store.getState().runFileOrganizer(directory, [], id)).rejects.toThrow('已有撤销');
  await store.getState().inspectOrganizerRun(directory, undo.id);
  expect(store.getState().organizerRuns.map(run => run.status)).toEqual(['succeeded', 'undone']);
});
