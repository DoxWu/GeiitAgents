import { Blob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyPersonalImport, MAX_PERSONAL_IMPORT_BYTES, planPersonalImport, readPersonalImport, type PersonalImportData } from '../import';
import { exportPersonalItems, type PersonalItem } from '../items';
import { exportPersonalDrafts, personalDraft } from '../itemDraft';

const now = '2026-09-29T10:00:00.000Z';
function note(extra: Partial<PersonalItem> = {}): PersonalItem { return { kind: 'note', title: '会议记录', content: '原始正文', tags: ['工作'], id: crypto.randomUUID(), revision: 1, createdAt: now, updatedAt: now, completedAt: null, ...extra } as PersonalItem; }
function data(items: PersonalItem[]): PersonalImportData { return { kind: 'records', exportedAt: now, items }; }
function file(value: unknown) { return new Blob([JSON.stringify(value)]) as unknown as globalThis.Blob; }
const read = (items: PersonalItem[]) => readPersonalImport(new Blob([exportPersonalItems(items, 'json')]) as unknown as globalThis.Blob);
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('roundtrips actual exports including archived completed todos', async () => {
  const items = [note(), note({ kind: 'todo', status: 'done', priority: 'high', dueAt: now, completedAt: now, archivedAt: now })];
  expect(await read(items)).toMatchObject({ kind: 'records', items });
});
it('restores incomplete raw draft exports as separate drafts, stripping embedded formal metadata', async () => {
  const value = personalDraft(note()); value.input.title = ''; value.tagsText = '工作，工作，'; value.dueText = 'unfinished'; value.timezone = 'Asia/Shanghai';
  const parsed = await readPersonalImport(file(value)), plan = planPersonalImport(parsed, [], [value]);
  expect(plan.rows[0]).toMatchObject({ status: 'duplicate', defaultAction: 'skip', actions: ['skip', 'copy'] });
  const applied = applyPersonalImport(plan, [{ id: value.id, action: 'copy' }], [], [value], now);
  expect(applied.items).toEqual([]); expect(applied.drafts).toHaveLength(2);
  expect(applied.drafts[0]).toMatchObject({ baseRevision: 0, input: { title: '' }, tagsText: value.tagsText, dueText: 'unfinished', timezone: 'Asia/Shanghai' });
  expect(applied.drafts[0].id).not.toBe(value.id); expect(applied.drafts[0].editId).not.toBe(value.editId);
  expect(applied.drafts[0].input).not.toHaveProperty('revision'); expect(applied.drafts[1]).toEqual(value);
});
it('roundtrips a batch draft package, skips duplicate content, and restores copies with fresh identity', async () => {
  const first = personalDraft(note()), second = personalDraft();
  second.input.title = '另一条草稿'; second.input.content = '尚未保存';
  const packed = exportPersonalDrafts([first, second]);
  const parsed = await readPersonalImport(file(JSON.parse(packed)));
  expect(parsed).toMatchObject({ kind: 'drafts', drafts: [first, second] });
  const existing = { ...first, id: crypto.randomUUID(), editId: crypto.randomUUID() }, formal = note();
  const plan = planPersonalImport(parsed, [formal], [existing]);
  expect(plan.rows.map(row => [row.status, row.defaultAction])).toEqual([['duplicate', 'skip'], ['new', 'copy']]);
  const result = applyPersonalImport(plan, plan.rows.map(row => ({ id: row.id, action: row.defaultAction })), [formal], [existing], now);
  expect(result.result).toMatchObject({ drafts: 1, skipped: 1 });
  expect(result.items).toHaveLength(1);
  expect(result.drafts).toHaveLength(2);
  expect(result.drafts[0]).toMatchObject({ baseRevision: 0, input: second.input });
  expect(result.drafts[0].id).not.toBe(second.id);
  expect(result.drafts[0].editId).not.toBe(second.editId);
  expect(result.drafts[1]).toEqual(existing);
  const fullVault = Array.from({ length: 100 }, () => personalDraft());
  const overflowPlan = planPersonalImport(parsed, [formal], fullVault);
  expect(() => applyPersonalImport(overflowPlan, overflowPlan.rows.map(row => ({ id: row.id, action: row.defaultAction })), [formal], fullVault, now)).toThrow('100');
  expect(fullVault).toHaveLength(100);
});
it('rejects malformed draft packages including wrong envelope fields, duplicate IDs and over-capacity', async () => {
  const one = personalDraft(), two = personalDraft();
  const base = JSON.parse(exportPersonalDrafts([one, two]));
  const invalid = [
    { ...base, items: [] },
    { ...base, drafts: [one, one] },
    { ...base, drafts: Array.from({ length: 101 }, (_, i) => ({ ...one, id: crypto.randomUUID(), editId: crypto.randomUUID(), input: { ...one.input, title: String(i) } })) },
  ];
  for (const value of invalid) await expect(readPersonalImport(file(value))).rejects.toThrow();
  expect(() => exportPersonalDrafts([])).toThrow('1–100');
  expect(() => exportPersonalDrafts([one, one])).toThrow('不同');
});
it.each([
  ['unknown field', (v: Record<string, unknown>) => { v.key = 'not accepted'; }],
  ['noncanonical title', (v: Record<string, unknown>) => { v.title = ' padded '; }],
  ['duplicate tags', (v: Record<string, unknown>) => { v.tags = ['x', 'x']; }],
  ['bad id', (v: Record<string, unknown>) => { v.id = 'invalid'; }],
  ['revision cap', (v: Record<string, unknown>) => { v.revision = 1000001; }],
  ['impossible date', (v: Record<string, unknown>) => { v.updatedAt = '2026-02-30T10:00:00.000Z'; }],
  ['backwards date', (v: Record<string, unknown>) => { v.updatedAt = '2020-01-01T10:00:00.000Z'; }],
  ['completion mismatch', (v: Record<string, unknown>) => { v.completedAt = now; }],
  ['note status', (v: Record<string, unknown>) => { v.status = 'open'; }],
  ['missing content', (v: Record<string, unknown>) => { delete v.content; }],
])('rejects malformed record: %s', async (_name, change) => {
  const value = note(); change(value as unknown as Record<string, unknown>); await expect(read([value])).rejects.toThrow();
});
it('rejects invalid envelopes, duplicates, oversized/empty files and malformed UTF-8', async () => {
  const value = note(), root = JSON.parse(exportPersonalItems([value], 'json'));
  for (const invalid of [{ ...root, version: 2 }, { ...root, extra: true }, { ...root, items: [] }, { ...root, items: [value, value] }, { ...root, items: Array(501).fill(value) }]) await expect(readPersonalImport(file(invalid))).rejects.toThrow();
  await expect(readPersonalImport(new Blob([]) as unknown as globalThis.Blob)).rejects.toThrow('16 MiB');
  await expect(readPersonalImport(new Blob([new Uint8Array([0xff])]) as unknown as globalThis.Blob)).rejects.toThrow('UTF-8');
  const arrayBuffer = vi.fn(); await expect(readPersonalImport({ size: MAX_PERSONAL_IMPORT_BYTES + 1, arrayBuffer } as unknown as globalThis.Blob)).rejects.toThrow('16 MiB'); expect(arrayBuffer).not.toHaveBeenCalled();
});
it('rejects malformed draft timezone, unknown keys and invalid input enums', async () => {
  const d = personalDraft();
  for (const invalid of [{ ...d, timezone: 'not/a/timezone' }, { ...d, unknown: true }, { ...d, input: { ...d.input, status: 'bad' } }, { ...d, input: null }]) await expect(readPersonalImport(file(invalid))).rejects.toThrow();
});
it('defaults duplicates and similar content to skip, including duplicates within a file', () => {
  const existing = note(), newItem = note({ content: '新正文' }), similar = { ...existing, id: crypto.randomUUID() }, repeated = { ...newItem, id: crypto.randomUUID() };
  const plan = planPersonalImport(data([{ ...existing, revision: 50 }, similar, newItem, repeated]), [existing], []);
  expect(plan.rows.map(r => [r.status, r.defaultAction])).toEqual([['duplicate', 'skip'], ['similar', 'skip'], ['new', 'add'], ['similar', 'skip']]);
});
it('protects draft and kind conflicts; otherwise replacement keeps local identity and advances local revision', () => {
  const existing = note({ revision: 9, createdAt: '2020-01-01T10:00:00.000Z' }), source = { ...existing, content: '文件新正文', revision: 1, createdAt: now, archivedAt: now };
  for (const drafts of [[personalDraft(existing)]]) {
    const plan = planPersonalImport(data([source]), [existing], drafts);
    expect(plan.rows[0].status).toBe('draft-conflict');
    expect(() => applyPersonalImport(plan, [{ id: source.id, action: 'replace' }], [existing], drafts, now)).toThrow('受保护');
  }
  const typed = planPersonalImport(data([note({ ...source, kind: 'todo', dueAt: null, status: 'open', priority: 'normal' })]), [existing], []);
  expect(typed.rows[0]).toMatchObject({ status: 'kind-conflict', actions: ['skip', 'copy'] });
  const plan = planPersonalImport(data([source]), [existing], []);
  const result = applyPersonalImport(plan, [{ id: source.id, action: 'replace' }], [existing], [], '2025-01-01T10:00:00.000Z');
  expect(result.items).toEqual([{ ...source, revision: 10, createdAt: existing.createdAt, updatedAt: now }]); expect(existing.content).toBe('原始正文');
});
it('merges only explicitly selected same-kind fields while preserving local identity and revision history', () => {
  const existing = note({ revision: 8, title: '本机标题', content: '本机正文', tags: ['本机'], createdAt: '2020-01-01T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z', archivedAt: null });
  const source = { ...existing, title: '文件标题', content: '文件正文', tags: ['文件'], revision: 2, createdAt: now, updatedAt: '2026-09-25T10:00:00.000Z', archivedAt: now };
  const plan = planPersonalImport(data([source]), [existing], []);
  expect(plan.rows[0].actions).toContain('merge');
  const result = applyPersonalImport(plan, [{ id: source.id, action: 'merge', mergeFields: ['title', 'tags'] }], [existing], [], now);
  expect(result.items[0]).toEqual({ ...existing, title: '文件标题', tags: ['文件'], revision: 9, updatedAt: now });
  expect(result.result).toMatchObject({ merged: 1, replaced: 0 });
  expect(existing).toMatchObject({ title: '本机标题', content: '本机正文' });
});
it('merges todo state as a coupled group and rejects empty, duplicate, or incompatible field selections', () => {
  const existing = note({ kind: 'todo', status: 'open', priority: 'normal', dueAt: null, completedAt: null });
  const source = { ...existing, status: 'done' as const, priority: 'high' as const, dueAt: now, completedAt: now, content: '导入版本' };
  const plan = planPersonalImport(data([source]), [existing], []);
  const merged = applyPersonalImport(plan, [{ id: source.id, action: 'merge', mergeFields: ['content', 'todo'] }], [existing], [], now).items[0];
  expect(merged).toMatchObject({ content: '导入版本', status: 'done', priority: 'high', dueAt: now, completedAt: now, revision: 2 });
  for (const mergeFields of [[], ['title', 'title'], ['not-a-field']]) {
    expect(() => applyPersonalImport(plan, [{ id: source.id, action: 'merge', mergeFields: mergeFields as never }], [existing], [], now)).toThrow();
  }
  const noteCurrent = note(), notePlan = planPersonalImport(data([note({ ...noteCurrent, content: 'other' })]), [noteCurrent], []);
  expect(() => applyPersonalImport(notePlan, [{ id: noteCurrent.id, action: 'merge', mergeFields: ['todo'] as never }], [noteCurrent], [], now)).toThrow();
});
it('copies without replacing and refuses exhausted local revisions', () => {
  const existing = note({ revision: 1000000 }), source = { ...existing, content: 'foreign' }, plan = planPersonalImport(data([source]), [existing], []);
  expect(plan.rows[0].actions).toEqual(['skip', 'copy']);
  const result = applyPersonalImport(plan, [{ id: source.id, action: 'copy' }], [existing], [], now);
  expect(result.items[0]).toMatchObject({ content: 'foreign', revision: 1 }); expect(result.items[0].id).not.toBe(existing.id); expect(result.items[1]).toEqual(existing);
});
it('rejects stale full values and incomplete/forged choices before applying anything', () => {
  const existing = note(), source = note({ content: 'new' }), plan = planPersonalImport(data([source]), [existing], []);
  expect(() => applyPersonalImport(plan, [{ id: source.id, action: 'add' }], [{ ...existing, content: 'changed without revision' }], [], now)).toThrow('已变化');
  for (const choices of [[], [{ id: crypto.randomUUID(), action: 'add' as const }], [{ id: source.id, action: 'replace' as const }]]) expect(() => applyPersonalImport(plan, choices, [existing], [], now)).toThrow();
});
it('enforces record and draft capacity atomically', () => {
  const items = Array.from({ length: 500 }, () => note()), source = note({ title: 'different' }), plan = planPersonalImport(data([source]), items, []);
  expect(() => applyPersonalImport(plan, [{ id: source.id, action: 'add' }], items, [], now)).toThrow('500'); expect(items).toHaveLength(500);
  const drafts = Array.from({ length: 100 }, () => personalDraft()), d = personalDraft(), draftPlan = planPersonalImport({ kind: 'draft', draft: d }, [], drafts);
  expect(() => applyPersonalImport(draftPlan, [{ id: d.id, action: 'copy' }], [], drafts, now)).toThrow('100'); expect(drafts).toHaveLength(100);
});
