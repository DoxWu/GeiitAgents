export interface LocalFileEntry { path: string; name: string; size: number; modifiedAt: number; type: string }
export interface RenamePlan { source: string; target: string; size: number; status: 'ready' | 'unchanged' | 'conflict' | 'invalid' }

function safeName(value: string): string { return value.normalize('NFC').replace(/[<>:"/\\|?*]/g, '_').split('').map(char => char.charCodeAt(0) < 32 ? '_' : char).join('').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 180) || '未命名文件'; }
export function proposeName(file: LocalFileEntry, prefix: string): string {
  const dot = file.name.lastIndexOf('.'); const ext = dot > 0 ? file.name.slice(dot) : ''; const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
  const date = new Date(file.modifiedAt); const stamp = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '未定日期';
  return `${safeName(prefix) ? `${safeName(prefix)}_` : ''}${stamp}_${safeName(stem)}${ext.toLowerCase().slice(0, 20)}`;
}

export function makeRenamePlan(files: LocalFileEntry[], prefix: string): RenamePlan[] {
  const proposals = files.map(file => ({ file, target: proposeName(file, prefix) }));
  const occupied = new Set(files.map(file => file.path));
  const targets = new Map<string, number>();
  return proposals.map(({ file, target }) => {
    const count = targets.get(target) ?? 0; targets.set(target, count + 1);
    const unique = count ? `${target.replace(/(\.[^.]+)?$/, `_${count + 1}$1`)}` : target;
    const same = unique === file.name;
    const conflict = occupied.has(unique) && unique !== file.name;
    return { source: file.path, target: unique, size: file.size, status: conflict ? 'conflict' : same ? 'unchanged' : 'ready' };
  });
}

export function planMarkdown(plan: RenamePlan[]): string {
  return ['# 文件整理变更清单', '', '| 原路径 | 新文件名 | 大小（字节） | 状态 |', '| --- | --- | ---: | --- |', ...plan.map(item => `| ${item.source.replace(/\|/g, '\\|')} | ${item.target.replace(/\|/g, '\\|')} | ${item.size} | ${item.status} |`), ''].join('\n');
}
