import { validatePersonalInput, type PersonalItem, type PersonalInput } from './items';
import { validatePersonalDraft, type PersonalDraft } from './itemDraft';

export const MAX_PERSONAL_IMPORT_BYTES = 16 * 1024 * 1024;
export type PersonalImportAction = 'skip' | 'add' | 'copy' | 'replace' | 'merge';
export type PersonalImportMergeField = 'title' | 'content' | 'tags' | 'todo' | 'archivedAt';
export type PersonalImportData = { kind: 'records'; exportedAt: string; items: PersonalItem[] } | { kind: 'draft'; draft: PersonalDraft };
export interface PersonalImportRow {
  id: string; title: string; kind: 'note' | 'todo'; status: 'new' | 'duplicate' | 'similar' | 'conflict' | 'draft-conflict' | 'kind-conflict';
  source: PersonalItem | PersonalDraft; current?: PersonalItem; matchedTitle?: string;
  actions: PersonalImportAction[]; defaultAction: PersonalImportAction;
}
export interface PersonalImportPreview { id: string; name: string; kind: 'records' | 'draft'; exportedAt?: string; rows: PersonalImportRow[] }
export interface PersonalImportChoice { id: string; action: PersonalImportAction; mergeFields?: PersonalImportMergeField[] }
export interface PersonalImportResult { added: number; replaced: number; merged: number; drafts: number; skipped: number }
export interface PersonalImportPlan { data: PersonalImportData; rows: PersonalImportRow[]; baseline: string }

function fail(message = '文件格式无效、包含未知字段或超出限制。'): never { throw new Error(message); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, min = 0): asserts value is string {
  if (typeof value !== 'string' || value.length > max || value.length < min || value.includes('\0')) fail();
}
function id(value: unknown) { text(value, 36, 36); if (!/^[a-f0-9-]{36}$/i.test(value)) fail('记录标识无效。'); }
function revision(value: unknown, min = 1) { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > 1000000) fail('记录修订号无效。'); }
function date(value: unknown, nullable = false) {
  if (nullable && value === null) return;
  text(value, 24, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('日期必须是有效的 UTC 时间。');
}
const inputKeys = ['kind', 'title', 'content', 'tags', 'status', 'priority', 'dueAt'];
const metadataKeys = ['id', 'revision', 'createdAt', 'updatedAt', 'completedAt', 'archivedAt'];
function fields(value: Record<string, unknown>, raw = false): PersonalInput {
  text(value.title, 120); text(value.content, 20000);
  if (!Array.isArray(value.tags) || value.tags.length > 8) fail(); value.tags.forEach(tag => text(tag, 30));
  if (!['note', 'todo'].includes(String(value.kind))) fail();
  if (value.kind === 'note') {
    if (['status', 'priority', 'dueAt'].some(key => key in value)) fail('笔记不能包含待办状态字段。');
  } else {
    if (!['open', 'done', 'cancelled'].includes(String(value.status)) || !['normal', 'high', 'low'].includes(String(value.priority))) fail();
    date(value.dueAt, true);
  }
  const input = { kind: value.kind, title: value.title, content: value.content, tags: [...value.tags],
    ...(value.kind === 'todo' ? { status: value.status, priority: value.priority, dueAt: value.dueAt } : {}) } as PersonalInput;
  if (!raw && JSON.stringify(input) !== JSON.stringify(validatePersonalInput(input))) fail('正式记录标题或标签未规范化，请先在原客户端保存。');
  return input;
}
function metadata(value: Record<string, unknown>, optional = false) {
  if (!optional || 'id' in value) id(value.id);
  if (!optional || 'revision' in value) revision(value.revision);
  for (const key of ['createdAt', 'updatedAt', 'completedAt', 'archivedAt']) {
    if (optional && !(key in value) || key === 'archivedAt' && !(key in value)) continue;
    date(value[key], key === 'completedAt' || key === 'archivedAt');
  }
}
function record(value: unknown): PersonalItem {
  const item = object(value, [...inputKeys, ...metadataKeys]); fields(item); metadata(item);
  const result = item as unknown as PersonalItem;
  if (result.createdAt > result.updatedAt || result.completedAt && result.completedAt > result.updatedAt || result.archivedAt && result.archivedAt > result.updatedAt) fail('记录时间顺序无效。');
  if ((result.kind === 'todo' && result.status === 'done') !== Boolean(result.completedAt)) fail('完成状态与完成时间不一致。');
  return structuredClone(result);
}
function draft(value: unknown): PersonalDraft {
  const d = object(value, ['id', 'editId', 'baseRevision', 'input', 'tagsText', 'dueText', 'timezone', 'updatedAt']);
  id(d.id); id(d.editId); revision(d.baseRevision, 0); date(d.updatedAt);
  text(d.tagsText, 250); text(d.dueText, 32); text(d.timezone, 100, 1);
  const input = object(d.input, [...inputKeys, ...metadataKeys]); fields(input, true); metadata(input, true);
  validatePersonalDraft(d as unknown as PersonalDraft);
  return structuredClone(d as unknown as PersonalDraft);
}
export async function readPersonalImport(file: Blob): Promise<PersonalImportData> {
  if (!file.size || file.size > MAX_PERSONAL_IMPORT_BYTES) fail('请选择非空且不超过 16 MiB 的 JSON 文件。');
  const bytes = await file.arrayBuffer(); if (bytes.byteLength > MAX_PERSONAL_IMPORT_BYTES) fail('文件超过 16 MiB。');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('文件不是有效的 UTF-8 JSON。'); }
  if (parsed && typeof parsed === 'object' && 'format' in parsed) {
    const root = object(parsed, ['format', 'version', 'exportedAt', 'items']);
    if (root.format !== 'geiit.personal-records' || root.version !== 1) fail('仅支持本机笔记/待办 v1 JSON；整库加密文件请使用工作台备份入口。');
    date(root.exportedAt);
    if (!Array.isArray(root.items) || !root.items.length || root.items.length > 500) fail('文件需要包含 1–500 条正式记录。');
    const items = root.items.map(record);
    if (new Set(items.map(i => i.id)).size !== items.length) fail('文件内存在重复记录标识，整批未导入。');
    return { kind: 'records', exportedAt: root.exportedAt as string, items };
  }
  return { kind: 'draft', draft: draft(parsed) };
}
function contentKey(item: PersonalItem) {
  return JSON.stringify([item.kind, item.title, item.content, item.tags, item.kind === 'todo' ? [item.status, item.priority, item.dueAt] : null, item.completedAt, item.archivedAt ?? null]);
}
function draftKey(d: PersonalDraft) { return JSON.stringify([fields(d.input as unknown as Record<string, unknown>, true), d.tagsText, d.dueText, d.timezone]); }
export function personalImportBaseline(items: PersonalItem[], drafts: PersonalDraft[]): string {
  // Full values, not just user-supplied revisions: altered/restored rows at the
  // same revision must invalidate the review as well.
  return JSON.stringify([items, drafts]);
}
export function planPersonalImport(data: PersonalImportData, items: PersonalItem[], drafts: PersonalDraft[]): PersonalImportPlan {
  const baseline = personalImportBaseline(items, drafts);
  if (data.kind === 'draft') {
    const duplicate = drafts.find(d => draftKey(d) === draftKey(data.draft));
    return { data, baseline, rows: [{ id: data.draft.id, title: data.draft.input.title, kind: data.draft.input.kind, source: data.draft,
      status: duplicate ? 'duplicate' : 'new', actions: ['skip', 'copy'], defaultAction: duplicate ? 'skip' : 'copy' }] };
  }
  const byId = new Map(items.map(i => [i.id, i])), byContent = new Map(items.map(i => [contentKey(i), i]));
  const occupiedDraftIds = new Set(drafts.map(d => d.id));
  const rows = data.items.map(source => {
    const current = byId.get(source.id), similar = byContent.get(contentKey(source));
    const status: PersonalImportRow['status'] = occupiedDraftIds.has(source.id) ? 'draft-conflict' : current
      ? current.kind !== source.kind ? 'kind-conflict' : contentKey(current) === contentKey(source) ? 'duplicate' : 'conflict'
      : similar ? 'similar' : 'new';
    const actions: PersonalImportAction[] = status === 'new' || status === 'similar' ? ['skip', 'add']
      : status === 'conflict' && current!.revision < 1000000 ? ['skip', 'copy', 'replace', 'merge'] : ['skip', 'copy'];
    if (status === 'new') byContent.set(contentKey(source), source);
    return { id: source.id, title: source.title, kind: source.kind, source, current, status, matchedTitle: similar?.title, actions,
      defaultAction: status === 'new' ? 'add' as const : 'skip' as const };
  });
  return { data, rows, baseline };
}
export function applyPersonalImport(plan: PersonalImportPlan, choices: PersonalImportChoice[], items: PersonalItem[], drafts: PersonalDraft[], now: string) {
  if (personalImportBaseline(items, drafts) !== plan.baseline) fail('本机记录或草稿已变化，请重新预检查后确认。');
  if (choices.length !== plan.rows.length || new Set(choices.map(c => c.id)).size !== choices.length) fail('导入选择与预检查不匹配。');
  const selected = new Map(choices.map(c => [c.id, c]));
  const actions = new Map(choices.map(c => [c.id, c.action]));
  for (const row of plan.rows) {
    const choice = selected.get(row.id)!;
    if (!row.actions.includes(choice.action)) fail('导入动作无效或会覆盖受保护记录。');
    if (choice.action !== 'merge' && choice.mergeFields !== undefined) fail('字段合并选项只能用于合并动作。');
    if (choice.action === 'merge') {
      const validFields: PersonalImportMergeField[] = row.kind === 'todo' ? ['title', 'content', 'tags', 'todo', 'archivedAt'] : ['title', 'content', 'tags', 'archivedAt'];
      if (!choice.mergeFields?.length || new Set(choice.mergeFields).size !== choice.mergeFields.length || choice.mergeFields.some(field => !validFields.includes(field))) fail('请选择至少一个有效的文件字段再合并。');
    }
  }
  const result: PersonalImportResult = { added: 0, replaced: 0, merged: 0, drafts: 0, skipped: 0 };
  let nextItems = [...items], nextDrafts = [...drafts];
  for (const row of plan.rows) {
    const action = actions.get(row.id)!;
    if (action === 'skip') { result.skipped++; continue; }
    if (plan.data.kind === 'draft') {
      const source = plan.data.draft;
      // A foreign base revision is never evidence that overwriting a local edit
      // is safe. Preserve raw input/timezone as a separate, new unsaved record.
      nextDrafts = [{ ...structuredClone(source), id: crypto.randomUUID(), editId: crypto.randomUUID(), baseRevision: 0,
        input: fields(source.input as unknown as Record<string, unknown>, true), updatedAt: now }, ...nextDrafts];
      result.drafts++; continue;
    }
    const source = row.source as PersonalItem;
    if (action === 'replace') {
      const current = row.current!;
      const updated: PersonalItem = { ...structuredClone(source), id: current.id, revision: current.revision + 1, createdAt: current.createdAt,
        updatedAt: [now, current.updatedAt, source.updatedAt].sort().at(-1)! };
      nextItems = nextItems.map(i => i.id === current.id ? updated : i); result.replaced++;
    } else if (action === 'merge') {
      const current = row.current!, mergeFields = selected.get(row.id)!.mergeFields!;
      const merged: PersonalItem = { ...structuredClone(current), revision: current.revision + 1,
        updatedAt: [now, current.updatedAt, source.updatedAt].sort().at(-1)!,
        ...(mergeFields.includes('title') ? { title: source.title } : {}),
        ...(mergeFields.includes('content') ? { content: source.content } : {}),
        ...(mergeFields.includes('tags') ? { tags: [...source.tags] } : {}),
        ...(mergeFields.includes('todo') && source.kind === 'todo' && current.kind === 'todo' ? { status: source.status, priority: source.priority, dueAt: source.dueAt, completedAt: source.completedAt } : {}),
        ...(mergeFields.includes('archivedAt') ? { archivedAt: source.archivedAt } : {}) } as PersonalItem;
      nextItems = nextItems.map(i => i.id === current.id ? merged : i); result.merged++;
    } else {
      nextItems = [{ ...structuredClone(source), ...(action === 'copy' ? { id: crypto.randomUUID(), revision: 1 } : {}) }, ...nextItems]; result.added++;
    }
  }
  if (nextItems.length > 500 || nextDrafts.length > 100) fail('导入后超过 500 条正式记录或 100 条草稿上限，请减少选择。');
  return { items: nextItems, drafts: nextDrafts, result };
}
