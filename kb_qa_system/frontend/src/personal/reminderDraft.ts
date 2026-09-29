import type { ReminderRecurrence, ServerReminder } from '@/api/personal';
import { API_BASE_URL } from '@/utils/constants';
import { wallTime } from './reminderTime';

export interface ReminderFields { subject: string; body: string; timezone: string; recurrence: ReminderRecurrence; next_run_at: string }
export type ReminderEdit = Partial<ReminderFields> & { status?: 'active' };
export interface ReminderForm { subject: string; body: string; timezone: string; time: string; recurrence: ReminderRecurrence; selected: string; reactivate: boolean }
export type ReminderAttempt = { kind: 'create'; payload: ReminderFields & { request_id: string } } | { kind: 'edit'; id: number; payload: ReminderEdit & { revision: number } };
export interface ReminderDraft { owner: string; form: ReminderForm; original?: ServerReminder; attempt?: ReminderAttempt; conflict?: boolean; updatedAt: string }
export interface ReminderTemplate { id: string; owner: string; name: string; subject: string; body: string; timezone: string; recurrence: ReminderRecurrence }
export const reminderOwner = (id: number, email: string) => JSON.stringify([API_BASE_URL, id, email.toLowerCase()]);
export function reminderForm(original?: ServerReminder, resume = false): ReminderForm {
  const timezone = original?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return { subject: original?.subject || '', body: original?.body || '', timezone, recurrence: original?.recurrence || 'once',
    time: wallTime(original?.next_run_at || new Date(Date.now() + 3600000).toISOString(), timezone), selected: original?.next_run_at ? new Date(original.next_run_at).toISOString() : '', reactivate: resume };
}
export function validateReminderDraft(draft: ReminderDraft) {
  if (!draft.owner || JSON.stringify(draft).length > 650000 || draft.form.subject.length > 200 || draft.form.body.length > 100000
    || draft.form.timezone.length > 64 || draft.form.time.length > 30 || draft.form.selected.length > 40
    || !['once', 'daily', 'weekly'].includes(draft.form.recurrence)) throw new Error('提醒草稿内容超过限制。');
}
export function validateReminderTemplate(template: ReminderTemplate) {
  if (!/^[a-f0-9-]{36}$/i.test(template.id) || !template.name.trim() || template.name.length > 60 || !template.subject.trim() || template.subject.length > 200
    || !template.body.trim() || template.body.length > 100000 || template.timezone.length > 64 || !['once', 'daily', 'weekly'].includes(template.recurrence)) throw new Error('请填写模板名称、主题和内容，并检查长度。');
  try { new Intl.DateTimeFormat('en', { timeZone: template.timezone }); } catch { throw new Error('模板时区无效。'); }
}
export const REMINDER_PRESETS = [
  { id: 'weekly-report', name: '提交周报', subject: '提交周报', body: '请整理本周进展、风险和下周计划，并提交周报。', recurrence: 'weekly' as const },
  { id: 'meeting', name: '会议准备', subject: '准备会议资料', body: '请核对会议议题、参会人员和待确认事项，准备需要的资料。', recurrence: 'once' as const },
  { id: 'daily-review', name: '每日待办复盘', subject: '检查今日待办', body: '请检查今日待办，更新完成状态，并安排未完成事项的下一步。', recurrence: 'daily' as const },
];
