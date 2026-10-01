import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MemoryDirectory } from './testDirectory';
import { applyTextBatchRules, batchVersions, prepareTextBatch, type TextBatchRule } from './textBatch';
import { MAX_TEXT_BYTES, withTextBatch, writeDirectoryText } from './textEdit';

const rule: TextBatchRule = { find: 'old', replacement: '$& 新🙂', newline: 'keep' };
beforeEach(() => vi.stubGlobal('crypto', webcrypto)); afterEach(() => vi.unstubAllGlobals());
it('previews exact literal replacements preserving BOM and per-file newline without writing', async () => {
  const d = new MemoryDirectory({ 'a.md': '\ufeffold\r\nold\r\n', 'b.txt': 'Old\nold', 'c.txt': 'unchanged' });
  const plan = await prepareTextBatch(d, ['a.md', 'b.txt', 'c.txt'], rule, [], true, () => {});
  expect(plan.rows.map(r => r.matches)).toEqual([2, 1, 0]); expect(plan.rows[0].after!.text).toBe('\ufeff$& 新🙂\r\n$& 新🙂\r\n');
  expect(plan.rows[1].after!.text).toBe('Old\n$& 新🙂'); expect(plan.rows[2].after).toBeUndefined(); expect(d.closes).toBe(0);
});

it('supports bounded case-insensitive literal replacement without regex expansion', async () => {
  const d = new MemoryDirectory({ 'a.md': 'Alpha ALPHA $&' });
  const preview = await prepareTextBatch(d, ['a.md'], { find: 'alpha', replacement: 'X$&', newline: 'keep', caseSensitive: false }, [], true, () => {});
  expect(preview.rows[0].matches).toBe(2);
  expect(preview.rows[0].draft?.content).toBe('X$& X$& $&');
  const invalid = await prepareTextBatch(d, ['a.md'], { find: 'İ', replacement: 'x', newline: 'keep', caseSensitive: false }, [], true, () => {});
  expect(invalid.rows[0].error).toContain('大小写折叠');
});
it('applies a bounded ordered rule pipeline and preserves literal replacement text', () => {
  const result = applyTextBatchRules('Draft: old\nOwner: Alice', [
    { find: 'old', replacement: 'review', newline: 'keep' },
    { find: 'Alice', replacement: '$& (team)', newline: 'keep' },
  ]);
  expect(result).toEqual({ content: 'Draft: review\nOwner: $& (team)', matches: 2 });
  expect(() => applyTextBatchRules('x', Array.from({ length: 6 }, () => ({ find: 'x', replacement: 'x', newline: 'keep' })))).toThrow('1–5');
  expect(() => applyTextBatchRules('x', [
    { find: 'x', replacement: 'a', newline: 'lf' }, { find: 'a', replacement: 'b', newline: 'crlf' },
  ])).toThrow('相同的输出换行');
});
it('isolates invalid UTF-8, mixed newline and excessive expansion while allowing explicit newline conversion', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old\r\nold\n', 'b.txt': 'x'.repeat(MAX_TEXT_BYTES) });
  d.files.set('bad.txt', new File([new Uint8Array([0xff])], 'bad.txt'));
  const plan = await prepareTextBatch(d, ['a.md', 'bad.txt'], rule, [], true, () => {});
  expect(plan.rows.every(r => r.error && !r.after)).toBe(true);
  const fixed = await prepareTextBatch(d, ['a.md'], { ...rule, newline: 'lf' }, [], true, () => {}); expect(fixed.rows[0].after!.text).toBe('$& 新🙂\n$& 新🙂\n');
  const huge = await prepareTextBatch(d, ['b.txt'], { find: 'x', replacement: 'y'.repeat(10000), newline: 'keep' }, [], true, () => {}); expect(huge.rows[0].error).toContain('256');
});
it('rejects inconsistent newline pipelines and malformed rules before reading any file', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old\r\n' });
  await expect(prepareTextBatch(d, ['a.md'], [rule, { ...rule, newline: 'lf' }], [], true, () => {})).rejects.toThrow('相同的输出换行');
  for (const invalid of [null, { ...rule, find: 1 }, { ...rule, replacement: undefined }]) {
    expect(() => applyTextBatchRules('old', [invalid as unknown as typeof rule])).toThrow('文本查找和替换');
  }
  const plan = await prepareTextBatch(d, ['a.md'], [
    { find: 'old', replacement: 'draft', newline: 'lf' },
    { find: 'draft', replacement: 'approved', newline: 'lf' },
  ], [], true, () => {});
  expect(plan.rows[0].matches).toBe(2);
  expect(plan.rows[0].after?.text).toBe('approved\n');
});
it('rejects invalid selection, changed history and entire-batch capacity before registration', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old', 'b.txt': 'old' }), plan = await prepareTextBatch(d, ['a.md', 'b.txt'], rule, [], true, () => {});
  const selected = plan.rows.map(r => r.id), versions = batchVersions(plan, selected, [], new Date().toISOString());
  expect(versions.map(v => v.status)).toEqual(['not-started', 'not-started']); expect(versions.map(v => v.batch?.index)).toEqual([0, 1]);
  expect(() => batchVersions(plan, ['bad'], [], '')).toThrow('无效'); expect(() => batchVersions(plan, selected, versions, '')).toThrow('已变化');
  const full = Array.from({ length: 49 }, (_, i) => ({ ...versions[0], id: String(i) }));
  const large = await prepareTextBatch(d, ['a.md', 'b.txt'], rule, full, true, () => {}); expect(() => batchVersions(large, large.rows.map(r => r.id), full, '')).toThrow('50');
  await expect(prepareTextBatch(d, ['a.md', 'A.md'], rule, [], true, () => {})).rejects.toThrow('不同');
});
it('holds the shared operation lock and detects same-content replacement during preflight', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old' }), plan = await prepareTextBatch(d, ['a.md'], rule, [], true, () => {}), row = plan.rows[0];
  await withTextBatch(async access => { await expect(writeDirectoryText(d, row.draft!, row.after!, { acknowledged: true, guard: () => {}, beforeWrite: async () => {} })).rejects.toThrow('正在'); await access.verify(d, row.draft!, true); });
  d.identities.set('a.md', {}); await withTextBatch(async access => { await expect(access.verify(d, row.draft!, true)).rejects.toThrow('替换'); });
});
it('restores only the exact written state and never restores unstarted or externally changed entries', async () => {
  const d = new MemoryDirectory({ 'a.md': 'old', 'b.txt': 'old', 'c.txt': 'old' }), plan = await prepareTextBatch(d, ['a.md', 'b.txt', 'c.txt'], rule, [], true, () => {});
  const versions = batchVersions(plan, plan.rows.map(r => r.id), [], new Date().toISOString());
  versions[0].status = 'succeeded'; versions[1].status = 'succeeded'; d.put('a.md', versions[0].after.text); d.put('b.txt', 'external'); d.put('c.txt', versions[2].after.text);
  const restore = await prepareTextBatch(d, [], null, versions, true, () => {}, plan.id);
  expect(restore.rows[0].after!.text).toBe('old'); expect(restore.rows[0].draft!.restoredFrom).toBe(versions[0].id);
  expect(restore.rows[1].error).toContain('不同'); expect(restore.rows[2].error).toContain('未执行');
});
