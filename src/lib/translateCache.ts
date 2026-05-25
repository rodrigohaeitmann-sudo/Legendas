// Tiny IndexedDB-backed cache for translated subtitle lines so the same
// source text is never sent to the translation API twice (across videos
// or app reloads). Key is the source text, value is the translation.

const DB_NAME = 'legendas-translations'
const STORE = 'en-ptbr'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

export async function cacheGet(text: string): Promise<string | null> {
  try {
    const db = await openDb()
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(text)
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

export async function cacheSet(text: string, translation: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(translation, text)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // best-effort
  }
}
