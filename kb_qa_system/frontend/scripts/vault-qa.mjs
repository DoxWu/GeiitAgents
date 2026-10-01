// Test-only helpers. Observe the authoritative ciphertext, never the legacy marker.
const vaultKey = 'geiit.workbench.encrypted.v1';
async function accessVault(page, operation, value, key = vaultKey) {
  return page.evaluate(async ({ operation, value, key }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('geiit-private-vault-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('vaults', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      let row;
      await new Promise((resolve, reject) => {
        const tx = db.transaction('vaults', operation === 'get' ? 'readonly' : 'readwrite');
        const store = tx.objectStore('vaults');
        if (operation === 'get') { const request = store.get(key); request.onsuccess = () => { row = request.result; }; }
        else if (operation === 'put') store.put({ key, value });
        else store.delete(key);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      if (operation === 'get') {
        const stored = row?.value ?? localStorage.getItem(key);
        if (stored?.startsWith('geiit-indexeddb-v1:')) throw new Error('QA expected ciphertext, found only a legacy marker');
        return stored;
      }
      if (operation === 'delete') localStorage.removeItem(key);
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('geiit-private-vault-change-v1');
        channel.postMessage({ key, source: 'external-qa-window' }); channel.close();
      }
      return null;
    } finally { db.close(); }
  }, { operation, value, key });
}
export const readVaultCiphertext = (page, key) => accessVault(page, 'get', undefined, key);
export const writeVaultCiphertext = (page, value, key) => accessVault(page, 'put', value, key);
export const removeVaultCiphertext = (page, key) => accessVault(page, 'delete', undefined, key);

export async function setVaultWriteFailure(page, fail) {
  await page.evaluate(fail => {
    if (!window.__qaVaultPutInstalled) {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (row, ...args) {
        if (this.name === 'vaults' && row?.key === 'geiit.workbench.encrypted.v1' && window.__qaFailVault)
          throw new DOMException('Synthetic IndexedDB quota', 'QuotaExceededError');
        return put.call(this, row, ...args);
      };
      window.__qaVaultPutInstalled = true;
    }
    window.__qaFailVault = fail;
  }, fail);
}
