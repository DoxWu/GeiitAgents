import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { applyRenamePlan, inspectRenameOutcome, OrganizerRecoveryError } from './apply';
import { MemoryDirectory } from './testDirectory';
import { makeRenamePlan, type RenamePlan } from './plan';
import { assertRunDirectories, undoPlan, type OrganizerRun } from './history';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
const plan: RenamePlan[] = ['a', 'b'].map(name => ({ source: name + '.txt', target: name + '.txt', size: 1, status: 'ready' }));
const fixture = () => ({ source: new MemoryDirectory({ 'a.txt': 'A', 'b.txt': 'B' }), destination: new MemoryDirectory({ 'keep.txt': 'untouched' }) });
const names = (directory: MemoryDirectory) => [...directory.files.keys()].sort();

it('moves unchanged names, records stages in source, inspects and reverses both directories', async () => {
  const { source, destination } = fixture();
  const result = await applyRenamePlan(source, plan, { destination, beforeWrite: async () => {
    expect(names(source)).toEqual(['a.txt', 'b.txt']); expect(names(destination)).toEqual(['keep.txt']);
  } });
  expect(names(source)).toEqual([]); expect(names(destination)).toEqual(['a.txt', 'b.txt', 'keep.txt']);
  expect((await inspectRenameOutcome(source, result.changes, destination)).outcome).toBe('applied');
  const run: OrganizerRun = { ...result, directoryName: 'source', destinationName: 'target', kind: 'move', status: 'succeeded', createdAt: '', updatedAt: '' };
  await applyRenamePlan(destination, undoPlan(run), { destination: source });
  expect(names(source)).toEqual(['a.txt', 'b.txt']); expect(names(destination)).toEqual(['keep.txt']);
  expect((await inspectRenameOutcome(source, result.changes, destination)).outcome).toBe('not-applied');
});
it('refuses a separately-selected handle to the same directory', async () => {
  const { source } = fixture(); const alias = Object.create(source) as MemoryDirectory;
  source.isSameEntry = async () => true;
  await expect(applyRenamePlan(source, plan, { destination: alias })).rejects.toThrow('相同');
  expect(names(source)).toEqual(['a.txt', 'b.txt']);
});
it('rejects occupied target names before writing, including case variants', async () => {
  const { source, destination } = fixture(); destination.put('A.TXT', 'external');
  await expect(applyRenamePlan(source, plan, { destination })).rejects.toThrow('冲突');
  expect(source.closes + destination.closes).toBe(0);
});
it.each(['failure', 'cancel', 'deleted-then-rejected'])('restores source across directories after %s', async mode => {
  const { source, destination } = fixture(), controller = new AbortController();
  source.afterRemove = name => { if (name === 'a.txt') { if (mode === 'cancel') controller.abort(); if (mode === 'deleted-then-rejected') throw new Error('ambiguous'); } };
  if (mode === 'failure') source.onRemove = name => { if (name === 'b.txt') throw new Error('failure'); };
  await expect(applyRenamePlan(source, plan, { destination, signal: controller.signal })).rejects.toThrow();
  expect(names(source)).toEqual(['a.txt', 'b.txt']); expect(names(destination)).toEqual(['keep.txt']);
  expect(await source.files.get('a.txt')!.text()).toBe('A');
});
it('keeps qualified recovery locations when source restore fails', async () => {
  const { source, destination } = fixture();
  source.onRemove = name => { if (name === 'b.txt') throw new Error('failure'); };
  source.onWrite = name => { if (name === 'a.txt') throw new Error('cannot restore'); };
  const error = await applyRenamePlan(source, plan, { destination }).catch(error => error);
  expect(error).toBeInstanceOf(OrganizerRecoveryError);
  expect(error.retainedFiles).toContain('目标目录/a.txt');
  expect(error.retainedFiles.some((name: string) => name.startsWith('源目录/.geiit-stage-'))).toBe(true);
  expect(await destination.files.get('a.txt')!.text()).toBe('A');
});
it('retains an externally modified destination during compensation', async () => {
  const { source, destination } = fixture();
  source.afterRemove = name => { if (name === 'a.txt') { destination.put('a.txt', 'external'); throw new Error('failure'); } };
  await expect(applyRenamePlan(source, plan, { destination })).rejects.toBeInstanceOf(OrganizerRecoveryError);
  expect(await source.files.get('a.txt')!.text()).toBe('A'); expect(await destination.files.get('a.txt')!.text()).toBe('external');
});
it('previews preserving names and conflicts against every target entry', () => {
  const files = [{ name: 'a.txt', path: 'a.txt', modifiedAt: 1000, size: 1, type: '' }];
  expect(makeRenamePlan(files, '', [], true)[0]).toMatchObject({ target: 'a.txt', status: 'ready' });
  expect(makeRenamePlan(files, '', ['A.TXT'], true)[0].status).toBe('conflict');
});
it('requires both directory grants and checks persistent native identities for undo/reconcile', () => {
  const run: OrganizerRun = { id: 'x', kind: 'move', directoryName: 'same-name', destinationName: 'same-name', directoryIdentity: 'source-id', destinationIdentity: 'target-id', changes: [], status: 'succeeded', createdAt: '', updatedAt: '' };
  const source = Object.assign(new MemoryDirectory({}), { identity: 'source-id' }), target = Object.assign(new MemoryDirectory({}), { identity: 'target-id' });
  expect(() => assertRunDirectories(run, source)).toThrow('源目录与目标目录');
  expect(() => assertRunDirectories(run, target, source)).toThrow('不一致');
  assertRunDirectories(run, source, target); assertRunDirectories(run, target, source, true);
});
