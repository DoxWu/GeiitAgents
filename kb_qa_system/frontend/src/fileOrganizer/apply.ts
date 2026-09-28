import type { RenamePlan } from "./plan";

export interface OrganizerDirectoryEntry {
  kind: string;
  name: string;
  getFile?: () => Promise<File>;
}

export interface OrganizerWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

export interface OrganizerFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<OrganizerWritable>;
}

export interface OrganizerDirectoryHandle {
  values(): AsyncIterable<OrganizerDirectoryEntry>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OrganizerFileHandle>;
  removeEntry(name: string): Promise<void>;
}

async function readEntries(directory: OrganizerDirectoryHandle) {
  const entries = new Map<string, OrganizerDirectoryEntry>();
  for await (const entry of directory.values()) entries.set(entry.name, entry);
  return entries;
}

async function writeFile(handle: OrganizerFileHandle, file: Blob) {
  const writer = await handle.createWritable();
  try {
    await writer.write(file);
    await writer.close();
  } catch (error) {
    try { await writer.close(); } catch { /* preserve the original write error */ }
    throw error;
  }
}

/**
 * Apply a flat-directory rename plan without overwriting an existing entry.
 * Files are copied to hidden staging entries first so a failed target write can
 * restore any source already removed during the final cleanup phase.
 */
export async function applyRenamePlan(directory: OrganizerDirectoryHandle, plan: RenamePlan[]): Promise<void> {
  const ready = plan.filter(item => item.status === "ready");
  if (!ready.length) return;
  const entries = await readEntries(directory);
  const sourceNames = new Set(ready.map(item => item.source));
  const targetNames = new Set<string>();
  for (const item of ready) {
    if (!entries.has(item.source) || entries.get(item.source)?.kind !== "file") throw new Error(`目录内容已改变：${item.source}`);
    if (item.source === item.target || targetNames.has(item.target)) throw new Error("整理计划包含重复目标文件名，请重新生成清单。");
    if (entries.has(item.target) && !sourceNames.has(item.target)) throw new Error("检测到目标文件名冲突，请重新读取目录后再试。");
    if (entries.has(item.target) && sourceNames.has(item.target)) throw new Error("不支持会互相交换的文件名，请分两次整理。");
    targetNames.add(item.target);
  }

  const transaction = crypto.randomUUID().replace(/-/g, "");
  const staged = ready.map((item, index) => ({ item, name: `.geiit-stage-${transaction}-${index}` }));
  if (staged.some(entry => entries.has(entry.name))) throw new Error("目录中已有整理临时文件，请重新读取目录后再试。");
  const originals = new Map<string, File>();
  for (const { item } of staged) originals.set(item.source, await entries.get(item.source)!.getFile!());
  const createdTargets: string[] = [];
  const createdStages: string[] = [];
  const removedSources: string[] = [];
  try {
    for (const { item, name } of staged) {
      await writeFile(await directory.getFileHandle(name, { create: true }), originals.get(item.source)!);
      createdStages.push(name);
    }
    for (const { item } of staged) {
      await writeFile(await directory.getFileHandle(item.target, { create: true }), originals.get(item.source)!);
      createdTargets.push(item.target);
    }
    for (const { item } of staged) {
      await directory.removeEntry(item.source);
      removedSources.push(item.source);
    }
    for (const name of createdStages) await directory.removeEntry(name);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const source of removedSources) {
      try { await writeFile(await directory.getFileHandle(source, { create: true }), originals.get(source)!); } catch (cause) { rollbackErrors.push(cause); }
    }
    for (const target of createdTargets) {
      try { await directory.removeEntry(target); } catch (cause) { rollbackErrors.push(cause); }
    }
    for (const name of createdStages) {
      try { await directory.removeEntry(name); } catch (cause) { rollbackErrors.push(cause); }
    }
    if (rollbackErrors.length) throw new Error("文件整理失败，自动回滚也未完成，请重新读取目录后人工检查。");
    throw error;
  }
}
