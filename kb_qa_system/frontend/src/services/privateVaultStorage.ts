export interface VaultStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string, expected?: string | null, guard?: () => void): void | Promise<void>;
  close?: () => void;
}

const DATABASE = 'geiit-private-vault-v1';
const STORE = 'vaults';
const MARKER = 'geiit-indexeddb-v1:';
export const VAULT_CHANGE_CHANNEL = 'geiit-private-vault-change-v1';
export const VAULT_WINDOW_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);

interface VaultRow { key: string; value: string }

function localValue(key: string): string | null {
  const value = localStorage.getItem(key);
  if (value?.startsWith(MARKER)) throw new Error('本机密钥库需要较新版本或可用的本机存储，请升级应用或使用加密备份恢复。');
  return value;
}

export class IndexedDbVaultStorage implements VaultStorage {
  private database: Promise<IDBDatabase> | null = null;
  private channel: BroadcastChannel | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.database) this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.database = null; };
        resolve(db);
      };
      request.onerror = () => reject(new Error('无法打开本机加密存储。'));
      request.onblocked = () => reject(new Error('本机加密存储正被其他窗口占用，请关闭旧版本窗口后重试。'));
    }).catch(error => { this.database = null; throw error; });
    return this.database;
  }

  async getItem(key: string): Promise<string | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key) as IDBRequest<VaultRow | undefined>;
      request.onsuccess = () => {
        try { resolve(request.result?.value ?? localValue(key)); }
        catch (error) { reject(error); }
      };
      request.onerror = () => reject(new Error('无法读取本机加密存储。'));
    });
  }

  async setItem(key: string, value: string, expected: string | null = null, guard?: () => void): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const request = tx.objectStore(STORE).get(key) as IDBRequest<VaultRow | undefined>;
      let conflict = false;
      request.onsuccess = () => {
        let current: string | null;
        try { guard?.(); current = request.result?.value ?? localValue(key); }
        catch (error) { conflict = true; tx.abort(); reject(error); return; }
        if (current !== expected) { conflict = true; tx.abort(); reject(new Error('本机密钥库已在另一窗口改变，请重新解锁。')); return; }
        try { tx.objectStore(STORE).put({ key, value } satisfies VaultRow); }
        catch { conflict = true; tx.abort(); reject(new Error('无法更新本机加密存储。')); }
      };
      request.onerror = () => { conflict = true; tx.abort(); reject(new Error('无法更新本机加密存储。')); };
      tx.oncomplete = () => resolve();
      tx.onabort = () => { if (!conflict) reject(new Error('无法更新本机加密存储。')); };
      tx.onerror = () => { if (!conflict) reject(new Error('无法更新本机加密存储。')); };
    });
    this.updateLegacyMarker(key, expected);
    try {
      this.channel ??= typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(VAULT_CHANGE_CHANNEL);
      this.channel?.postMessage({ key, source: VAULT_WINDOW_ID });
    } catch { /* IndexedDB remains authoritative when notifications are unavailable. */ }
  }

  private updateLegacyMarker(key: string, expected: string | null) {
    let previous: string | null;
    try { previous = localStorage.getItem(key); } catch { return; }
    if (previous !== expected && !(previous?.startsWith(MARKER))) return;
    try {
      localStorage.setItem(key, MARKER + DATABASE);
    } catch {
      // The encrypted IndexedDB write already succeeded; quota may prevent the
      // legacy marker. Current clients always read IndexedDB first.
    }
  }

  async exists(key: string): Promise<boolean> { return (await this.getItem(key)) !== null; }

  close() {
    this.database?.then(db => db.close()).catch(() => {});
    this.database = null;
    this.channel?.close();
    this.channel = null;
  }
}

export function createVaultStorage(): VaultStorage {
  if (typeof indexedDB !== 'undefined') return new IndexedDbVaultStorage();
  return window.localStorage;
}

export async function hasStoredVault(key: string): Promise<boolean> {
  const storage = createVaultStorage();
  try {
    if ('exists' in storage && typeof storage.exists === 'function') return await storage.exists(key);
    return (await storage.getItem(key)) !== null;
  } finally { storage.close?.(); }
}
