import type { RecordedRename } from './apply';
import type { RenamePlan } from './plan';

export interface OrganizerRun {
  id: string;
  directoryName: string;
  kind: 'rename' | 'undo';
  undoOf?: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'needs-attention' | 'undone';
  createdAt: string;
  updatedAt: string;
  changes: RecordedRename[];
  error?: string;
  warnings?: string[];
  retainedFiles?: string[];
}
export function undoPlan(run: OrganizerRun): RenamePlan[] {
  if (run.kind !== 'rename' || run.status !== 'succeeded') throw new Error('仅已确认成功且尚未撤销的整理记录可以撤销。');
  return run.changes.map(item => ({ source: item.target, target: item.source, size: item.size, sha256: item.sha256, status: 'ready' }));
}
