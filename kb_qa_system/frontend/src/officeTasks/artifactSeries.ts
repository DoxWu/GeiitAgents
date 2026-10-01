import type { WorkArtifact } from '@/types/workbench';

// Parent links distinguish documents, including documents sharing a file name.
// Original tool outputs remain immutable checkpoints for workflow continuation.
export function artifactRoot(artifact: WorkArtifact, artifacts: WorkArtifact[]): string {
  const seen = new Set<string>();
  let current = artifact;
  while (current.parentArtifactId) {
    if (seen.has(current.id)) throw new Error('文档版本链存在循环。');
    seen.add(current.id);
    const parent = artifacts.find(item => item.id === current.parentArtifactId);
    if (!parent || parent.taskId !== artifact.taskId || parent.kind !== artifact.kind) throw new Error('文档版本链不完整。');
    current = parent;
  }
  return current.id;
}

export function artifactSeries(artifact: WorkArtifact, artifacts: WorkArtifact[]): WorkArtifact[] {
  const root = artifactRoot(artifact, artifacts);
  return artifacts.filter(item => item.taskId === artifact.taskId && item.kind === artifact.kind && artifactRoot(item, artifacts) === root)
    .sort((a, b) => b.version - a.version);
}
