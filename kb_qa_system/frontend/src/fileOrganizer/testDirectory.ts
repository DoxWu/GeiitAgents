// File System Access test double: creation leaves an empty entry, writes commit
// on close, and old File snapshots become unreadable when the source changes.
import type { OrganizerDirectoryEntry, OrganizerDirectoryHandle, OrganizerFileHandle } from './apply';

export class MemoryDirectory implements OrganizerDirectoryHandle {
  name = 'fixture-directory';
  files = new Map<string, File>();
  identities = new Map<string, object>();
  aborts = 0;
  closes = 0;
  onWrite?: (name: string) => void;
  onCreateWritable?: (name: string) => void;
  onClose?: (name: string) => void;
  onRemove?: (name: string) => void;
  afterRemove?: (name: string) => void;
  constructor(values: Record<string, string>) { for (const [name, text] of Object.entries(values)) this.put(name, text); }
  put(name: string, value: string) {
    if (!this.identities.has(name)) this.identities.set(name, {});
    this.files.set(name, new File([value], name, { lastModified: 1_000, type: 'text/plain' }));
  }
  async *values(): AsyncIterable<OrganizerDirectoryEntry> {
    for (const name of this.files.keys()) yield { kind: 'file', name, getFile: async () => (await this.getFileHandle(name)).getFile() };
  }
  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<OrganizerFileHandle> {
    if (!this.files.has(name)) {
      if (!options.create) throw new DOMException('Missing', 'NotFoundError');
      this.put(name, '');
    }
    const identity = this.identities.get(name);
    const assertExists = () => { if (!this.files.has(name) || this.identities.get(name) !== identity) throw new DOMException('Missing', 'NotFoundError'); };
    const handle: OrganizerFileHandle & { identity: object | undefined } = {
      identity,
      isSameEntry: async other => identity === (other as typeof handle).identity,
      getFile: async () => {
        assertExists(); const source = this.files.get(name)!;
        const file = new File([source], name, { lastModified: source.lastModified, type: source.type });
        Object.defineProperty(file, 'arrayBuffer', { value: async () => {
          if (this.files.get(name) !== source) throw new DOMException('Stale file snapshot', 'NotReadableError');
          return source.arrayBuffer();
        } });
        return file;
      },
      createWritable: async () => {
        assertExists(); this.onCreateWritable?.(name);
        let pending: File | undefined;
        return {
          write: async data => { assertExists(); this.onWrite?.(name); pending = new File([await data.arrayBuffer()], name, { type: data.type }); },
          close: async () => { assertExists(); this.closes++; this.onClose?.(name); if (pending) this.files.set(name, pending); },
          abort: async () => { this.aborts++; pending = undefined; },
        };
      },
    };
    return handle;
  }
  async removeEntry(name: string) {
    this.onRemove?.(name);
    if (!this.files.delete(name)) throw new DOMException('Missing', 'NotFoundError');
    this.identities.delete(name); this.afterRemove?.(name);
  }
}
