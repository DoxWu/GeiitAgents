import { compareArtifactText } from '@/officeTasks/artifactDiff';

interface Hunk { start: number; end: number; insert: string[] }
export type ThreeWayMergeResult = { ok: true; text: string } | { ok: false; reason: 'overlap' | 'too-large' };

const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function changes(base: string[], target: string[]): Hunk[] | null {
  const diff = compareArtifactText(base.join(''), target.join(''));
  if (diff.mode !== 'exact') return null;
  const result: Hunk[] = [];
  let cursor = 0, active: Hunk | null = null;
  const flush = () => { if (active) result.push(active); active = null; };
  for (const row of diff.rows) {
    if (row.kind === 'equal') { flush(); cursor++; continue; }
    active ??= { start: cursor, end: cursor, insert: [] };
    if (row.kind === 'remove') { active.end++; cursor++; }
    else active.insert.push(row.text);
  }
  flush(); return result;
}

function sameChange(a: Hunk, b: Hunk) {
  return a.start === b.start && a.end === b.end && a.insert.length === b.insert.length && a.insert.every((line, i) => line === b.insert[i]);
}
function overlaps(a: Hunk, b: Hunk) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

/** Merge only independent line edits; ambiguous overlaps are returned to the editor. */
export function mergeNonOverlappingText(baseText: string, localText: string, remoteText: string): ThreeWayMergeResult {
  const base = lines(baseText), local = lines(localText), remote = lines(remoteText);
  const localChanges = changes(base, local), remoteChanges = changes(base, remote);
  if (!localChanges || !remoteChanges) return { ok: false, reason: 'too-large' };
  const merged = [...localChanges];
  for (const change of remoteChanges) {
    const conflict = merged.find(existing => overlaps(existing, change));
    if (conflict) {
      if (sameChange(conflict, change)) continue;
      return { ok: false, reason: 'overlap' };
    }
    merged.push(change);
  }
  merged.sort((a, b) => a.start - b.start || a.end - b.end);
  const result: string[] = []; let cursor = 0;
  for (const change of merged) {
    if (change.start < cursor) return { ok: false, reason: 'overlap' };
    result.push(...base.slice(cursor, change.start), ...change.insert); cursor = change.end;
  }
  result.push(...base.slice(cursor));
  return { ok: true, text: result.join('') };
}
