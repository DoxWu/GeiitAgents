import { describe, expect, it } from "vitest";
import { applyRenamePlan, type OrganizerDirectoryHandle, type OrganizerDirectoryEntry, type OrganizerFileHandle } from "./apply";
import type { RenamePlan } from "./plan";

class MemoryDirectory implements OrganizerDirectoryHandle {
  files = new Map<string, File>();
  failTarget: string | null = null;

  constructor(entries: Record<string, string>) {
    for (const [name, content] of Object.entries(entries)) this.files.set(name, new File([content], name, { type: "text/plain" }));
  }

  async *values(): AsyncIterable<OrganizerDirectoryEntry> {
    for (const name of this.files.keys()) yield { kind: "file", name, getFile: async () => this.files.get(name)! };
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<OrganizerFileHandle> {
    if (!this.files.has(name) && !options.create) throw new DOMException("Not found", "NotFoundError");
    if (this.failTarget === name) throw new Error("simulated target failure");
    return {
      getFile: async () => this.files.get(name)!,
      createWritable: async () => ({
        write: async (data: Blob) => { this.files.set(name, new File([await data.arrayBuffer()], name, { type: data.type })); },
        close: async () => {},
      }),
    };
  }

  async removeEntry(name: string) {
    if (!this.files.delete(name)) throw new Error(`missing ${name}`);
  }
}

const plan: RenamePlan[] = [
  { source: "a.txt", target: "archive-a.txt", size: 1, status: "ready" },
  { source: "b.txt", target: "archive-b.txt", size: 1, status: "ready" },
];

describe("applyRenamePlan", () => {
  it("copies each source to a new target and removes staging entries", async () => {
    const directory = new MemoryDirectory({ "a.txt": "A", "b.txt": "B" });
    await applyRenamePlan(directory, plan);
    expect([...directory.files.keys()].sort()).toEqual(["archive-a.txt", "archive-b.txt"]);
    expect(await directory.files.get("archive-a.txt")!.text()).toBe("A");
    expect(await directory.files.get("archive-b.txt")!.text()).toBe("B");
  });

  it("rejects an existing target before writing anything", async () => {
    const directory = new MemoryDirectory({ "a.txt": "A", "b.txt": "B", "archive-a.txt": "old" });
    await expect(applyRenamePlan(directory, plan)).rejects.toThrow("目标文件名冲突");
    expect([...directory.files.keys()].sort()).toEqual(["a.txt", "archive-a.txt", "b.txt"]);
    expect(await directory.files.get("archive-a.txt")!.text()).toBe("old");
  });

  it("restores sources and removes partial targets after a write failure", async () => {
    const directory = new MemoryDirectory({ "a.txt": "A", "b.txt": "B" });
    directory.failTarget = "archive-b.txt";
    await expect(applyRenamePlan(directory, plan)).rejects.toThrow("simulated target failure");
    expect([...directory.files.keys()].sort()).toEqual(["a.txt", "b.txt"]);
    expect(await directory.files.get("a.txt")!.text()).toBe("A");
    expect(await directory.files.get("b.txt")!.text()).toBe("B");
  });
});
