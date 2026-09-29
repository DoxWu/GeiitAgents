import { expect, it } from 'vitest';
import { selectOrganizerHistory, selectTextBatches, selectTextHistory } from './historyView';
import type { OrganizerRun } from './history';
import type { FileEditVersion } from './textEdit';

const text: FileEditVersion = { id: 'text-a', draftId: 'draft', name: 'résumé.md', directoryName: '资料', status: 'succeeded', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', before: { text: 'private body', sha256: 'a'.repeat(64) }, after: { text: 'new body', sha256: 'b'.repeat(64) } };
it('searches normalized metadata without indexing file bodies and keeps source order immutable', () => {
  const rows = [{ ...text, id: 'z' }, { ...text, id: 'a' }, { ...text, id: 'new', createdAt: '2026-09-29T01:00:00Z' }];
  expect(selectTextHistory(rows, { query: ' RE\u0301SUME\u0301.MD ', status: '' }).map(r => r.id)).toEqual(['new', 'a', 'z']);
  expect(rows.map(r => r.id)).toEqual(['z', 'a', 'new']);
  expect(selectTextHistory(rows, { query: 'private body', status: '' })).toEqual([]);
  expect(selectTextHistory(rows, { query: '资料', status: 'interrupted' })).toEqual([]);
});
it('filters on the same batch member but returns the full retained batch in original index order', () => {
  const a = { ...text, name: 'a.md', batch: { id: 'batch', index: 0, total: 3 } };
  const b: FileEditVersion = { ...text, id: 'text-b', name: 'b.md', status: 'not-started', batch: { id: 'batch', index: 2, total: 3 } };
  expect(selectTextBatches([b, a, text], { query: 'b.md', status: 'not-started' })[0].rows).toEqual([a, b]);
  expect(selectTextBatches([b, a], { query: 'a.md', status: 'not-started' })).toEqual([]);
  expect(selectTextBatches([b, a], { query: 'batch', status: '' })[0].rows).toHaveLength(2);
  expect(b.batch.index).toBe(2);
});
it('finds source, destination, stage and undo references in long organizer histories', () => {
  const run: OrganizerRun = { id: 'move', directoryName: '源目录', destinationName: '目标目录', kind: 'move', status: 'needs-attention', undoOf: 'prior', createdAt: text.createdAt, updatedAt: text.updatedAt, changes: Array.from({ length: 500 }, (_, i) => ({ source: `source-${i}.md`, target: `target-${i}.md`, stage: `.geiit-stage-${i}`, size: 3, sha256: 'a'.repeat(64) })) };
  for (const query of ['source-499', 'TARGET-499', '.geiit-stage-499', '目标目录', 'prior']) expect(selectOrganizerHistory([run], { query, status: 'needs-attention' })).toEqual([run]);
  expect(selectOrganizerHistory([run], { query: 'target-499', status: 'succeeded' })).toEqual([]);
});
