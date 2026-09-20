import type { LocalIndex } from './core';
const DB = 'geiit-local-knowledge-v1';
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('index');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本地存储，请检查浏览器权限或磁盘空间。'));
  });
}
export async function loadIndex(): Promise<LocalIndex | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('index', 'readonly');
    const request = tx.objectStore('index').get('active');
    tx.oncomplete = () => { db.close(); resolve(request.result ?? null); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
// A single transaction swaps the full index only when the expected version is still active.
export async function commitIndex(index: LocalIndex | null, expected: string | null): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('index', 'readwrite');
    const store = tx.objectStore('index');
    let conflict = false;
    const request = store.get('active');
    request.onsuccess = () => {
      if ((request.result?.revision ?? null) !== expected) { conflict = true; tx.abort(); return; }
      if (index) store.put(index, 'active'); else store.delete('active');
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error(conflict ? '本地库已被另一个窗口修改，请重新进入后重试。' : '本地存储失败，原索引已保留。请检查磁盘配额。')); };
  });
}
export const MODEL_CACHE = 'geiit-local-models-v1';
export const SESSION_LOCK = 'geiit-local-knowledge-session-v1';
