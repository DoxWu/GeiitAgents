import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchStore as store, VAULT_STORAGE_KEY } from '../workbenchStore';
import { useAuthStore } from '../authStore';
import { reminderForm, reminderOwner, type ReminderDraft } from '@/personal/reminderDraft';

const password = 'reminder-draft-test';
const user = { id: 71, email: 'draft@example.test' } as NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;
const owner = reminderOwner(user.id, user.email);
function draft(): ReminderDraft { return { owner, form: { ...reminderForm(), subject: '保密提醒草稿', body: '提醒原文', time: '2099-01-01T09:00' }, updatedAt: new Date().toISOString() }; }
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('TextEncoder', TextEncoder); vi.stubGlobal('TextDecoder', TextDecoder);
  localStorage.clear(); useAuthStore.setState({ user, isAuthenticated: true }); await store.getState().unlock(password);
});
afterEach(async () => { vi.restoreAllMocks(); await store.getState().lock(); useAuthStore.setState({ user: null, isAuthenticated: false }); vi.unstubAllGlobals(); });

it('flushes pending debounce on lock and restores encrypted owner-scoped drafts and attempts', async () => {
  const value = draft(); value.attempt = { kind: 'create', payload: { request_id: crypto.randomUUID(), subject: value.form.subject, body: value.form.body, timezone: 'UTC', recurrence: 'once', next_run_at: '2099-01-01T09:00:00Z' } };
  store.getState().stageReminderDraft(value);
  expect(store.getState().reminderDraftSaving).toBe(true);
  await store.getState().lock(); expect(store.getState().reminderDrafts).toEqual([]);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain(value.form.subject);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain(value.attempt.payload.request_id);
  await store.getState().unlock(password);
  expect(store.getState().reminderDrafts).toEqual([value]);
  useAuthStore.setState({ user: { ...user, id: 72 } });
  expect(() => store.getState().stageReminderDraft(value)).toThrow('所属账号');
  await expect(store.getState().removeReminderDraft(owner)).rejects.toThrow('所属账号');
  expect(store.getState().reminderDrafts).toEqual([value]);
});

it('does not acknowledge quota failures and retries only encryption without duplicating a draft', async () => {
  store.getState().stageReminderDraft(draft());
  const fail = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await expect(store.getState().flushReminderDraft()).rejects.toThrow('保存失败');
  expect(store.getState().reminderDraftSaving).toBe(true);
  fail.mockRestore(); await store.getState().flushReminderDraft();
  expect(store.getState().reminderDraftSaving).toBe(false);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().reminderDrafts).toHaveLength(1);
  await store.getState().removeReminderDraft(owner);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().reminderDrafts).toEqual([]);
});

it('stores reusable template content without any schedule or submit identity and enforces owner and limits', async () => {
  const value = { id: crypto.randomUUID(), owner, name: '周报', subject: '提醒', body: '核对内容', timezone: 'Asia/Shanghai', recurrence: 'weekly' as const };
  await store.getState().saveReminderTemplate(value);
  await store.getState().lock(); await store.getState().unlock(password);
  expect(store.getState().reminderTemplates).toEqual([value]);
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain(value.body);
  await expect(store.getState().saveReminderTemplate({ ...value, timezone: 'Invalid/Zone' })).rejects.toThrow('时区');
  await expect(store.getState().saveReminderTemplate({ ...value, owner: 'other' })).rejects.toThrow('所属账号');
  await store.getState().removeReminderTemplate(owner, value.id);
  expect(store.getState().reminderTemplates).toEqual([]);
});

it('keeps the last submission checkpoint in memory when clearing it cannot be encrypted', async () => {
  const value = draft(); store.getState().stageReminderDraft(value); await store.getState().flushReminderDraft();
  const fail = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await expect(store.getState().removeReminderDraft(owner)).rejects.toThrow('保存失败');
  expect(store.getState().reminderDrafts).toEqual([value]);
  fail.mockRestore(); await store.getState().removeReminderDraft(owner);
  expect(store.getState().reminderDrafts).toEqual([]);
});
