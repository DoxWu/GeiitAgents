import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, VAULT_STORAGE_KEY } from '../workbenchStore';
import { PrivateVault } from '@/services/privateVault';
import { newCompositionShape, type ImageStudioTask } from '@/officeTasks/composition';
import { MAX_VAULT_IMAGE_BYTES } from '@/services/workbenchImages';

vi.mock('@/services/workbenchModel', async original => ({ ...await original<typeof import('@/services/workbenchModel')>(), getAccountModel: vi.fn().mockResolvedValue(null) }));
const password = 'synthetic-image-task-password';
const task = (id: string): ImageStudioTask => ({ id, name: id, updatedAt: new Date().toISOString(), draft: { prompt: id, canvas: { width: 1536, height: 864, background: '#aabbcc' }, shapes: [newCompositionShape(0)], references: [] } });
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); localStorage.clear(); await store.getState().unlock(password); });
afterEach(async () => { await store.getState().lock(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('persists independent task geometry, edits and deletion across encrypted reload', async () => {
  const first = task('first'), second = task('second');
  await store.getState().saveImageTask(first); await store.getState().saveImageTask(second);
  await store.getState().saveImageTask({ ...first, draft: { ...first.draft, prompt: 'updated first' } });
  expect(store.getState().imageTasks.find(t => t.id === second.id)).toEqual(second);
  await store.getState().lock(); expect(store.getState().imageTasks).toEqual([]);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain('updated first');
  await store.getState().unlock(password);
  expect(store.getState().imageTasks.find(t => t.id === first.id)?.draft.prompt).toBe('updated first');
  await store.getState().removeImageTask(first.id);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().imageTasks).toEqual([second]);
});

it('migrates the legacy single draft without deleting its shapes or creating duplicate image data', async () => {
  const first = task('migrated');
  await store.getState().saveImageDraft(first.draft);
  await store.getState().saveImageTask(first, true);
  expect(store.getState().imageDraft).toBeNull();
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().imageTasks).toEqual([first]); expect(store.getState().imageDraft).toBeNull();
});

it('rolls back a failed encrypted task save and leaves other tasks intact', async () => {
  const first = task('saved'); await store.getState().saveImageTask(first);
  vi.spyOn(PrivateVault.prototype, 'save').mockRejectedValueOnce(new Error('synthetic disk failure'));
  await expect(store.getState().saveImageTask(task('failed'))).rejects.toThrow('保存失败');
  expect(store.getState().imageTasks).toEqual([first]);
});

it('flushes the latest debounced editor draft on immediate lock', async () => {
  const latest = task('just-edited');
  store.getState().queueImageTask(latest);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().imageTasks).toEqual([latest]);
});

it('does not resurrect a deleted task from pending autosave', async () => {
  const first = task('deleted'); await store.getState().saveImageTask(first);
  store.getState().queueImageTask(first); await store.getState().removeImageTask(first.id);
  await store.getState().flushImageTask();
  expect(store.getState().imageTasks).toEqual([]);
});

it('rejects a 51st task and rolls back failed deletion', async () => {
  const tasks = Array.from({ length: 50 }, (_, index) => task(`task-${index}`));
  store.setState({ imageTasks: tasks });
  await expect(store.getState().saveImageTask(task('overflow'))).rejects.toThrow('50');
  vi.spyOn(PrivateVault.prototype, 'save').mockRejectedValueOnce(new Error('synthetic disk failure'));
  await expect(store.getState().removeImageTask(tasks[0].id)).rejects.toThrow('保存失败');
  expect(store.getState().imageTasks).toEqual(tasks);
});

it('counts images across every task before admitting more materials', async () => {
  vi.spyOn(PrivateVault.prototype, 'save').mockResolvedValue(undefined);
  const bytes = new Uint8Array(1_500_000); bytes.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  const image = { name: 'synthetic.png', mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`, bytes: bytes.length };
  const withImage = (id: string) => { const value = task(id); value.draft.result = image; return value; };
  // Synthetic existing accounting at the boundary, without allocating 128 MB
  // in every ordinary store test. The new image still receives full validation.
  store.setState({ conversations: [{ id: 'budget', profileId: '', title: '', updatedAt: new Date().toISOString(), messages: [{ id: 'budget', role: 'user', content: '', createdAt: new Date().toISOString(), images: [{ ...image, bytes: MAX_VAULT_IMAGE_BYTES - image.bytes * 5 }] }] }] });
  for (let i = 0; i < 5; i++) await store.getState().saveImageTask(withImage(`image-${i}`));
  await expect(store.getState().saveImageTask(withImage('overflow'))).rejects.toThrow('128 MiB');
  expect(store.getState().imageTasks).toHaveLength(5);
});
