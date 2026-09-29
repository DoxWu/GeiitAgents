import type { OrganizerDirectoryHandle, OrganizerFileHandle } from './apply';
import { exclusively } from './operationLock';
import { validFileName } from './plan';

export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_VERSION_BYTES = 2 * 1024 * 1024;
export interface TextSnapshot { text: string; sha256: string; identity?: string }
export type Newline = 'lf' | 'crlf' | 'cr' | 'mixed';
export interface FileEditDraft {
  id: string;
  editId: string;
  name: string;
  directoryName: string;
  directoryIdentity?: string;
  before: TextSnapshot;
  content: string;
  newline: Newline;
  bom: boolean;
  restoredFrom?: string;
  restoreText?: string;
}
export interface FileEditVersion {
  id: string;
  draftId: string;
  name: string;
  directoryName: string;
  directoryIdentity?: string;
  before: TextSnapshot;
  after: TextSnapshot;
  batch?: { id: string; index: number; total: number };
  status: 'not-started' | 'running' | 'succeeded' | 'not-applied' | 'interrupted' | 'needs-attention';
  createdAt: string;
  updatedAt: string;
  restoredFrom?: string;
  error?: string;
  inspection?: { outcome: 'before' | 'after' | 'different'; checkedAt: string };
}
const encoder = new TextEncoder();
// Never persisted. Browser handles can detect same-session replacement, but
// cannot identify the original file after the encrypted draft is reloaded.
const readHandles = new WeakMap<TextSnapshot, OrganizerFileHandle>();
export function validateTextName(name: string) {
  if (!validFileName(name) || !/\.(md|txt)$/i.test(name)) throw new Error('仅支持所选目录中的 MD/TXT 文件。');
}
export function textBytes(text: string) {
  // TextEncoder replaces lone surrogates. Reject them instead of changing bytes silently.
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 32 && ![9, 10, 13].includes(code) || code === 127 || code >= 0xd800 && code <= 0xdfff) throw new Error('文本包含二进制控制字符或无效 Unicode。');
  }
  const bytes = encoder.encode(text);
  if (bytes.length > MAX_TEXT_BYTES) throw new Error('文本编辑单文件最多 256 KiB（UTF-8 字节）。');
  return bytes;
}
async function sha(bytes: Uint8Array<ArrayBuffer>) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function snapshotText(text: string, identity?: string): Promise<TextSnapshot> {
  return { text, sha256: await sha(textBytes(text)), ...(identity ? { identity } : {}) };
}
export function textFormat(text: string): { content: string; newline: Newline; bom: boolean } {
  const bom = text.startsWith('\uFEFF'), body = bom ? text.slice(1) : text;
  const styles = new Set(body.match(/\r\n|\r|\n/g) ?? []);
  return { bom, content: body.replace(/\r\n|\r/g, '\n'), newline: styles.size > 1 ? 'mixed' : styles.has('\r\n') ? 'crlf' : styles.has('\r') ? 'cr' : 'lf' };
}
export function draftText(draft: FileEditDraft): string {
  if (draft.restoreText !== undefined) { textBytes(draft.restoreText); return draft.restoreText; }
  if (draft.newline === 'mixed') {
    if (draft.content === textFormat(draft.before.text).content && draft.bom === draft.before.text.startsWith('\uFEFF')) return draft.before.text;
    throw new Error('原文件混用了换行格式，请明确选择写入时的换行格式。');
  }
  const text = (draft.bom ? '\uFEFF' : '') + draft.content.replace(/\r\n|\r|\n/g, draft.newline === 'crlf' ? '\r\n' : draft.newline === 'cr' ? '\r' : '\n');
  textBytes(text); return text;
}
export function validateDraft(draft: FileEditDraft) {
  validateTextName(draft.name); textBytes(draft.before.text); textBytes(draft.content);
  if (!['lf', 'crlf', 'cr', 'mixed'].includes(draft.newline)) throw new Error('换行格式无效。');
  if (draft.restoreText !== undefined) textBytes(draft.restoreText);
}
export function assertTextDirectory(record: Pick<FileEditDraft, 'directoryIdentity'>, directory: OrganizerDirectoryHandle, acknowledged: boolean) {
  if (record.directoryIdentity ? record.directoryIdentity !== directory.identity : !!directory.identity) throw new Error('所选目录与文本记录不一致。');
  if (!directory.identity && !acknowledged) throw new Error('浏览器不能持久识别原目录，请确认已选择正确目录。');
}
export function assertVersionCapacity(records: FileEditVersion[], next: FileEditVersion) {
  if (records.length >= 50 || [...records, next].reduce((n, r) => n + textBytes(r.before.text).length + textBytes(r.after.text).length, 0) > MAX_VERSION_BYTES) {
    throw new Error('文本历史最多 50 条、前后文本合计 2 MiB。请先导出并删除不需要的已核实记录。');
  }
}
async function readHandle(handle: OrganizerFileHandle): Promise<TextSnapshot> {
  if (handle.readText) {
    const result = await handle.readText(), checked = await snapshotText(result.text, result.identity);
    if (result.sha256 !== checked.sha256) throw new Error('读取摘要不一致，请重新读取文件。');
    return checked;
  }
  const file = await handle.getFile();
  if (file.size > MAX_TEXT_BYTES) throw new Error('文本编辑单文件最多 256 KiB（UTF-8 字节）。');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new Error('文本编辑单文件最多 256 KiB（UTF-8 字节）。');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('文件不是有效 UTF-8，请先用其他编辑器转换编码。'); }
  return snapshotText(text);
}
async function readDirectoryTextUnlocked(directory: OrganizerDirectoryHandle, name: string) {
  validateTextName(name);
  const handle = await directory.getFileHandle(name), snapshot = await readHandle(handle);
  readHandles.set(snapshot, handle); return snapshot;
}
/** Shares the move/undo lock. The durable snapshot MUST precede any writer. */
async function writeDirectoryTextUnlocked(directory: OrganizerDirectoryHandle, draft: FileEditDraft, after: TextSnapshot, options: { beforeWrite: () => Promise<void>; guard: () => void; acknowledged: boolean }) {
  validateDraft(draft); assertTextDirectory(draft, directory, options.acknowledged);
  if ((await snapshotText(after.text)).sha256 !== after.sha256 || (await snapshotText(draft.before.text)).sha256 !== draft.before.sha256) throw new Error('文本快照摘要无效。');
  options.guard();
  const handle = await directory.getFileHandle(draft.name);
  const opened = readHandles.get(draft.before);
  if (opened?.isSameEntry && !await opened.isSameEntry(handle)) throw new Error('文件已被替换或目录已改变，请保留草稿并重新读取。');
  async function verify() {
    const fresh = await directory.getFileHandle(draft.name);
    if (handle.isSameEntry && !await handle.isSameEntry(fresh)) throw new Error('文件已被替换，请保留草稿并重新读取。');
    const current = await readHandle(fresh);
    if (current.sha256 !== draft.before.sha256 || current.identity !== draft.before.identity) throw new Error('文件已在外部修改或替换，请保留草稿并重新读取。');
    options.guard();
  }
  await verify();
  await options.beforeWrite();
  await verify();
  if (handle.replaceText) await handle.replaceText(after.text, draft.before.sha256);
  else {
    const writer = await handle.createWritable();
    try {
      options.guard(); await writer.write(new Blob([textBytes(after.text)]));
      await verify(); // No external-process CAS in File System Access; a residual race remains.
      await writer.close();
    } catch (error) { try { await writer.abort?.(); } catch { /* Keep the original error and encrypted snapshots. */ } throw error; }
  }
  const written = await readHandle(await directory.getFileHandle(draft.name));
  if (written.sha256 !== after.sha256 || written.identity !== draft.before.identity) throw new Error('写入后文件与预期不一致，请核验并保留历史版本。');
}

// A batch holds the same cross-window lock for its full preflight and writes.
// Only these scoped callbacks bypass the individual-operation lock.
export async function withTextBatch<T>(operation: (access: {
  read: typeof readDirectoryTextUnlocked;
  write: typeof writeDirectoryTextUnlocked;
  verify: typeof verifyTextSnapshot;
}) => Promise<T>): Promise<T> {
  return exclusively(() => operation({ read: readDirectoryTextUnlocked, write: writeDirectoryTextUnlocked, verify: verifyTextSnapshot }));
}
async function verifyTextSnapshot(directory: OrganizerDirectoryHandle, draft: FileEditDraft, acknowledged: boolean) {
  validateDraft(draft); assertTextDirectory(draft, directory, acknowledged);
  const handle = await directory.getFileHandle(draft.name), opened = readHandles.get(draft.before);
  if (opened?.isSameEntry && !await opened.isSameEntry(handle)) throw new Error('文件已被替换，请重新预览。');
  const current = await readHandle(handle);
  if (current.sha256 !== draft.before.sha256 || current.identity !== draft.before.identity) throw new Error('文件已在外部修改或替换，请重新预览。');
}
export function readDirectoryText(directory: OrganizerDirectoryHandle, name: string) {
  return exclusively(() => readDirectoryTextUnlocked(directory, name));
}
export function writeDirectoryText(...args: Parameters<typeof writeDirectoryTextUnlocked>) {
  return exclusively(() => writeDirectoryTextUnlocked(...args));
}
