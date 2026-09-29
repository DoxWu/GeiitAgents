import { Blob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, VAULT_STORAGE_KEY } from '../workbenchStore';
import { exportPersonalItems, type PersonalItem } from '@/personal/items';
import { personalDraft } from '@/personal/itemDraft';
import { PrivateVault } from '@/services/privateVault';

const password = 'import-test-fixture', now = '2026-09-29T10:00:00.000Z';
function note(): PersonalItem { return { kind: 'note', title: '导入机密笔记', content: '不应出现在明文存储', tags: [], id: crypto.randomUUID(), revision: 2, createdAt: now, updatedAt: now, completedAt: null }; }
function blob(value: string) { return new Blob([value]) as unknown as globalThis.Blob; }
async function prepare(items: PersonalItem[]) { await store.getState().preparePersonalImport(blob(exportPersonalItems(items, 'json')), 'notes.json'); return store.getState().personalImportPreview!; }
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock(password); });
afterEach(async () => { vi.restoreAllMocks(); await store.getState().lock(); vi.unstubAllGlobals(); });

it('previews without mutation, encrypts confirmed records and restores only committed data after lock', async () => {
  const item = note(), preview = await prepare([item]); expect(store.getState().personalItems).toEqual([]);
  await store.getState().commitPersonalImport(preview.id, [{ id: item.id, action: 'add' }]);
  expect(store.getState().personalImportResult).toMatchObject({ added: 1, saved: true }); expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain(item.content);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().personalItems).toEqual([item]); expect(store.getState().personalImportPreview).toBeNull(); expect(store.getState().personalImportResult).toBeNull();
});
it('rejects stale preview and protects the internal plan from public preview mutations', async () => {
  const item = note(), preview = await prepare([item]); (preview.rows[0].source as PersonalItem).content = 'tampered';
  await store.getState().commitPersonalImport(preview.id, [{ id: item.id, action: 'add' }]); expect(store.getState().personalItems[0].content).toBe(item.content);
  const next = note(), p2 = await prepare([next]); store.setState({ personalItems: [{ ...item, content: 'same revision new value' }] });
  await expect(store.getState().commitPersonalImport(p2.id, [{ id: next.id, action: 'copy' }])).rejects.toThrow('已变化'); expect(store.getState().personalItems).toHaveLength(1);
});
it('consumes a failed copy once, retains memory, and retries storage without duplicating', async () => {
  const item = note(); store.setState({ personalItems: [item] }); const preview = await prepare([item]);
  const failure = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await expect(store.getState().commitPersonalImport(preview.id, [{ id: item.id, action: 'copy' }])).rejects.toThrow('保存失败');
  expect(store.getState().personalImportResult).toMatchObject({ added: 1, saved: false }); const expected = structuredClone(store.getState().personalItems);
  await expect(prepare([item])).rejects.toThrow('重试');
  failure.mockRestore(); await store.getState().retryPersonalImport();
  await expect(store.getState().commitPersonalImport(preview.id, [{ id: item.id, action: 'copy' }])).rejects.toThrow('失效');
  expect(store.getState().personalItems).toEqual(expected); expect(store.getState().personalImportResult?.saved).toBe(true);
  await store.getState().lock(); await store.getState().unlock(password); expect(store.getState().personalItems).toEqual(expected);
});
it('does not double-submit while encryption is pending and clears sensitive preview on lock', async () => {
  const item = note(), preview = await prepare([item]), realSave = PrivateVault.prototype.save;
  let release!: () => void, started!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(PrivateVault.prototype, 'save').mockImplementationOnce(async function (this: PrivateVault, value) { started(); await held; await realSave.call(this, value); });
  const pending = store.getState().commitPersonalImport(preview.id, [{ id: item.id, action: 'add' }]); await ready;
  await expect(store.getState().commitPersonalImport(preview.id, [{ id: item.id, action: 'add' }])).rejects.toThrow('等待'); release(); await pending;
  await store.getState().lock(); expect(store.getState().personalImportPreview).toBeNull(); expect(store.getState().personalItems).toEqual([]);
});
it.each(['cancel', 'lock'] as const)('discards late file reads after %s without disturbing a new preview', async action => {
  const item = note(); let release!: (bytes: ArrayBuffer) => void, started!: () => void;
  const held = new Promise<ArrayBuffer>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  const pending = store.getState().preparePersonalImport({ size: 100, arrayBuffer: () => { started(); return held; } } as globalThis.Blob, 'late.json'); await ready;
  if (action === 'lock') { await store.getState().lock(); await store.getState().unlock(password); } else store.getState().cancelPersonalImport();
  const next = await prepare([note()]); release(await blob(exportPersonalItems([item], 'json')).arrayBuffer()); await pending;
  expect(store.getState().personalImportPreview?.id).toBe(next.id); expect(store.getState().personalItems).toEqual([]); expect(store.getState().personalImportBusy).toBe(false);
});
it('persists restored independent raw drafts without overwriting the existing edit', async () => {
  const item = note(), d = personalDraft(item); d.input.title = ''; d.dueText = 'unfinished'; d.tagsText = 'raw，raw，';
  store.getState().stagePersonalDraft(d); await store.getState().flushPersonalDrafts();
  await store.getState().preparePersonalImport(blob(JSON.stringify(d)), 'draft.json'); const p = store.getState().personalImportPreview!;
  await store.getState().commitPersonalImport(p.id, [{ id: d.id, action: 'copy' }]);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().personalDrafts).toHaveLength(2); expect(store.getState().personalDrafts[1]).toEqual(d);
  expect(store.getState().personalDrafts[0]).toMatchObject({ baseRevision: 0, dueText: 'unfinished', tagsText: 'raw，raw，', input: { title: '' } }); expect(store.getState().personalItems).toEqual([]);
});
