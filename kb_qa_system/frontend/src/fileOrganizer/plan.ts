export interface LocalFileEntry { path: string; name: string; size: number; modifiedAt: number; type: string }
export interface RenamePlan { source: string; target: string; size: number; modifiedAt?: number; sha256?: string; status: 'ready' | 'unchanged' | 'conflict' | 'invalid' }

export const fileNameKey = (name: string) => name.normalize('NFC').toLowerCase();
export function validFileName(name: string): boolean {
  return Boolean(name && name.length <= 240 && name !== '.' && name !== '..' && !/[<>:"/\\|?*]/.test(name)
    && !/[. ]$/.test(name) && !Array.from(name).some(char => char.charCodeAt(0) < 32)
    && !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name));
}

function safeName(value: string): string { return value.normalize('NFC').replace(/[<>:"/\\|?*]/g, '_').split('').map(char => char.charCodeAt(0) < 32 ? '_' : char).join('').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 180) || '未命名文件'; }
export function proposeName(file: LocalFileEntry, prefix: string): string {
  const dot = file.name.lastIndexOf('.'); const ext = dot > 0 ? file.name.slice(dot) : ''; const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
  const date = new Date(file.modifiedAt); const stamp = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '未定日期';
  const safePrefix = prefix.trim() ? safeName(prefix).slice(0, 40) + '_' : '';
  const safeExt = ext ? safeName(ext).toLowerCase().slice(0, 20) : '';
  return `${safePrefix}${stamp}_${safeName(stem).slice(0, 150)}${safeExt}`;
}

export function makeRenamePlan(files: LocalFileEntry[], prefix: string, destinationNames?: string[], preserveNames = false): RenamePlan[] {
  const proposals = files.map(file => ({ file, target: preserveNames ? file.name : proposeName(file, prefix) }));
  const occupied = new Set(destinationNames?.map(fileNameKey) ?? files.map(file => fileNameKey(file.path)));
  const targets = new Set<string>();
  return proposals.map(({ file, target }) => {
    let unique = target, count = 1;
    while (targets.has(fileNameKey(unique))) unique = target.replace(/(\.[^.]+)?$/, `_${++count}$1`);
    targets.add(fileNameKey(unique));
    const same = !destinationNames && unique === file.name;
    const conflict = occupied.has(fileNameKey(unique)) && !same;
    return { source: file.path, target: unique, size: file.size, modifiedAt: file.modifiedAt, status: !validFileName(file.path) || !validFileName(unique) ? 'invalid' : conflict ? 'conflict' : same ? 'unchanged' : 'ready' };
  });
}

export function planMarkdown(plan: RenamePlan[]): string {
  return ['# 文件整理变更清单', '', '| 原路径 | 新文件名 | 大小（字节） | 状态 |', '| --- | --- | ---: | --- |', ...plan.map(item => `| ${item.source.replace(/\|/g, '\\|')} | ${item.target.replace(/\|/g, '\\|')} | ${item.size} | ${item.status} |`), ''].join('\n');
}
