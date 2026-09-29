import { webcrypto } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PrivateVault } from "../privateVault";
import type { VaultData } from "@/types/workbench";

const password = "a-test-passphrase-123";
const sample: VaultData = { profiles: [{ id: "one", name: "test", mode: "relay", baseUrl: "https://example.com/v1", model: "model", maxTokens: 100, apiKey: "private-fixture-key" }], conversations: [] };
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("TextEncoder", TextEncoder); vi.stubGlobal("TextDecoder", TextDecoder);
  localStorage.clear();
});
afterEach(() => { Reflect.deleteProperty(navigator, 'locks'); vi.unstubAllGlobals(); });

describe("encrypted private vault", () => {
  it("accepts four-character passphrases and rejects shorter ones", async () => {
    const vault = new PrivateVault(localStorage, "vault");
    await expect(vault.unlock("123")).rejects.toThrow();
    await vault.unlock("1234"); await vault.save(sample); vault.lock();
    expect(await new PrivateVault(localStorage, "vault").unlock("1234")).toEqual(sample);
  });
  it("stores only ciphertext and recovers with the correct password", async () => {
    const vault = new PrivateVault(localStorage, "vault");
    await vault.unlock(password); await vault.save(sample); vault.lock();
    const stored = localStorage.getItem("vault")!;
    expect(stored).not.toContain("private-fixture-key"); expect(stored).not.toContain(password); expect(stored).not.toContain("example.com");
    await expect(new PrivateVault(localStorage, "vault").unlock("wrong-password")).rejects.toThrow();
    expect(await new PrivateVault(localStorage, "vault").unlock(password)).toEqual(sample);
  });
  it("uses a fresh nonce and serializes concurrent snapshots", async () => {
    const vault = new PrivateVault(localStorage, "vault"); await vault.unlock(password);
    await vault.save(sample); const first = JSON.parse(localStorage.getItem("vault")!).iv;
    await Promise.all([vault.save(sample), vault.save({ profiles: [], conversations: [] })]);
    expect(JSON.parse(localStorage.getItem("vault")!).iv).not.toBe(first);
    expect((await new PrivateVault(localStorage, "vault").unlock(password)).profiles).toEqual([]);
  });
  it("rejects writes after locking and detects another window's changes", async () => {
    const vault = new PrivateVault(localStorage, "vault"); await vault.unlock(password);
    const other = new PrivateVault(localStorage, "vault"); await other.unlock(password);
    await other.save(sample);
    await expect(vault.save({ profiles: [], conversations: [] })).rejects.toThrow();
    await expect(vault.save(sample)).rejects.toThrow();
    expect((await new PrivateVault(localStorage, "vault").unlock(password)).profiles).toEqual(sample.profiles);
  });
  it("detects ciphertext tampering", async () => {
    const vault = new PrivateVault(localStorage, "vault"); await vault.unlock(password); await vault.save(sample);
    const envelope = JSON.parse(localStorage.getItem("vault")!);
    envelope.ciphertext = (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1);
    localStorage.setItem("vault", JSON.stringify(envelope));
    await expect(new PrivateVault(localStorage, "vault").unlock(password)).rejects.toThrow();
  });
  it.each(['lock', 'replace'] as const)('checks %s again inside a delayed shared write lock', async reason => {
    const vault = new PrivateVault(localStorage, 'vault'); await vault.unlock(password);
    const before = localStorage.getItem('vault');
    let enter!: () => void;
    const request = vi.fn((_name, action) => new Promise((resolve, reject) => { enter = () => { try { resolve(action()); } catch (error) { reject(error); } }; }));
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    const pending = vault.save(sample); await vi.waitFor(() => expect(enter).toBeDefined());
    expect(request.mock.calls[0][0]).toBe('geiit-private-vault:vault');
    if (reason === 'lock') vault.lock(); else localStorage.setItem('vault', 'newer encrypted vault');
    enter(); await expect(pending).rejects.toThrow(reason === 'lock' ? '锁定' : '另一窗口');
    expect(localStorage.getItem('vault')).toBe(reason === 'lock' ? before : 'newer encrypted vault');
  });
});
