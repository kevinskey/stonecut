// Installed custom fonts, persisted in IndexedDB so they survive reloads —
// "installed" rather than "loaded for this session". Values are the raw
// font file bytes; parsing stays in the caller so a stored font that later
// fails to parse can be surfaced (and removed) instead of dying here.

const DB = 'stonecut-fonts'
const STORE = 'fonts'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE)
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveFont(name: string, data: ArrayBuffer): Promise<void> {
  const db = await open()
  await done(tx(db, 'readwrite').put(data, name))
  db.close()
}

export async function listFonts(): Promise<string[]> {
  const db = await open()
  const keys = await done(tx(db, 'readonly').getAllKeys())
  db.close()
  return (keys as string[]).sort((a, b) => a.localeCompare(b))
}

export async function getFont(name: string): Promise<ArrayBuffer | undefined> {
  const db = await open()
  const data = await done(tx(db, 'readonly').get(name))
  db.close()
  return data as ArrayBuffer | undefined
}

export async function deleteFont(name: string): Promise<void> {
  const db = await open()
  await done(tx(db, 'readwrite').delete(name))
  db.close()
}
