// db.js — IndexedDB Promise 封装
const DB_NAME = 'engreader';
const DB_VER = 2;

let _db = null;

export function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('books')) {
        d.createObjectStore('books', { keyPath: 'id', autoIncrement: true });
      }
      if (!d.objectStoreNames.contains('chapters')) {
        const s = d.createObjectStore('chapters', { keyPath: ['bookId', 'idx'] });
        s.createIndex('byBook', 'bookId');
      }
      if (!d.objectStoreNames.contains('words')) {
        d.createObjectStore('words', { keyPath: 'word' });
      }
      if (!d.objectStoreNames.contains('kv')) {
        d.createObjectStore('kv', { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains('bookmarks')) {
        const s = d.createObjectStore('bookmarks', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byBook', 'bookId');
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
    // 配额超限 / 提交阶段失败只会触发 abort，不会触发 error。
    // 不接住的话 Promise 永不 settle——导入大书撞上配额时界面会静默卡死，连报错都没有。
    t.onabort = () => reject(t.error || new Error('数据库事务中止（可能空间不足）'));
  }));
}

// ---- books（只存元数据，正文在 chapters）----
export const books = {
  all: () => tx('books', 'readonly', s => s.getAll()),
  get: (id) => tx('books', 'readonly', s => s.get(id)),
  put: (book) => tx('books', 'readwrite', s => s.put(book)),
  del: (id) => db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(['books', 'chapters'], 'readwrite');
    t.objectStore('books').delete(id);
    const idx = t.objectStore('chapters').index('byBook');
    const cur = idx.openCursor(IDBKeyRange.only(id));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { c.delete(); c.continue(); }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('数据库事务中止（可能空间不足）'));
  })),
};

// ---- chapters ----
export const chapters = {
  get: (bookId, idx) => tx('chapters', 'readonly', s => s.get([bookId, idx])),
  put: (ch) => tx('chapters', 'readwrite', s => s.put(ch)),
};

// ---- words ----
export const words = {
  all: () => tx('words', 'readonly', s => s.getAll()),
  get: (w) => tx('words', 'readonly', s => s.get(w)),
  put: (rec) => tx('words', 'readwrite', s => s.put(rec)),
  del: (w) => tx('words', 'readwrite', s => s.delete(w)),
};

// ---- kv ----
export const kv = {
  get: async (key) => {
    const rec = await tx('kv', 'readonly', s => s.get(key));
    return rec ? rec.value : undefined;
  },
  set: (key, value) => tx('kv', 'readwrite', s => s.put({ key, value })),
  /** 全表读（含 value）。kv 没有遍历 API，翻译缓存的容量淘汰要靠它 */
  all: () => tx('kv', 'readonly', s => s.getAll()),
  del: (key) => tx('kv', 'readwrite', s => s.delete(key)),
};

// ---- bookmarks ----
export const bookmarks = {
  all: () => tx('bookmarks', 'readonly', s => s.getAll()),
  byBook: (bookId) => db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction('bookmarks', 'readonly');
    const idx = t.objectStore('bookmarks').index('byBook');
    const req = idx.getAll(IDBKeyRange.only(bookId));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    t.onabort = () => reject(t.error || new Error('数据库事务中止（可能空间不足）'));
  })),
  get: (id) => tx('bookmarks', 'readonly', s => s.get(id)),
  put: (rec) => tx('bookmarks', 'readwrite', s => s.put(rec)),
  del: (id) => tx('bookmarks', 'readwrite', s => s.delete(id)),
};
