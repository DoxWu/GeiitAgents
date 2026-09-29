import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryDirectory } from './testDirectory';
import { exclusively } from './operationLock';
import { assertVersionCapacity, draftText, MAX_TEXT_BYTES, readDirectoryText, snapshotText, textBytes, textFormat, writeDirectoryText, type FileEditDraft, type FileEditVersion } from './textEdit';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
async function draft(directory: MemoryDirectory): Promise<FileEditDraft> {
  const before = await readDirectoryText(directory, 'a.md');
  return { id: 'draft', editId: 'revision', name: 'a.md', directoryName: directory.name, before, ...textFormat(before.text) };
}
const options = () => ({ acknowledged: true, beforeWrite: vi.fn(async () => {}), guard: vi.fn() });
it('round-trips UTF-8 BOM, non-BMP, uniform and mixed newlines without lossy decoding', async () => {
  for (const original of ['\ufeff# 中文🙂\r\n尾\r\n', 'a\rb\r', '', 'a\nb', 'mixed\r\nsecond\nthird\r']) {
    const d = await draft(new MemoryDirectory({ 'a.md': original }));
    expect(d.before.text).toBe(original); expect(draftText(d)).toBe(original);
  }
  const mixed = await draft(new MemoryDirectory({ 'a.md': 'a\r\nb\n' })); mixed.content += 'c';
  expect(() => draftText(mixed)).toThrow('混用'); mixed.newline = 'crlf'; expect(draftText(mixed)).toBe('a\r\nb\r\nc');
  mixed.restoreText = 'a\nb\rc\r\n'; expect(draftText(mixed)).toBe(mixed.restoreText);
});
it('rejects nontext, invalid UTF-8, lone surrogates and byte limits before writing', async () => {
  const directory = new MemoryDirectory({ 'a.md': 'valid' });
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0]), new Uint8Array(MAX_TEXT_BYTES + 1)]) {
    directory.files.set('a.md', new File([bytes], 'a.md')); await expect(readDirectoryText(directory, 'a.md')).rejects.toThrow();
  }
  expect(() => textBytes('\uD800')).toThrow('Unicode'); expect(() => textBytes('中'.repeat(100000))).toThrow('256');
  expect(textBytes('🙂').length).toBe(4); await expect(readDirectoryText(directory, '../a.md')).rejects.toThrow();
});
it('writes exact bytes only after durable preparation and refuses changed content and identity', async () => {
  const directory = new MemoryDirectory({ 'a.md': '\ufeffold\r\n' }), d = await draft(directory), opt = options();
  directory.onCreateWritable = () => expect(opt.beforeWrite).toHaveBeenCalledOnce();
  await writeDirectoryText(directory, d, await snapshotText('\ufeff新\r\n'), opt);
  expect(await directory.files.get('a.md')!.arrayBuffer()).toEqual(textBytes('\ufeff新\r\n').buffer);
  await expect(writeDirectoryText(directory, d, await snapshotText('new'), options())).rejects.toThrow('外部');
  directory.put('a.md', d.before.text); directory.identities.set('a.md', {});
  await expect(writeDirectoryText(directory, d, await snapshotText('new'), options())).rejects.toThrow('替换');
});
it('does no write after failed preparation, rechecks after preparation and shares organizer lock', async () => {
  const directory = new MemoryDirectory({ 'a.md': 'old' }), d = await draft(directory), after = await snapshotText('new');
  await expect(writeDirectoryText(directory, d, after, { ...options(), beforeWrite: async () => { throw new Error('quota'); } })).rejects.toThrow('quota');
  expect(directory.closes).toBe(0);
  await expect(writeDirectoryText(directory, d, after, { ...options(), beforeWrite: async () => { directory.put('a.md', 'external'); } })).rejects.toThrow('外部');
  expect(directory.closes).toBe(0);
  await exclusively(async () => { await expect(writeDirectoryText(directory, d, after, options())).rejects.toThrow('正在'); });
});
it('aborts rather than closes after write failure, external edits or cancellation', async () => {
  for (const fault of ['write', 'external', 'cancel']) {
    const directory = new MemoryDirectory({ 'a.md': 'old' }), d = await draft(directory), opt = options(); let cancelled = false;
    opt.guard.mockImplementation(() => { if (cancelled) throw new Error('cancelled'); });
    directory.onWrite = () => { if (fault === 'write') throw new Error('disk fault'); if (fault === 'external') directory.put('a.md', 'external'); if (fault === 'cancel') cancelled = true; };
    await expect(writeDirectoryText(directory, d, await snapshotText('new'), opt)).rejects.toThrow();
    expect(directory.aborts).toBe(1); expect(directory.closes).toBe(0);
    expect(await directory.files.get('a.md')!.text()).toBe(fault === 'external' ? 'external' : 'old');
  }
});
it('requires browser directory acknowledgment and refuses invalid snapshot digests', async () => {
  const directory = new MemoryDirectory({ 'a.md': 'old' }), d = await draft(directory), after = await snapshotText('new');
  await expect(writeDirectoryText(directory, d, after, { ...options(), acknowledged: false })).rejects.toThrow('正确目录');
  await expect(writeDirectoryText(directory, d, { ...after, sha256: 'fake' }, options())).rejects.toThrow('摘要无效');
  await expect(writeDirectoryText(directory, { ...d, directoryIdentity: 'native-dir' }, after, options())).rejects.toThrow('不一致');
});
it('bounds history by actual UTF-8 bytes as well as count without evicting anything', async () => {
  const snapshot = await snapshotText('x'.repeat(MAX_TEXT_BYTES)), record: FileEditVersion = { id: '1', draftId: 'd', name: 'a.md', directoryName: 'test', before: snapshot, after: snapshot, status: 'succeeded', createdAt: '', updatedAt: '' };
  const records = Array.from({ length: 4 }, () => record);
  expect(() => assertVersionCapacity(records, record)).toThrow('2 MiB'); expect(records).toHaveLength(4);
  const small = { ...record, before: await snapshotText('a'), after: await snapshotText('b') };
  expect(() => assertVersionCapacity(Array.from({ length: 50 }, () => small), small)).toThrow('50');
});
