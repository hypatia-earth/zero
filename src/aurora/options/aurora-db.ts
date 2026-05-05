/**
 * Low-level IndexedDB wrapper for `aurora-db`.
 *
 * Two object stores:
 *   - `options` — single entry keyed `'current'`, holds versioned AuroraOptions blob.
 *   - `cache`   — arbitrary key/value (shader cache, capability cache, …).
 *
 * IDB version (`AURORA_DB_VERSION`) drives `onupgradeneeded` store creation.
 * Schema version (stored inside the options blob) drives blob-shape migrations
 * and is independent of IDB version.
 *
 * Available in both window and worker scopes (`indexedDB` is global in both).
 */

export const AURORA_DB_VERSION = 1;
export const OPTIONS_STORE = 'options';
export const CACHE_STORE = 'cache';
export const OPTIONS_KEY = 'current';

export function openAuroraDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, AURORA_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(OPTIONS_STORE)) {
        db.createObjectStore(OPTIONS_STORE);
      }
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE);
      }
    };
  });
}

export function getFromStore<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve((req.result ?? null) as T | null);
  });
}

export function putInStore<T>(db: IDBDatabase, storeName: string, key: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function deleteFromStore(db: IDBDatabase, storeName: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
