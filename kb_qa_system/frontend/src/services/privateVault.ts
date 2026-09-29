import type { VaultData } from "@/types/workbench";

const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const context = encoder.encode("geiit-private-workbench-v1");

interface Envelope {
  version: 1;
  salt: string;
  iv: string;
  ciphertext: string;
}

function encode(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(result);
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export class PrivateVault {
  private key: CryptoKey | null = null;
  private salt: Uint8Array | null = null;
  private lastWritten: string | null = null;
  private epoch = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(private storage: Storage, readonly storageKey: string) {}

  exists(): boolean { return this.storage.getItem(this.storageKey) !== null; }

  async unlock(password: string): Promise<VaultData> {
    const epoch = ++this.epoch;
    const stored = this.storage.getItem(this.storageKey);
    let salt: Uint8Array;
    let key: CryptoKey;
    let data: VaultData;
    if (!stored) {
      if (password.length < 4) throw new Error("解锁口令至少需要 4 个字符。");
      salt = crypto.getRandomValues(new Uint8Array(16));
      key = await derive(password, salt);
      data = { profiles: [], conversations: [], taskRuns: [], toolRuns: [], artifacts: [] };
    } else {
      try {
        const envelope: Envelope = JSON.parse(stored);
        if (envelope.version !== 1) throw new Error();
        salt = decode(envelope.salt);
        if (salt.length !== 16) throw new Error();
        key = await derive(password, salt);
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: decode(envelope.iv), additionalData: context }, key, decode(envelope.ciphertext),
        );
        data = JSON.parse(new TextDecoder().decode(plaintext));
        if (!Array.isArray(data.profiles) || !Array.isArray(data.conversations)
          || data.taskRuns !== undefined && !Array.isArray(data.taskRuns)
          || data.toolRuns !== undefined && !Array.isArray(data.toolRuns)
          || data.artifacts !== undefined && !Array.isArray(data.artifacts)
          || data.personalItems !== undefined && !Array.isArray(data.personalItems)
          || data.personalDrafts !== undefined && !Array.isArray(data.personalDrafts)
          || data.reminderDrafts !== undefined && !Array.isArray(data.reminderDrafts)
          || data.reminderTemplates !== undefined && !Array.isArray(data.reminderTemplates)
          || data.organizerRuns !== undefined && !Array.isArray(data.organizerRuns)) throw new Error();
      } catch {
        throw new Error("口令错误或本机密钥库已损坏。");
      }
    }
    if (epoch !== this.epoch) throw new Error("密钥库已锁定。");
    this.key = key;
    this.salt = salt;
    this.lastWritten = stored;
    if (!stored) await this.save(data);
    return data;
  }

  save(data: VaultData): Promise<void> {
    const snapshot = JSON.stringify(data);
    const key = this.key;
    const salt = this.salt;
    const epoch = this.epoch;
    const operation = this.pending.catch(() => {}).then(async () => {
      if (!key || !salt || epoch !== this.epoch) throw new Error("密钥库已锁定。");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: context }, key, encoder.encode(snapshot),
      );
      if (epoch !== this.epoch) throw new Error("密钥库已锁定。");
      if (this.storage.getItem(this.storageKey) !== this.lastWritten) {
        this.lock();
        throw new Error("密钥库已在另一窗口更新，请重新解锁。");
      }
      const serialized = JSON.stringify({ version: 1, salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
      this.storage.setItem(this.storageKey, serialized);
      this.lastWritten = serialized;
    });
    this.pending = operation;
    return operation;
  }

  async flush(): Promise<void> { await this.pending; }

  lock(): void {
    this.epoch++;
    this.key = null;
    this.salt = null;
    this.lastWritten = null;
  }
}
