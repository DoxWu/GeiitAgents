import type { VaultData } from '@/types/workbench';
import { checkChart, renderChartSvg } from '@/officeTasks/chart';
import { sha256Text } from '@/officeTasks/document';
import { personalDraft } from '@/personal/itemDraft';
import { reminderForm } from '@/personal/reminderDraft';
import { snapshotText, textFormat } from '@/fileOrganizer/textEdit';

/** Synthetic, using the same constructors as the application. No real keys. */
export async function vaultBackupFixture(): Promise<VaultData> {
  const now = '2026-09-29T00:00:00.000Z', uuid = () => crypto.randomUUID();
  const taskId = uuid(), svgId = uuid(), docId = uuid(), toolId = uuid();
  const input = { title: '季度图表', csv: '季度,收入,成本\nQ1,20,8\nQ2,30,12', categoryColumn: 0, valueColumn: 1, valueColumns: [1, 2], chartType: 'line' as const, unit: '万元' };
  const svg = renderChartSvg(checkChart(input)), markdown = '# 工作总结\n\n- 检查数据\n';
  const item = { id: uuid(), kind: 'todo' as const, title: '工作报告', content: '附件核查', tags: ['工作'], status: 'open' as const, priority: 'high' as const, dueAt: '2030-01-01T00:00:00.000Z', revision: 2, createdAt: now, updatedAt: now, completedAt: null, archivedAt: now };
  const draft = personalDraft(item); draft.input.title = ''; draft.tagsText = '未完成，'; draft.dueText = '2030-';
  const before = await snapshotText('\uFEFF# 原文\r\n', 'a'.repeat(64)), after = await snapshotText('\uFEFF# 修改后\r\n', 'a'.repeat(64));
  const original = { id: 1, request_id: uuid(), revision: 1, todo_id: null, recipient: 'synthetic@example.test', subject: '检查报告', body: '检查附件', timezone: 'Asia/Shanghai', recurrence: 'weekly' as const, next_run_at: '2030-01-01T00:00:00.000Z', last_run_at: null, status: 'active' as const, archived_at: null, created_at: now, updated_at: now };
  return {
    profiles: [{ id: 'local', mode: 'local', name: '合成连接', baseUrl: 'http://127.0.0.1:11434/v1', model: 'synthetic-model', apiKey: 'synthetic-backup-key' }],
    conversations: [{ id: uuid(), profileId: 'deleted-profile', title: '测试对话', updatedAt: now, messages: [{ id: uuid(), role: 'assistant', content: '尚未完成的回答', createdAt: now, finishReason: 'length' }] }],
    taskRuns: [{ id: taskId, type: 'office.tools', officeInput: { title: '工作报告', instruction: '分析 CSV', csv: input.csv }, title: '工作报告', profileId: 'local', instruction: '分析 CSV', status: 'succeeded', createdAt: now, updatedAt: now, toolRunIds: [toolId], artifactIds: [svgId, docId] }],
    toolRuns: [{ id: toolId, taskId, tool: 'office.create_document', status: 'succeeded', callId: uuid(), arguments: '{"title":"工作总结"}', result: '{"ok":true}', outputArtifactId: docId, startedAt: now, finishedAt: now }],
    artifacts: [{ id: svgId, taskId, kind: 'svg', mimeType: 'image/svg+xml', name: '季度图表.svg', version: 1, content: svg, sha256: await sha256Text(svg), createdAt: now }, { id: docId, taskId, kind: 'markdown', mimeType: 'text/markdown', name: '工作报告.md', version: 1, content: markdown, sha256: await sha256Text(markdown), createdAt: now }],
    personalItems: [item], personalDrafts: [draft, personalDraft(undefined, 'note')],
    reminderDrafts: [{ owner: 'synthetic-owner', form: reminderForm(original), original, attempt: { kind: 'edit', id: 1, payload: { revision: 1, subject: '更新报告', status: 'active' } }, conflict: true, updatedAt: now }],
    reminderTemplates: [{ id: uuid(), owner: 'synthetic-owner', name: '报告模板', subject: '检查', body: '复核附件', timezone: 'Asia/Shanghai', recurrence: 'weekly' }],
    organizerRuns: [{ id: uuid(), directoryName: 'synthetic-source', directoryIdentity: 'b'.repeat(64), destinationName: 'synthetic-target', destinationIdentity: 'c'.repeat(64), kind: 'move', status: 'needs-attention', createdAt: now, updatedAt: now, changes: [{ source: '原文.md', target: '整理.md', stage: '.geiit-stage-synthetic.tmp', size: 16, sha256: before.sha256 }], retainedFiles: ['整理.md'], warnings: ['待核验'] }],
    fileEditDraft: { id: uuid(), editId: uuid(), directoryName: 'synthetic-source', directoryIdentity: 'b'.repeat(64), name: '原文.md', before, ...textFormat(before.text), content: '未提交编辑' },
    fileEditVersions: [{ id: uuid(), draftId: uuid(), directoryName: 'synthetic-source', directoryIdentity: 'b'.repeat(64), name: '原文.md', before, after, status: 'succeeded', createdAt: now, updatedAt: now, restoredFrom: 'removed-history', inspection: { outcome: 'after', checkedAt: now } }],
  };
}
