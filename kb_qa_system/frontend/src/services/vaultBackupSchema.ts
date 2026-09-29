import type { VaultData } from '@/types/workbench';
import { validateProfile } from './workbenchModel';
import { sha256Text } from '@/officeTasks/document';
import { validatePersonalInput } from '@/personal/items';
import { validatePersonalDraft } from '@/personal/itemDraft';
import { validateReminderDraft, validateReminderTemplate } from '@/personal/reminderDraft';
import { textBytes, validateDraft, validateTextName, MAX_VERSION_BYTES } from '@/fileOrganizer/textEdit';
import { validFileName } from '@/fileOrganizer/plan';
import { validateWorkflow, validateWorkflowInput } from '@/workflows/definition';

type Check = (value: unknown) => void;
const fail = (): never => { throw new Error('备份内容无效、超限或版本不兼容，当前工作台未更改。'); };
const str = (max: number, min = 0): Check => value => { if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) fail(); };
const num = (max = Number.MAX_SAFE_INTEGER, min = 0): Check => value => { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(); };
const bool: Check = value => { if (typeof value !== 'boolean') fail(); };
const one = (...choices: unknown[]): Check => value => { if (!choices.includes(value)) fail(); };
const optional = (check: Check): Check => value => { if (value !== undefined) check(value); };
const nullable = (check: Check): Check => value => { if (value !== null) check(value); };
const arr = (check: Check, max: number): Check => value => { if (!Array.isArray(value) || value.length > max) fail(); (value as unknown[]).forEach(check); };
const obj = (shape: Record<string, Check>): Check => value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !Object.prototype.hasOwnProperty.call(shape, key))) fail();
  for (const [key, check] of Object.entries(shape)) check(record[key]);
};
const id = str(200, 1), date: Check = value => { str(40, 1)(value); if (!Number.isFinite(Date.parse(value as string))) fail(); };
const hash: Check = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); };
const filename: Check = value => { str(240, 1)(value); if (!validFileName(value as string)) fail(); };
const status = one('running', 'succeeded', 'failed', 'cancelled', 'interrupted');
const profile = obj({ id, name: str(1000, 1), mode: one('relay', 'local'), baseUrl: str(2048, 1), model: str(400, 1), maxTokens: optional(num(2147483647, 1)), apiKey: str(4096) });
const conversation = obj({ id, kind: optional(one('knowledge-answer')), title: str(1000), profileId: str(200), updatedAt: date,
  messages: arr(obj({ id, role: one('user', 'assistant'), content: str(1_000_000), createdAt: date, model: optional(str(1000)), finishReason: optional(one('stop', 'length', 'content_filter', 'tool_calls', 'unknown')) }), 100) });
const documentInput = { title: str(100, 1), instruction: str(10000, 1), sourceName: optional(str(255)), sourceContent: optional(str(100000)) };
const chartInput = obj({ title: str(80, 1), csv: str(100000, 1), categoryColumn: num(11), valueColumn: num(11), valueColumns: optional(arr(num(11), 6)), chartType: one('bar', 'line'), unit: str(20) });
const workflow: Check = value => { validateWorkflow(value); };
const workflowInput: Check = value => { validateWorkflowInput(value); };
const task = obj({ id, type: one('document.generate-markdown', 'chart.generate', 'office.tools', 'workflow.run'), workflow: optional(obj({ definition: workflow, input: workflowInput })), officeInput: optional(obj({ ...documentInput, csv: optional(str(100000)) })), chartInput: optional(chartInput), summary: optional(str(1_000_000)),
  title: str(1000), profileId: str(200), instruction: str(10000), sourceName: optional(str(255)), sourceContent: optional(str(100000)), status, createdAt: date, updatedAt: date, error: optional(str(100000)), toolRunIds: arr(id, 300), artifactIds: arr(id, 50) });
const finishReason = optional(one('stop', 'length', 'content_filter', 'tool_calls', 'unknown'));
const tool = obj({ id, taskId: id, workflowNodeId: optional(id), finishReason, tool: one('model.complete', 'document.edit', 'document.restore', 'document.export-docx', 'chart.check', 'chart.render', 'model.tools', 'office.inspect_csv', 'office.render_chart', 'office.create_document'),
  callId: optional(id), arguments: optional(str(1_000_000)), result: optional(str(1_000_000)), sourceArtifactId: optional(id), previousArtifactId: optional(id), outputArtifactId: optional(id), outputSha256: optional(hash), outputName: optional(str(300)), converterVersion: optional(str(100)), warnings: optional(arr(str(10000), 100)), status, model: optional(str(1000)), startedAt: date, finishedAt: optional(date), error: optional(str(100000)) });
const artifact = obj({ id, taskId: id, finishReason, kind: one('markdown', 'svg'), version: num(50, 1), parentArtifactId: optional(id), restoredFromArtifactId: optional(id), name: str(300, 1), mimeType: one('text/markdown', 'image/svg+xml'), content: str(1_000_001), sha256: hash, createdAt: date });
const itemInput = { kind: one('note', 'todo'), title: str(120), content: str(20000), tags: arr(str(30), 8), status: optional(one('open', 'done', 'cancelled')), priority: optional(one('normal', 'high', 'low')), dueAt: optional(nullable(date)) };
const itemMetadata = { id, revision: num(1_000_000, 1), createdAt: date, updatedAt: date, completedAt: nullable(date), archivedAt: optional(nullable(date)) };
const personalItem = obj({ ...itemInput, ...itemMetadata });
// Draft input may be an exact clone of a formal record in earlier clients.
const personalDraft = obj({ id, editId: id, baseRevision: num(1_000_000), input: obj({ ...itemInput, ...Object.fromEntries(Object.entries(itemMetadata).map(([k, v]) => [k, optional(v)])) }), tagsText: str(250), dueText: str(32), timezone: str(100, 1), updatedAt: date });
const recurrence = one('once', 'daily', 'weekly');
const reminderFields = { subject: str(200), body: str(100000), timezone: str(64), recurrence, next_run_at: date };
const serverReminder = obj({ ...reminderFields, next_run_at: nullable(date), id: num(undefined, 1), request_id: id, revision: num(undefined, 1), todo_id: nullable(num(undefined, 1)), recipient: str(320, 1), status: one('active', 'paused', 'cancelled', 'completed'), last_run_at: nullable(date), created_at: date, updated_at: date });
const attempt: Check = value => {
  const kind = (value as { kind?: string })?.kind;
  if (kind === 'create') obj({ kind: one('create'), payload: obj({ ...reminderFields, request_id: id }) })(value);
  else if (kind === 'edit') obj({ kind: one('edit'), id: num(undefined, 1), payload: obj({ ...Object.fromEntries(Object.entries(reminderFields).map(([k, v]) => [k, optional(v)])), revision: num(undefined, 1), status: optional(one('active')) }) })(value);
  else fail();
};
const reminderDraft = obj({ owner: str(3000, 1), form: obj({ subject: str(200), body: str(100000), timezone: str(64), time: str(30), recurrence, selected: str(40), reactivate: bool }), original: optional(serverReminder), attempt: optional(attempt), conflict: optional(bool), updatedAt: date });
const reminderTemplate = obj({ id, owner: str(3000, 1), name: str(60, 1), subject: str(200, 1), body: str(100000, 1), timezone: str(64, 1), recurrence });
const directory = { directoryName: str(1000, 1), directoryIdentity: optional(hash) };
const organizer = obj({ id, ...directory, destinationName: optional(str(1000, 1)), destinationIdentity: optional(hash), kind: one('rename', 'move', 'undo'), undoOf: optional(id), status: one('running', 'succeeded', 'failed', 'interrupted', 'needs-attention', 'undone'), createdAt: date, updatedAt: date,
  changes: arr(obj({ source: filename, target: filename, stage: filename, size: num(64 * 1024 * 1024), sha256: hash }), 500), error: optional(str(100000)), warnings: optional(arr(str(10000), 100)), retainedFiles: optional(arr(str(1000, 1), 1500)) });
const snapshot = obj({ text: str(256 * 1024), sha256: hash, identity: optional(hash) });
const fileDraft = obj({ id, editId: id, ...directory, name: filename, before: snapshot, content: str(256 * 1024), newline: one('lf', 'crlf', 'cr', 'mixed'), bom: bool, restoredFrom: optional(id), restoreText: optional(str(256 * 1024)) });
const fileVersion = obj({ id, draftId: id, ...directory, name: filename, before: snapshot, after: snapshot, status: one('running', 'succeeded', 'not-applied', 'interrupted', 'needs-attention'), createdAt: date, updatedAt: date, restoredFrom: optional(id), error: optional(str(100000)), inspection: optional(obj({ outcome: one('before', 'after', 'different'), checkedAt: date })) });
const schema = obj({ workflows: optional(arr(workflow, 30)), profiles: arr(profile, 30), conversations: arr(conversation, 5000), taskRuns: optional(arr(task, 100)), toolRuns: optional(arr(tool, 30000)), artifacts: optional(arr(artifact, 5000)),
  personalItems: optional(arr(personalItem, 500)), personalDrafts: optional(arr(personalDraft, 100)), reminderDrafts: optional(arr(reminderDraft, 20)), reminderTemplates: optional(arr(reminderTemplate, 100)), organizerRuns: optional(arr(organizer, 100)), fileEditDraft: optional(nullable(fileDraft)), fileEditVersions: optional(arr(fileVersion, 50)) });

function unique(values: { id: string }[]) { if (new Set(values.map(v => v.id)).size !== values.length) fail(); }
function safeSvg(content: string) {
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(content)) fail();
  const doc = new DOMParser().parseFromString(content, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') fail();
  const elements = new Set(['svg', 'g', 'title', 'desc', 'rect', 'text', 'line', 'polyline', 'circle']);
  const attributes = new Set(['xmlns', 'width', 'height', 'viewBox', 'role', 'aria-labelledby', 'id', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'transform', 'data-series', 'points']);
  for (const node of [doc.documentElement, ...doc.documentElement.querySelectorAll('*')]) {
    if (node.namespaceURI !== 'http://www.w3.org/2000/svg' || !elements.has(node.localName)) fail();
    for (const attr of Array.from(node.attributes)) {
      if (!attributes.has(attr.name) || ['fill', 'stroke'].includes(attr.name) && !/^(?:#[a-f\d]{3,8}|none)$/i.test(attr.value)) fail();
    }
  }
}
/** Validate before any destructive replacement. Unknown fields are rejected,
 * not discarded, so a newer client's data cannot be silently downgraded. */
export async function validateVaultBackup(value: unknown): Promise<VaultData> {
  try {
    schema(value); const data = value as VaultData;
    unique(data.workflows ?? []);
    for (const rows of [data.profiles, data.conversations, data.taskRuns ?? [], data.toolRuns ?? [], data.artifacts ?? [], data.personalItems ?? [], data.personalDrafts ?? [], data.reminderTemplates ?? [], data.organizerRuns ?? [], data.fileEditVersions ?? []]) unique(rows);
    for (const p of data.profiles) { validateProfile(p); if (/[^\x21-\x7e]/.test(p.apiKey)) fail(); }
    for (const c of data.conversations) unique(c.messages);
    for (const p of data.personalItems ?? []) validatePersonalInput(p);
    for (const d of data.personalDrafts ?? []) { validatePersonalDraft(d); if (d.input.kind === 'todo' && (!d.input.status || !d.input.priority || d.input.dueAt === undefined)) fail(); }
    for (const d of data.reminderDrafts ?? []) validateReminderDraft(d);
    if (new Set((data.reminderDrafts ?? []).map(d => d.owner)).size !== (data.reminderDrafts ?? []).length) fail();
    for (const t of data.reminderTemplates ?? []) validateReminderTemplate(t);
    const tasks = new Map((data.taskRuns ?? []).map(t => [t.id, t])), artifacts = new Map((data.artifacts ?? []).map(a => [a.id, a])), tools = new Map((data.toolRuns ?? []).map(t => [t.id, t]));
    for (const t of tasks.values()) {
      if ((t.type === 'workflow.run') !== Boolean(t.workflow)) fail();
      if (t.workflow) {
        const steps = t.toolRunIds.map(id => tools.get(id)).filter(step => step?.workflowNodeId);
        if (new Set(steps.map(step => step!.workflowNodeId)).size !== steps.length) fail();
        if (t.status === 'succeeded' && (steps.length !== t.workflow.definition.nodes.length || steps.some(step => step!.status !== 'succeeded'))) fail();
      }
      if (new Set(t.artifactIds).size !== t.artifactIds.length || new Set(t.toolRunIds).size !== t.toolRunIds.length) fail();
      if (t.artifactIds.some(id => artifacts.get(id)?.taskId !== t.id) || t.toolRunIds.some(id => tools.get(id)?.taskId !== t.id)) fail();
    }
    for (const t of tools.values()) {
      if (t.workflowNodeId) {
        const node = tasks.get(t.taskId)?.workflow?.definition.nodes.find(n => n.id === t.workflowNodeId);
        if (!node || t.tool !== (node.kind === 'generate_document' ? 'model.complete' : `office.${node.kind}`)) fail();
      } else if (tasks.get(t.taskId)?.workflow && t.tool !== 'document.export-docx') fail();
      if (!tasks.get(t.taskId)?.toolRunIds.includes(t.id)) fail();
      for (const reference of [t.sourceArtifactId, t.previousArtifactId, t.outputArtifactId]) {
        if (reference && artifacts.get(reference)?.taskId !== t.taskId) fail();
      }
    }
    for (const a of artifacts.values()) {
      if (!tasks.get(a.taskId)?.artifactIds.includes(a.id) || a.mimeType !== (a.kind === 'svg' ? 'image/svg+xml' : 'text/markdown') || await sha256Text(a.content) !== a.sha256) fail();
      for (const parentId of [a.parentArtifactId, a.restoredFromArtifactId]) if (parentId && (artifacts.get(parentId)?.taskId !== a.taskId || artifacts.get(parentId)!.version >= a.version)) fail();
      if (a.kind === 'svg') safeSvg(a.content);
    }
    const checkSnapshot = async (s: { text: string; sha256: string }) => { textBytes(s.text); if (await sha256Text(s.text) !== s.sha256) fail(); };
    if (data.fileEditDraft) { validateDraft(data.fileEditDraft); await checkSnapshot(data.fileEditDraft.before); }
    let bytes = 0;
    for (const r of data.fileEditVersions ?? []) { validateTextName(r.name); await checkSnapshot(r.before); await checkSnapshot(r.after); bytes += textBytes(r.before.text).length + textBytes(r.after.text).length; }
    if (bytes > MAX_VERSION_BYTES) fail();
    for (const r of data.organizerRuns ?? []) {
      if (!r.changes.length || new Set(r.changes.map(c => c.source)).size !== r.changes.length || new Set(r.changes.map(c => c.target)).size !== r.changes.length || r.changes.some(c => !c.stage.startsWith('.geiit-stage-'))) fail();
    }
    return data;
  } catch { return fail(); }
}
