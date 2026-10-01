import { validatePersonalInput, type PersonalInput, type PersonalItem } from './items';
import { wallTime, wallTimeCandidates } from './reminderTime';

export interface PersonalDraft {
  id: string;
  editId: string;
  baseRevision: number;
  input: PersonalInput;
  tagsText: string;
  dueText: string;
  timezone: string;
  updatedAt: string;
}
export function personalDraft(item?: PersonalItem, kind: 'note' | 'todo' = 'todo'): PersonalDraft {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const input: PersonalInput = item ?? (kind === 'note' ? { kind, title: '', content: '', tags: [] } : { kind, title: '', content: '', tags: [], dueAt: null, status: 'open', priority: 'normal' });
  return { id: item?.id ?? crypto.randomUUID(), editId: crypto.randomUUID(), baseRevision: item?.revision ?? 0,
    input: structuredClone(input), tagsText: input.tags.join('，'), dueText: input.kind === 'todo' && input.dueAt ? wallTime(input.dueAt, timezone) : '', timezone, updatedAt: new Date().toISOString() };
}
export function validatePersonalDraft(draft: PersonalDraft) {
  if (!/^[a-f0-9-]{36}$/i.test(draft.id) || !/^[a-f0-9-]{36}$/i.test(draft.editId)
    || !Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0 || !['note', 'todo'].includes(draft.input.kind)
    || typeof draft.input.title !== 'string' || draft.input.title.length > 120 || typeof draft.input.content !== 'string' || draft.input.content.length > 20000
    || typeof draft.tagsText !== 'string' || draft.tagsText.length > 250 || typeof draft.dueText !== 'string' || draft.dueText.length > 32
    || !Number.isFinite(Date.parse(draft.updatedAt)) || draft.timezone.length > 100) throw new Error('草稿内容或长度无效。');
  try { new Intl.DateTimeFormat('en', { timeZone: draft.timezone }).format(); } catch { throw new Error('草稿时区无效。'); }
}
export function exportPersonalDrafts(drafts: PersonalDraft[]): string {
  if (!drafts.length || drafts.length > 100 || new Set(drafts.map(draft => draft.id)).size !== drafts.length) throw new Error('请选择 1–100 条不同的编辑草稿。');
  drafts.forEach(validatePersonalDraft);
  return JSON.stringify({ format: 'geiit.personal-drafts', version: 1, exportedAt: new Date().toISOString(), drafts }, null, 2);
}
export function inputFromDraft(draft: PersonalDraft): PersonalInput {
  validatePersonalDraft(draft);
  const input = { ...draft.input, tags: draft.tagsText.split(/[,，]/) };
  if (input.kind === 'todo') {
    if (!draft.dueText) input.dueAt = null;
    else if (!input.dueAt || wallTime(input.dueAt, draft.timezone) !== draft.dueText) {
      const candidates = wallTimeCandidates(draft.dueText, draft.timezone);
      if (candidates.length !== 1) throw new Error(candidates.length ? '该截止时间因夏令时出现两次，请重新选择。' : '该截止时间不存在，请重新选择。');
      input.dueAt = candidates[0];
    }
  }
  return validatePersonalInput(input);
}
