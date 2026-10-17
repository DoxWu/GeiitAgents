import type { VaultData } from "@/types/workbench";
import type { VaultStorage } from './privateVaultStorage';

const ITERATIONS = 600_000;
export const MAX_VAULT_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const context = encoder.encode("geiit-private-workbench-v1");

// Current clients share this short critical section. Encryption happens outside
// it; IndexedDB also compares the expected ciphertext inside its transaction.
export async function withVaultWriteLock<T>(storageKey: string, operation: () => T): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('geiit-private-vault:' + storageKey, operation);
  return operation();
}

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

  constructor(private storage: VaultStorage, readonly storageKey: string) {}

  async exists(): Promise<boolean> { return (await this.storage.getItem(this.storageKey)) !== null; }

  async unlock(password: string): Promise<VaultData> {
    const epoch = ++this.epoch;
    const stored = await this.storage.getItem(this.storageKey);
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
          || data.workflows !== undefined && !Array.isArray(data.workflows)
          || data.workflowSchedules !== undefined && !Array.isArray(data.workflowSchedules)
          || data.workflowDraft !== undefined && data.workflowDraft !== null && (typeof data.workflowDraft !== 'object' || Array.isArray(data.workflowDraft))
          || data.taskRuns !== undefined && !Array.isArray(data.taskRuns)
          || data.toolRuns !== undefined && !Array.isArray(data.toolRuns)
          || data.artifacts !== undefined && !Array.isArray(data.artifacts)
          || data.referenceDocuments !== undefined && !Array.isArray(data.referenceDocuments)
          || data.personalItems !== undefined && !Array.isArray(data.personalItems)
          || data.personalDrafts !== undefined && !Array.isArray(data.personalDrafts)
          || data.reminderDrafts !== undefined && !Array.isArray(data.reminderDrafts)
          || data.reminderTemplates !== undefined && !Array.isArray(data.reminderTemplates)
          || data.organizerRuns !== undefined && !Array.isArray(data.organizerRuns)) throw new Error();
        if (data.fileEditVersions !== undefined && !Array.isArray(data.fileEditVersions)
          || data.fileEditDraft != null && (typeof data.fileEditDraft !== 'object' || Array.isArray(data.fileEditDraft))) throw new Error();
        if (data.workflows?.length || data.workflowDraft || data.taskRuns?.some(t => t.workflow)) {
          const { validateWorkflow, validateWorkflowInput } = await import('@/workflows/definition');
          const { validateWorkflowSchedule } = await import('@/workflows/schedule');
          if ((data.workflows?.length ?? 0) > 30 || new Set(data.workflows?.map(d => d.id)).size !== (data.workflows?.length ?? 0)) throw new Error();
          data.workflows?.forEach(item => validateWorkflow(item));
          data.workflowSchedules?.forEach(item => validateWorkflowSchedule(item));
          if (data.workflowDraft) validateWorkflow(data.workflowDraft, true);
          data.taskRuns?.forEach(t => { if (t.workflow) { validateWorkflow(t.workflow.definition); validateWorkflowInput(t.workflow.input); } });
        }
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
    if (encoder.encode(snapshot).byteLength > MAX_VAULT_SNAPSHOT_BYTES) return Promise.reject(new Error("本机工作台数据超过 16 MiB 快照上限，请导出备份后删除不需要的历史或正文。"));
    const key = this.key;
    const salt = this.salt;
    const epoch = this.epoch;
    const operation = this.pending.catch(() => {}).then(async () => {
      if (!key || !salt || epoch !== this.epoch) throw new Error("密钥库已锁定。");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: context }, key, encoder.encode(snapshot),
      );
      const serialized = JSON.stringify({ version: 1, salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
      await withVaultWriteLock(this.storageKey, async () => {
        if (epoch !== this.epoch) throw new Error("密钥库已锁定。");
        if (await this.storage.getItem(this.storageKey) !== this.lastWritten) {
          this.lock();
          throw new Error("密钥库已在另一窗口更新，请重新解锁。");
        }
        if (epoch !== this.epoch) throw new Error("密钥库已锁定。");
        await this.storage.setItem(this.storageKey, serialized, this.lastWritten, () => {
          if (epoch !== this.epoch) throw new Error("密钥库已锁定。");
        });
        this.lastWritten = serialized;
      });
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
    this.storage.close?.();
  }
}
