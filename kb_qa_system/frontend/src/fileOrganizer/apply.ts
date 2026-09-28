import { fileNameKey, validFileName, type RenamePlan } from './plan';

export interface OrganizerDirectoryEntry { kind: string; name: string; getFile?: () => Promise<File> }
export interface OrganizerWritable { write(data: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }
export interface OrganizerFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<OrganizerWritable>;
  isSameEntry?(other: OrganizerFileHandle): Promise<boolean>;
}
export interface OrganizerDirectoryHandle {
  name?: string;
  values(): AsyncIterable<OrganizerDirectoryEntry>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OrganizerFileHandle>;
  removeEntry(name: string): Promise<void>;
}
export interface RecordedRename { source: string; target: string; size: number; sha256: string; stage: string }
export interface RenamePreparation { id: string; changes: RecordedRename[] }
export interface RenameResult extends RenamePreparation { retainedFiles: string[]; warnings: string[] }
export class OrganizerRecoveryError extends Error {
  constructor(readonly retainedFiles: string[], readonly cause: unknown) {
    super('整理未完成，部分副本已保留。请勿删除暂存文件，先检查目录和执行记录。');
  }
}
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_BATCH_BYTES = 256 * 1024 * 1024;
let running = false;

/** Read-only reconciliation; it never guesses which partial operations to replay. */
export async function inspectRenameOutcome(directory: OrganizerDirectoryHandle, changes: RecordedRename[]): Promise<{ outcome: 'applied' | 'not-applied' | 'mixed'; retainedFiles: string[] }> {
  return exclusively(() => inspect(directory, changes));
}
async function inspect(directory: OrganizerDirectoryHandle, changes: RecordedRename[]): Promise<{ outcome: 'applied' | 'not-applied' | 'mixed'; retainedFiles: string[] }> {
  if (!changes.length || changes.length > 500) throw new Error('整理记录无效。');
  const current = await entries(directory);
  let applied = true, original = true;
  const retainedFiles: string[] = [];
  for (const item of changes) {
    if (!validFileName(item.source) || !validFileName(item.target) || !validFileName(item.stage)) throw new Error('整理记录包含无效文件名。');
    const check = async (name: string) => {
      if (current.get(fileNameKey(name))?.kind !== 'file') return false;
      return matches(await directory.getFileHandle(name), item);
    };
    applied = applied && !current.has(fileNameKey(item.source)) && await check(item.target);
    original = original && !current.has(fileNameKey(item.target)) && await check(item.source);
    if (current.has(fileNameKey(item.stage))) retainedFiles.push(item.stage);
  }
  return { outcome: applied ? 'applied' : original ? 'not-applied' : 'mixed', retainedFiles };
}

async function entries(directory: OrganizerDirectoryHandle) {
  const result = new Map<string, OrganizerDirectoryEntry>();
  for await (const entry of directory.values()) result.set(fileNameKey(entry.name), entry);
  return result;
}
async function fileIfPresent(directory: OrganizerDirectoryHandle, name: string) {
  try { return await directory.getFileHandle(name); }
  catch (error) { if ((error as DOMException).name === 'NotFoundError') return null; throw error; }
}
async function digest(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new Error('单个文件最多 64 MiB，请分开处理较大文件。');
  const bytes = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}
async function matches(handle: OrganizerFileHandle, item: RecordedRename) {
  const file = await handle.getFile();
  return file.size === item.size && await digest(file) === item.sha256;
}
async function writeFile(handle: OrganizerFileHandle, file: Blob) {
  const writer = await handle.createWritable();
  try { await writer.write(file); await writer.close(); }
  catch (error) {
    // close() commits a writable; never commit again after a failed write.
    try { await writer.abort?.(); } catch { /* Report the original error. */ }
    throw error;
  }
}
interface OwnedFile { name: string; handle: OrganizerFileHandle; complete: boolean; item: RecordedRename }
async function createOwned(directory: OrganizerDirectoryHandle, name: string, item: RecordedRename, owned: OwnedFile[]) {
  if ((await entries(directory)).has(fileNameKey(name))) throw new Error('检测到目标文件名冲突：' + name);
  const handle = await directory.getFileHandle(name, { create: true });
  const created = { name, handle, complete: false, item }; owned.push(created);
  // File System Access has no exclusive-create primitive. Stop on unexpected
  // data; do not claim atomicity against other applications.
  if ((await handle.getFile()).size !== 0) throw new Error('目标文件已被其他程序写入：' + name);
  return created;
}
async function removeOwned(directory: OrganizerDirectoryHandle, owned: OwnedFile) {
  const current = await fileIfPresent(directory, owned.name);
  if (!current) return;
  if (owned.handle.isSameEntry && !await owned.handle.isSameEntry(current)) throw new Error('文件已被替换，保留现场。');
  if (owned.complete ? !await matches(current, owned.item) : (await current.getFile()).size !== 0) throw new Error('文件内容已改变，保留现场。');
  await directory.removeEntry(owned.name);
}

/** Compensating batch, not an OS transaction. Persist metadata before writes.
 * Retain staged files until commit or verified restoration of each source. */
export async function applyRenamePlan(directory: OrganizerDirectoryHandle, plan: RenamePlan[], options: {
  signal?: AbortSignal;
  beforeWrite?: (prepared: RenamePreparation) => Promise<void>;
} = {}): Promise<RenameResult> {
  const snapshot = plan.filter(item => item.status === 'ready').map(item => ({ ...item }));
  return exclusively(() => apply(directory, snapshot, options));
}

async function exclusively<T>(operation: () => Promise<T>): Promise<T> {
  const execute = async (): Promise<T> => {
    if (running) throw new Error('已有文件整理正在运行，请稍后再试。');
    running = true;
    try { return await operation(); }
    finally { running = false; }
  };
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('geiit-file-organizer', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('其他窗口正在整理文件，请稍后再试。');
    return execute();
  });
  return execute();
}

async function apply(directory: OrganizerDirectoryHandle, ready: RenamePlan[], options: {
  signal?: AbortSignal; beforeWrite?: (prepared: RenamePreparation) => Promise<void>;
}): Promise<RenameResult> {
  const guard = () => { if (options.signal?.aborted) throw new DOMException('文件整理已取消。', 'AbortError'); };
  guard();
  if (!ready.length || ready.length > 500) throw new Error('每次请选择 1–500 个可整理文件。');
  const initial = await entries(directory), sources = new Set<string>(), targets = new Set<string>();
  for (const item of ready) {
    if (!validFileName(item.source) || !validFileName(item.target)) throw new Error('仅支持安全的单层文件名，请重新生成清单。');
    const source = fileNameKey(item.source), target = fileNameKey(item.target);
    if (sources.has(source) || targets.has(target) || source === target) throw new Error('整理计划包含重复文件名或仅大小写变化。');
    if (initial.get(source)?.kind !== 'file' || initial.get(source)?.name !== item.source) throw new Error('目录内容已改变：' + item.source);
    if (initial.has(target)) throw new Error('检测到目标文件名冲突：' + item.target);
    sources.add(source); targets.add(target);
  }
  const prepared: RenamePreparation = { id: crypto.randomUUID(), changes: [] };
  let total = 0;
  for (const [index, item] of ready.entries()) {
    guard();
    const file = await (await directory.getFileHandle(item.source)).getFile();
    if (file.size !== item.size || item.modifiedAt !== undefined && file.lastModified !== item.modifiedAt) throw new Error('源文件自预览后已改变：' + item.source);
    total += file.size;
    if (total > MAX_BATCH_BYTES) throw new Error('单次整理最多 256 MiB，请分批处理。');
    const sha256 = await digest(file);
    if (item.sha256 !== undefined && sha256 !== item.sha256) throw new Error('文件内容已改变，不能撤销：' + item.source);
    prepared.changes.push({ source: item.source, target: item.target, size: file.size, sha256, stage: '.geiit-stage-' + prepared.id + '-' + index });
  }
  guard(); await options.beforeWrite?.(structuredClone(prepared)); guard();
  const stages: OwnedFile[] = [], targetsOwned: OwnedFile[] = [], deletionAttempts = new Set<string>();
  try {
    for (const item of prepared.changes) {
      guard(); const source = await directory.getFileHandle(item.source);
      if (!await matches(source, item)) throw new Error('源文件已改变：' + item.source);
      const stage = await createOwned(directory, item.stage, item, stages);
      await writeFile(stage.handle, await source.getFile());
      if (!await matches(stage.handle, item)) throw new Error('暂存校验失败。');
      stage.complete = true;
    }
    for (const stage of stages) {
      guard(); const target = await createOwned(directory, stage.item.target, stage.item, targetsOwned);
      await writeFile(target.handle, await stage.handle.getFile());
      if (!await matches(target.handle, stage.item)) throw new Error('目标校验失败。');
      target.complete = true;
    }
    for (const item of prepared.changes) {
      guard();
      if (!await matches(await directory.getFileHandle(item.source), item) || !await matches(await directory.getFileHandle(item.target), item)) throw new Error('目录在执行中被修改，已停止删除源文件。');
      deletionAttempts.add(item.source); // removeEntry may delete and then reject.
      await directory.removeEntry(item.source);
    }
  } catch (error) {
    const retained = new Set<string>(), unsafe = new Set<string>();
    for (const stage of stages) {
      const item = stage.item;
      try {
        let source = await fileIfPresent(directory, item.source);
        if (!source && deletionAttempts.has(item.source)) {
          if (!stage.complete || !await matches(stage.handle, item)) throw new Error('暂存副本不可用。');
          const restored = await createOwned(directory, item.source, item, []);
          await writeFile(restored.handle, await stage.handle.getFile()); source = restored.handle;
        }
        if (!source || !await matches(source, item)) throw new Error('源文件未恢复或已被其他程序改变。');
      } catch { unsafe.add(item.source); }
    }
    for (const owned of [...targetsOwned, ...stages]) {
      if (unsafe.has(owned.item.source)) { retained.add(owned.name); continue; }
      try { await removeOwned(directory, owned); } catch { retained.add(owned.name); }
    }
    if (unsafe.size || retained.size) throw new OrganizerRecoveryError([...retained], error);
    throw error;
  }
  // Commit reached. Cleanup failure is a warning, never roll back after a stage
  // has been deleted: all renamed files already hold verified data.
  const retainedFiles: string[] = [];
  for (const stage of stages) { try { await removeOwned(directory, stage); } catch { retainedFiles.push(stage.name); } }
  return { ...prepared, retainedFiles, warnings: retainedFiles.length ? ['整理已完成，但有暂存副本未能清理，请核对后手动清理。'] : [] };
}
