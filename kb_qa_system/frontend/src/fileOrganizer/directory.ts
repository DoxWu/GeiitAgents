import { invoke } from '@tauri-apps/api/core';
import type { OrganizerDirectoryHandle, OrganizerFileHandle } from './apply';

declare global { interface Window { showDirectoryPicker?: (options?: { mode: 'readwrite' }) => Promise<OrganizerDirectoryHandle> } }
interface NativeDirectory { token: string; name: string; identity: string }
interface NativeInfo { size: number; modifiedAt: number; identity: string }
let session: string | undefined;
async function access<T>(operation: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>('organizer_access', { operation }); }
  catch (error) {
    if (error === 'NotFoundError') throw new DOMException('文件不存在。', 'NotFoundError');
    throw new Error(typeof error === 'string' ? error : '原生文件操作失败。');
  }
}
class NativeFile implements OrganizerFileHandle {
  constructor(readonly token: string, readonly name: string, readonly identity: string) {}
  private fields() { return { token: this.token, name: this.name, identity: this.identity }; }
  async getFile() {
    const info = await access<NativeInfo>({ op: 'stat', ...this.fields() });
    // Metadata-only File. All hashing and copying stay in Rust using a 64 KiB
    // buffer; accidental byte reads must fail instead of returning empty data.
    const file = new File([], this.name, { lastModified: info.modifiedAt });
    Object.defineProperties(file, {
      size: { value: info.size },
      arrayBuffer: { value: async () => { throw new Error('原生文件内容仅通过受限文件操作读取。'); } },
    });
    return file;
  }
  async createWritable(): Promise<never> { throw new Error('原生文件仅允许校验后的本机复制。'); }
  async isSameEntry(other: OrganizerFileHandle) { return other instanceof NativeFile && this.identity === other.identity; }
  fingerprint() { return access<string>({ op: 'hash', ...this.fields() }); }
  readText() { return access<{ text: string; sha256: string; identity: string }>({ op: 'read_text', ...this.fields() }); }
  async replaceText(text: string, sha256: string) { await access({ op: 'write_text', ...this.fields(), text, sha256 }); }
  async copyFrom(source: OrganizerFileHandle) {
    if (!(source instanceof NativeFile)) throw new Error('不能混用浏览器与原生目录。');
    await access({ op: 'copy', ...this.fields(), source_token: source.token, source_name: source.name, source_identity: source.identity });
  }
  async removeIfMatches(sha256: string) { await access({ op: 'remove', ...this.fields(), sha256 }); }
}
class NativeHandle implements OrganizerDirectoryHandle {
  name: string;
  identity: string;
  private references = 1;
  constructor(private descriptor: NativeDirectory) { this.name = descriptor.name; this.identity = descriptor.identity; }
  retain() { this.references++; }
  release() {
    if (--this.references === 0) void invoke('organizer_release_directory', { token: this.descriptor.token }).catch(() => { /* Process exit also revokes grants. */ });
  }
  async isSameEntry(other: OrganizerDirectoryHandle) { return other.identity === this.identity; }
  async *values() {
    const entries = await access<{ name: string; kind: string }[]>({ op: 'list', token: this.descriptor.token });
    for (const entry of entries) yield { ...entry, getFile: async () => (await this.getFileHandle(entry.name)).getFile() };
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const info = await access<NativeInfo>({ op: options?.create ? 'create' : 'stat', token: this.descriptor.token, name });
    return new NativeFile(this.descriptor.token, name, info.identity);
  }
  async removeEntry(): Promise<never> { throw new Error('删除原生文件必须同时校验身份和摘要。'); }
}
export async function pickOrganizerDirectory(): Promise<OrganizerDirectoryHandle> {
  if ('__TAURI_INTERNALS__' in window) {
    session ??= crypto.randomUUID();
    let result: NativeDirectory | null;
    try { result = await invoke<NativeDirectory | null>('organizer_pick_directory', { session }); }
    catch (error) { throw new Error(typeof error === 'string' ? error : '无法选择原生目录。'); }
    if (!result) throw new DOMException('已取消目录选择。', 'AbortError');
    return new NativeHandle(result);
  }
  if (!window.showDirectoryPicker) throw new Error('当前环境不支持目录写入，可通过“选择文件生成清单”预览并导出。');
  return window.showDirectoryPicker({ mode: 'readwrite' });
}
