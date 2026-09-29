import type { RecordedRename } from './apply';
import type { OrganizerDirectoryHandle } from './apply';
import type { RenamePlan } from './plan';

export interface OrganizerRun {
  id: string;
  directoryName: string;
  destinationName?: string;
  directoryIdentity?: string;
  destinationIdentity?: string;
  kind: 'rename' | 'move' | 'undo';
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
  if (run.kind === 'undo' || run.status !== 'succeeded') throw new Error('仅已确认成功且尚未撤销的整理记录可以撤销。');
  return run.changes.map(item => ({ source: item.target, target: item.source, size: item.size, sha256: item.sha256, status: 'ready' }));
}
export function assertRunDirectories(run: OrganizerRun, source: OrganizerDirectoryHandle, destination?: OrganizerDirectoryHandle, reverse = false) {
  if (!!run.destinationName !== !!destination) throw new Error(run.destinationName ? '请重新选择记录中的源目录与目标目录。' : '该记录属于目录内整理，请取消跨目录模式。');
  const sourceId = reverse && destination ? run.destinationIdentity : run.directoryIdentity;
  const targetId = reverse ? run.directoryIdentity : run.destinationIdentity;
  if (sourceId && source.identity !== sourceId || destination && targetId && destination.identity !== targetId) throw new Error('所选目录与记录不一致，请按记录重新选择目录。');
}
