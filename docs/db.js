// Speicher im Browser (IndexedDB): Kassetten und Videoclips bleiben auf dem Gerät.

const DB_NAME = 'retrocam';
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tapes')) db.createObjectStore('tapes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(storeName, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result;
    const req = fn(tx.objectStore(storeName));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaktion abgebrochen'));
  }));
}

export async function listTapes() {
  const tapes = (await run('tapes', 'readonly', (s) => s.getAll())) || [];
  return tapes.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getTape = (id) => run('tapes', 'readonly', (s) => s.get(id));
export const putTape = (tape) => run('tapes', 'readwrite', (s) => s.put(tape));
export const deleteTapeRecord = (id) => run('tapes', 'readwrite', (s) => s.delete(id));
export const putClip = (id, blob) => run('clips', 'readwrite', (s) => s.put(blob, id));
export const getClip = (id) => run('clips', 'readonly', (s) => s.get(id));
export const deleteClip = (id) => run('clips', 'readwrite', (s) => s.delete(id));
export const clipKeys = () => run('clips', 'readonly', (s) => s.getAllKeys());

/** Löscht Clips einer Kassette, die nirgends mehr verwendet werden (komplett überschrieben). */
export async function cleanupClips(tape) {
  const used = new Set(tape.segments.map((s) => s.clip));
  const keys = (await clipKeys()) || [];
  for (const key of keys) {
    if (String(key).startsWith(tape.id + '/') && !used.has(key)) await deleteClip(key);
  }
}

export async function deleteTape(tape) {
  const keys = (await clipKeys()) || [];
  for (const key of keys) {
    if (String(key).startsWith(tape.id + '/')) await deleteClip(key);
  }
  await deleteTapeRecord(tape.id);
}
