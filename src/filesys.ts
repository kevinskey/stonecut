// Save/open designs as real files on disk via the File System Access API —
// Chrome/Edge, the same browsers WebUSB already requires. "Save" writes back
// to the SAME file like a desktop app instead of downloading a new copy each
// time. The current handle is persisted in IndexedDB (same pattern as
// fontstore) so ⌘S after a reload still writes to the same file; the browser
// re-prompts for permission once, inside the save gesture.
//
// Typed locally rather than against lib.dom so the build does not depend on
// the TS dom lib carrying the full File System Access surface.

export const DESIGN_EXT = '.stonecut'

export interface FSFileHandle {
  readonly name: string
  getFile(): Promise<File>
  createWritable(): Promise<{
    write(data: string | Blob): Promise<void>
    close(): Promise<void>
  }>
  queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<string>
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<string>
}

const PICKER_TYPES = [
  {
    description: 'StoneCut design',
    accept: { 'application/json': [DESIGN_EXT, '.json'] },
  },
]

const w = window as unknown as {
  showSaveFilePicker?: (opts?: object) => Promise<FSFileHandle>
  showOpenFilePicker?: (opts?: object) => Promise<FSFileHandle[]>
}

export const fsSupported = typeof w.showSaveFilePicker === 'function'

/** OS save dialog. null = user cancelled. */
export async function pickSaveHandle(suggestedName: string): Promise<FSFileHandle | null> {
  try {
    return await w.showSaveFilePicker!({ suggestedName, types: PICKER_TYPES, id: 'stonecut-designs' })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }
}

/** OS open dialog. null = user cancelled. */
export async function pickOpenHandle(): Promise<FSFileHandle | null> {
  try {
    const got = await w.showOpenFilePicker!({ types: PICKER_TYPES, id: 'stonecut-designs' })
    return got?.[0] ?? null
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }
}

export async function writeHandle(h: FSFileHandle, content: string): Promise<void> {
  const ws = await h.createWritable()
  await ws.write(content)
  await ws.close()
}

/** Re-check (and if needed prompt for) write permission — a handle restored
 *  from IndexedDB comes back without it. Must be called inside a user
 *  gesture or the prompt is denied silently. */
export async function ensureWritable(h: FSFileHandle): Promise<boolean> {
  if (!h.queryPermission) return true
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted'
}

// ---------------------------------------------------------------------------
// Current-file persistence
// ---------------------------------------------------------------------------

const DB = 'stonecut-file'
const STORE = 'handles'
const KEY = 'current'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function rememberHandle(h: FSFileHandle | null): Promise<void> {
  try {
    const db = await open()
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    if (h) await done(store.put(h, KEY))
    else await done(store.delete(KEY))
    db.close()
  } catch {
    // remembering the file is a convenience; never let it break a save
  }
}

export async function recallHandle(): Promise<FSFileHandle | null> {
  try {
    const db = await open()
    const h = await done(db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY))
    db.close()
    return (h as FSFileHandle | undefined) ?? null
  } catch {
    return null
  }
}
