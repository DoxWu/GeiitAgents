import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { applyRenamePlan, inspectRenameOutcome, OrganizerRecoveryError, type RenamePreparation } from './apply';
import { MemoryDirectory } from './testDirectory';
import type { RenamePlan } from './plan';
import { undoPlan } from './history';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
const plan: RenamePlan[] = [
  { source: 'a.txt', target: 'archive-a.txt', size: 1, status: 'ready' },
  { source: 'b.txt', target: 'archive-b.txt', size: 1, status: 'ready' },
];
const keys = (directory: MemoryDirectory) => [...directory.files.keys()].sort();
const failure = () => { throw new Error('simulated failure'); };
describe('applyRenamePlan', () => {
  it('verifies copies, removes stages and yields content fingerprints', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    const result = await applyRenamePlan(directory, plan);
    expect(keys(directory)).toEqual(['archive-a.txt', 'archive-b.txt']);
    expect(await directory.files.get('archive-a.txt')!.text()).toBe('A');
    expect(result.changes[0].sha256).toBe('559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd');
    expect(result.retainedFiles).toEqual([]);
  });
  it('persists metadata before any write and refuses persistence failure', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    await expect(applyRenamePlan(directory, plan, { beforeWrite: async prepared => {
      expect(prepared.changes).toHaveLength(2); expect(keys(directory)).toEqual(['a.txt', 'b.txt']); failure();
    } })).rejects.toThrow('simulated');
    expect(keys(directory)).toEqual(['a.txt', 'b.txt']);
  });
  it.each(['archive-a.txt', 'ARCHIVE-A.TXT'])('rejects target collision %s before writing', async target => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B', [target]: 'old' });
    await expect(applyRenamePlan(directory, plan)).rejects.toThrow('目标文件名冲突');
    expect(await directory.files.get(target)!.text()).toBe('old'); expect(directory.files.size).toBe(3);
  });
  it.each(['../escape.txt', 'dir/file.txt', 'NUL', 'a.txt ', 'a.txt.'])('rejects unsafe names: %s', async target => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    await expect(applyRenamePlan(directory, [{ ...plan[0], target }])).rejects.toThrow('文件名');
    expect(directory.files.size).toBe(2);
  });
  it('rejects duplicate sources and changes since preview', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    await expect(applyRenamePlan(directory, [plan[0], { ...plan[0], target: 'other.txt' }])).rejects.toThrow('重复');
    await expect(applyRenamePlan(directory, [{ ...plan[0], modifiedAt: 900 }])).rejects.toThrow('已改变');
    expect(directory.files.size).toBe(2);
  });
  it.each(['stage-write', 'target-write', 'target-open', 'target-close'])('cleans created empty files after %s failure', async where => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    if (where === 'stage-write') directory.onWrite = name => { if (name.startsWith('.geiit-stage-')) failure(); };
    if (where === 'target-write') directory.onWrite = name => { if (name === 'archive-b.txt') failure(); };
    if (where === 'target-open') directory.onCreateWritable = name => { if (name === 'archive-b.txt') failure(); };
    if (where === 'target-close') directory.onClose = name => { if (name === 'archive-b.txt') failure(); };
    await expect(applyRenamePlan(directory, plan)).rejects.toThrow('simulated');
    expect(keys(directory)).toEqual(['a.txt', 'b.txt']);
    expect(await directory.files.get('a.txt')!.text()).toBe('A');
    if (where !== 'target-open') expect(directory.aborts).toBe(1);
  });
  it('restores deleted sources from disk staging rather than invalidated File snapshots', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    const oldSnapshot = await (await directory.getFileHandle('a.txt')).getFile();
    directory.onRemove = name => { if (name === 'b.txt') failure(); };
    await expect(applyRenamePlan(directory, plan)).rejects.toThrow('simulated');
    await expect(oldSnapshot.arrayBuffer()).rejects.toThrow('Stale');
    expect(keys(directory)).toEqual(['a.txt', 'b.txt']);
    expect(await directory.files.get('a.txt')!.text()).toBe('A');
  });
  it('recovers an ambiguous delete that rejects after deleting its source', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    directory.afterRemove = name => { if (name === 'a.txt') failure(); };
    await expect(applyRenamePlan(directory, plan)).rejects.toThrow('simulated');
    expect(keys(directory)).toEqual(['a.txt', 'b.txt']); expect(await directory.files.get('a.txt')!.text()).toBe('A');
  });
  it('keeps valid target and staged copies when source restoration also fails', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    directory.onRemove = name => { if (name === 'b.txt') failure(); };
    directory.onWrite = name => { if (name === 'a.txt') failure(); };
    const error = await applyRenamePlan(directory, plan).catch(error => error);
    expect(error).toBeInstanceOf(OrganizerRecoveryError);
    expect(error.retainedFiles).toContain('archive-a.txt');
    expect(error.retainedFiles.some((name: string) => name.startsWith('.geiit-stage-'))).toBe(true);
    for (const name of error.retainedFiles) expect(await directory.files.get(name)!.text()).toBe('A');
    expect(await directory.files.get('b.txt')!.text()).toBe('B');
  });
  it('does not discard externally edited sources or targets during compensation', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    directory.onRemove = name => { if (name === 'a.txt') { directory.put('a.txt', 'new'); directory.put('archive-a.txt', 'external'); failure(); } };
    await expect(applyRenamePlan(directory, plan)).rejects.toBeInstanceOf(OrganizerRecoveryError);
    expect(await directory.files.get('a.txt')!.text()).toBe('new');
    expect(await directory.files.get('archive-a.txt')!.text()).toBe('external');
    expect([...directory.files.keys()].some(name => name.startsWith('.geiit-stage-'))).toBe(true);
  });
  it('treats cleanup failure after commit as a warning, not a rollback', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    directory.onRemove = name => { if (name.startsWith('.geiit-stage-') && name.endsWith('-1')) failure(); };
    const result = await applyRenamePlan(directory, plan);
    expect(result.warnings).toHaveLength(1); expect(result.retainedFiles).toHaveLength(1);
    expect(directory.files.has('a.txt')).toBe(false);
    expect(await directory.files.get('archive-b.txt')!.text()).toBe('B');
    expect(await inspectRenameOutcome(directory, result.changes)).toMatchObject({ outcome: 'applied', retainedFiles: result.retainedFiles });
  });
  it('serializes operations and cancels with source recovery', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' }), controller = new AbortController();
    directory.afterRemove = name => { if (name === 'a.txt') controller.abort(); };
    await expect(applyRenamePlan(directory, plan, { signal: controller.signal, beforeWrite: async () => {
      await expect(applyRenamePlan(directory, plan)).rejects.toThrow('正在运行');
    } })).rejects.toThrow('取消');
    expect(keys(directory)).toEqual(['a.txt', 'b.txt']);
  });
  it('supports persisted undo fingerprints and refuses later edits or occupied original names', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' });
    const result = await applyRenamePlan(directory, plan);
    const inverse = undoPlan({ ...result, directoryName: 'fixture', status: 'succeeded', kind: 'rename', createdAt: '', updatedAt: '' });
    directory.put('archive-a.txt', 'Z');
    await expect(applyRenamePlan(directory, inverse)).rejects.toThrow('不能撤销');
    directory.put('archive-a.txt', 'A'); directory.put('a.txt', 'occupied');
    await expect(applyRenamePlan(directory, inverse)).rejects.toThrow('冲突');
    await directory.removeEntry('a.txt'); await applyRenamePlan(directory, inverse);
    expect(keys(directory)).toEqual(['a.txt', 'b.txt']); expect(await directory.files.get('a.txt')!.text()).toBe('A');
    expect((await inspectRenameOutcome(directory, result.changes)).outcome).toBe('not-applied');
  });
  it('reports mixed results without replaying any operation', async () => {
    const directory = new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' }); let prepared!: RenamePreparation;
    await expect(applyRenamePlan(directory, plan, { beforeWrite: async value => { prepared = value; failure(); } })).rejects.toThrow();
    directory.put('archive-a.txt', 'A');
    expect((await inspectRenameOutcome(directory, prepared.changes)).outcome).toBe('mixed');
    expect(keys(directory)).toEqual(['a.txt', 'archive-a.txt', 'b.txt']);
  });
});
