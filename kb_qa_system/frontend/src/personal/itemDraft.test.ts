import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inputFromDraft, personalDraft } from './itemDraft';
import { exportPersonalItems, isOverdue, selectedPersonalItems, type PersonalItem } from './items';
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
it('resolves the original draft timezone and preserves unchanged sub-minute UTC instants', () => {
  const draft = personalDraft(); draft.input.title = '测试'; draft.timezone = 'Asia/Shanghai'; draft.dueText = '2026-10-01T09:00';
  expect(inputFromDraft(draft)).toMatchObject({ dueAt: '2026-10-01T01:00:00.000Z' });
  if (draft.input.kind === 'todo') draft.input.dueAt = '2026-10-01T01:00:42.123Z';
  expect(inputFromDraft(draft)).toMatchObject({ dueAt: '2026-10-01T01:00:42.123Z' });
  draft.timezone = 'America/New_York'; draft.dueText = '2026-11-01T01:30';
  expect(() => inputFromDraft(draft)).toThrow('两次');
  draft.dueText = '2026-03-08T02:30'; expect(() => inputFromDraft(draft)).toThrow('不存在');
});
it('exports only the exact checked revisions, including archived data and full Markdown', () => {
  const item: PersonalItem = { id: 'a', revision: 1, kind: 'todo', title: '待办', tags: ['标签'], content: '# 完整原文\n```\n数据\n```', dueAt: '2020-01-01T00:00:00.000Z', priority: 'high', status: 'open', createdAt: '', updatedAt: '', completedAt: null, archivedAt: '2026-10-01T00:00:00.000Z' };
  const chosen = selectedPersonalItems([item, { ...item, id: 'b', content: '不应导出' }], [{ id: 'a', revision: 1 }]);
  expect(exportPersonalItems(chosen, 'markdown')).toContain(item.content); expect(exportPersonalItems(chosen, 'markdown')).not.toContain('不应导出');
  expect(JSON.parse(exportPersonalItems(chosen, 'json')).items).toEqual([item]); expect(isOverdue(item)).toBe(false);
  expect(() => selectedPersonalItems([item], [{ id: 'a', revision: 0 }])).toThrow('已改变');
});
