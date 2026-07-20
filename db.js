/* Стенограф — слой хранения (IndexedDB) */
'use strict';

const DB_NAME = 'stenograf';
const DB_VER = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('rooms')) {
        const s = db.createObjectStore('rooms', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('stages')) {
        const s = db.createObjectStore('stages', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
        s.createIndex('wallKey', 'wallKey');
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function _tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    const out = fn(os);
    tx.oncomplete = () => resolve(out && out._result !== undefined ? out._result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

function dbPut(store, value) {
  return _tx(store, 'readwrite', os => { os.put(value); return value; });
}

function dbDel(store, key) {
  return _tx(store, 'readwrite', os => { os.delete(key); });
}

function dbGet(store, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function dbAll(store, indexName, query) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const os = db.transaction(store).objectStore(store);
    const src = indexName ? os.index(indexName) : os;
    const req = src.getAll(query != null ? IDBKeyRange.only(query) : undefined);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function dbDelWhere(store, indexName, query) {
  return dbAll(store, indexName, query).then(rows =>
    Promise.all(rows.map(r => dbDel(store, r.id))));
}

function uid() {
  return (crypto.randomUUID) ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
