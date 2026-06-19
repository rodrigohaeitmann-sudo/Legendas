// Local queue of saved words/expressions, persisted in IndexedDB. Entries are
// kept locally and pushed to a Google Sheet (via Apps Script) by sheetSync.ts.
// Keeping a local store means saving works offline and survives reloads; the
// sheet is the durable backup for later review.

const DB_NAME = 'legendas-words'
const STORE = 'words'
const DB_VERSION = 1

export type WordKind = 'word' | 'expression'

export interface SavedWord {
  id: string
  text: string
  kind: WordKind
  ipa: string
  /** Comma-joined translations, matching the sheet's "Traduções" column. */
  translations: string
  /** Subtitle line the word came from. */
  context: string
  /** e.g. video filename — fills the sheet's "Capítulo" column. */
  chapter: string
  /** App identifier — fills the sheet's "Fonte" column. */
  source: string
  /** ISO timestamp of when the user saved it. */
  savedAt: string
  /** Whether it's already been pushed to the sheet. */
  synced: boolean
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' })
          store.createIndex('savedAt', 'savedAt')
          store.createIndex('synced', 'synced')
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface SaveInput {
  text: string
  kind: WordKind
  ipa?: string
  translations?: string[] | string
  context?: string
  chapter?: string
  source?: string
}

export async function addSavedWord(input: SaveInput): Promise<SavedWord> {
  const entry: SavedWord = {
    id: newId(),
    text: input.text.trim(),
    kind: input.kind,
    ipa: input.ipa ?? '',
    translations: Array.isArray(input.translations)
      ? input.translations.join(', ')
      : (input.translations ?? ''),
    context: input.context ?? '',
    chapter: input.chapter ?? '',
    source: input.source ?? 'Listening',
    savedAt: new Date().toISOString(),
    synced: false,
  }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  return entry
}

function getAll(db: IDBDatabase): Promise<SavedWord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve((req.result as SavedWord[]) ?? [])
    req.onerror = () => reject(req.error)
  })
}

export async function allSavedWords(): Promise<SavedWord[]> {
  const db = await openDb()
  const all = await getAll(db)
  return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

export async function pendingSavedWords(): Promise<SavedWord[]> {
  const all = await allSavedWords()
  return all.filter((w) => !w.synced)
}

export interface SavedCounts {
  total: number
  pending: number
}

export async function savedCounts(): Promise<SavedCounts> {
  const all = await allSavedWords()
  return { total: all.length, pending: all.filter((w) => !w.synced).length }
}

export async function recentSavedWords(limit = 8): Promise<SavedWord[]> {
  const all = await allSavedWords()
  return all.slice(0, limit)
}

export async function markSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const id of ids) {
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const entry = getReq.result as SavedWord | undefined
        if (entry && !entry.synced) {
          entry.synced = true
          store.put(entry)
        }
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
