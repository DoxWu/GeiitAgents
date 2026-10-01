import { expect, it } from 'vitest';
import { associateTextHistoryWithMoves, selectOrganizerHistory, selectTextBatches, selectTextHistory } from './historyView';
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
it('associates text snapshots with exact source or destination move snapshots only when directory identity is available', () => {
  const source: OrganizerRun = { id: 'move-out', directoryName: '源目录', destinationName: '目标目录', directoryIdentity: 'dir-a', destinationIdentity: 'dir-b', kind: 'move', status: 'succeeded', createdAt: text.createdAt, updatedAt: text.updatedAt, changes: [{ source: 'old.md', target: 'new.md', stage: '.geiit-stage-1', size: 3, sha256: 'b'.repeat(64) }] };
  const editedBeforeMove = { ...text, name: 'old.md', directoryIdentity: 'dir-a', after: { text: 'new body', sha256: 'b'.repeat(64) } };
  const editedAfterMove = { ...text, name: 'new.md', directoryIdentity: 'dir-b', before: { text: 'new body', sha256: 'b'.repeat(64) } };
  expect(associateTextHistoryWithMoves(editedBeforeMove, [source])).toMatchObject([{ run: source, source: 'old.md', target: 'new.md', side: 'source' }]);
  expect(associateTextHistoryWithMoves(editedAfterMove, [source])).toMatchObject([{ run: source, source: 'old.md', target: 'new.md', side: 'target' }]);
  expect(associateTextHistoryWithMoves({ ...editedBeforeMove, directoryIdentity: undefined }, [source])).toEqual([]);
  expect(associateTextHistoryWithMoves({ ...editedBeforeMove, name: 'other.md' }, [source])).toEqual([]);
  expect(associateTextHistoryWithMoves({ ...editedBeforeMove, after: { text: 'other', sha256: 'c'.repeat(64) } }, [source])).toEqual([]);
  const sameSnapshotLater = { ...source, id: 'move-again', createdAt: '2026-09-30T00:00:00Z' };
  expect(associateTextHistoryWithMoves(editedBeforeMove, [source, sameSnapshotLater]).map(item => item.run.id)).toEqual(['move-again', 'move-out']);
  expect(associateTextHistoryWithMoves(editedBeforeMove, [{ ...source, status: 'failed' }])).toEqual([]);
});
