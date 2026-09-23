export interface DiffLine {
  kind: 'equal' | 'add' | 'remove';
  text: string;
  beforeLine?: number;
  afterLine?: number;
}
export interface ArtifactDiff {
  identical: boolean;
  mode: 'exact' | 'coarse' | 'too-large';
  rows: DiffLine[];
  added: number;
  removed: number;
}

// Preserve newline bytes (including CRLF and a missing final newline). Bound
// work before allocating an LCS matrix; comparisons never need a model/server.
export function compareArtifactText(before: string, after: string): ArtifactDiff {
  const result: ArtifactDiff = { identical: before === after, mode: 'exact', rows: [], added: 0, removed: 0 };
  if (result.identical) return result;
  if (before.length + after.length > 400_000) return { ...result, mode: 'too-large' };
  const split = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = split(before), b = split(after);
  if (a.length + b.length > 10000) return { ...result, mode: 'too-large' };
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  let left = 0, right = 0;
  function push(kind: DiffLine['kind']) {
    const row: DiffLine = { kind, text: kind === 'add' ? b[right] : a[left] };
    if (kind !== 'add') row.beforeLine = ++left;
    if (kind !== 'remove') row.afterLine = ++right;
    if (kind === 'add') result.added++;
    if (kind === 'remove') result.removed++;
    result.rows.push(row);
  }
  for (let i = 0; i < prefix; i++) push('equal');
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix;
  if ((n + 1) * (m + 1) > 1_000_000) {
    result.mode = 'coarse';
    for (let i = 0; i < n; i++) push('remove');
    for (let j = 0; j < m; j++) push('add');
  } else {
    const width = m + 1, lengths = new Uint16Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] = a[prefix + i] === b[prefix + j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[prefix + i] === b[prefix + j]) { push('equal'); i++; j++; }
      else if (i < n && (j === m || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) { push('remove'); i++; }
      else { push('add'); j++; }
    }
  }
  for (let i = 0; i < suffix; i++) push('equal');
  return result;
}
