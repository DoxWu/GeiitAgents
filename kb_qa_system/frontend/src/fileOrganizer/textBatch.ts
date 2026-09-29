import type { OrganizerDirectoryHandle } from './apply';
import { MAX_TEXT_BYTES, assertTextDirectory, assertVersionCapacity, draftText, snapshotText, textFormat, validateTextName, withTextBatch, type FileEditDraft, type FileEditVersion, type Newline, type TextSnapshot } from './textEdit';

export const MAX_BATCH_FILES = 20;
export interface TextBatchRule { find: string; replacement: string; newline: 'keep' | Exclude<Newline, 'mixed'> }
export interface TextBatchRow { id: string; name: string; matches: number; draft?: FileEditDraft; after?: TextSnapshot; error?: string }
export interface TextBatchPreview { id: string; directoryName: string; mode: 'replace' | 'restore'; rows: TextBatchRow[] }
export interface TextBatchPlan extends TextBatchPreview { baseline: string }
export function validateBatchRule(rule: TextBatchRule) {
  if (!rule.find || rule.find.length > 10000 || rule.replacement.length > 10000 || !['keep', 'lf', 'crlf', 'cr'].includes(rule.newline)) throw new Error('查找内容需要 1–10000 个字符，替换内容最多 10000 字符。');
  if (rule.find.includes('\r') || rule.replacement.includes('\r')) throw new Error('查找/替换使用 LF 换行，输出按文件换行设置处理。');
}
export async function prepareTextBatch(directory: OrganizerDirectoryHandle, names: string[], rule: TextBatchRule | null, versions: FileEditVersion[], acknowledged: boolean, guard: () => void, restoreBatchId?: string): Promise<TextBatchPlan> {
  const restoring = restoreBatchId ? versions.filter(v => v.batch?.id === restoreBatchId) : [];
  if (restoreBatchId && !restoring.length) throw new Error('批次记录不存在。');
  const targets = restoreBatchId ? restoring.map(v => v.name) : names;
  if (!targets.length || targets.length > MAX_BATCH_FILES || new Set(targets.map(n => n.toLowerCase())).size !== targets.length) throw new Error('每批请选择 1–20 个不同的 MD/TXT 文件。');
  targets.forEach(validateTextName);
  if (!restoreBatchId) { if (!rule) throw new Error('缺少替换规则。'); validateBatchRule(rule); }
  const rows: TextBatchRow[] = [], id = crypto.randomUUID(), baseline = JSON.stringify(versions);
  await withTextBatch(async access => {
    for (const name of targets) {
      guard(); const row: TextBatchRow = { id: crypto.randomUUID(), name, matches: 0 };
      try {
        const original = restoring.find(v => v.name === name);
        if (original?.status === 'not-started') throw new Error('此条未执行，无需恢复。');
        if (original) assertTextDirectory(original, directory, acknowledged);
        const before = await access.read(directory, name); guard();
        if (original && (before.identity !== original.before.identity || before.sha256 !== original.after.sha256)) {
          throw new Error(before.sha256 === original.before.sha256 && before.identity === original.before.identity ? '当前已经是原文，无需恢复。' : '当前内容或身份与批次写入版不同；请在单文件历史中核验。');
        }
        const format = textFormat(before.text);
        // Literal split/join avoids regex backtracking and replacement-token expansion.
        const parts = rule ? format.content.split(rule.find) : [];
        row.matches = rule ? parts.length - 1 : 1;
        if (rule && !row.matches) { rows.push(row); continue; }
        if (rule && format.content.length + row.matches * (rule.replacement.length - rule.find.length) > MAX_TEXT_BYTES) throw new Error('替换结果超过单文件 256 KiB 限制。');
        const draft: FileEditDraft = { id: crypto.randomUUID(), editId: crypto.randomUUID(), name, directoryName: directory.name || '所选目录', directoryIdentity: directory.identity, before,
          ...format, content: rule ? parts.join(rule.replacement) : format.content, newline: rule && rule.newline !== 'keep' ? rule.newline : format.newline,
          ...(original ? { restoredFrom: original.id, restoreText: original.before.text } : {}) };
        const after = await snapshotText(draftText(draft), before.identity); guard();
        if (after.sha256 !== before.sha256) { row.draft = draft; row.after = after; }
      } catch (error) { guard(); row.error = error instanceof Error ? error.message : '文件读取失败。'; }
      rows.push(row);
    }
  });
  return { id, directoryName: directory.name || '所选目录', mode: restoreBatchId ? 'restore' : 'replace', rows, baseline };
}
export function batchVersions(plan: TextBatchPlan, selected: string[], existing: FileEditVersion[], now: string): FileEditVersion[] {
  if (JSON.stringify(existing) !== plan.baseline) throw new Error('文本历史已变化，请重新预览批次。');
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error('请选择不同的有效变更。');
  const rows = selected.map(id => plan.rows.find(row => row.id === id));
  if (rows.some(row => !row?.draft || !row.after || row.error)) throw new Error('选择包含无效或过期预览。');
  const result = rows.map((row, index): FileEditVersion => {
    const draft = row!.draft!;
    return { id: crypto.randomUUID(), draftId: draft.id, name: draft.name, directoryName: draft.directoryName, directoryIdentity: draft.directoryIdentity,
      before: draft.before, after: row!.after!, status: 'not-started', createdAt: now, updatedAt: now, restoredFrom: draft.restoredFrom,
      batch: { id: plan.id, index, total: rows.length } };
  });
  const checked = [...existing]; for (const version of result) { assertVersionCapacity(checked, version); checked.push(version); }
  return result;
}
