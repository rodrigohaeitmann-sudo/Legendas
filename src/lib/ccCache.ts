// Persists in-flight CC progress to IndexedDB so a backgrounded tab — or
// a phone the user came back to half an hour later — picks up where it
// left off instead of starting from zero. The cache holds the extracted
// audio plus per-window cues so both phases are resumable.

import type { Cue } from '../types'
import type { SourceLang } from './detectLang'
import type { WhisperModel } from './transcribe'

const DB_NAME = 'legendas-cc'
const STORE = 'progress'
// Single-row layout: we only ever cache the most recent video. The keyPath
// is videoId so opening a different video naturally invalidates the entry.
const DB_VERSION = 1

export interface CcEntry {
  videoId: string
  lang: SourceLang
  model: WhisperModel
  audio?: Float32Array
  cues: Cue[]
  windowIndex: number
  updatedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'videoId' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

export async function loadCcProgress(
  videoId: string,
  lang: SourceLang,
  model: WhisperModel,
): Promise<CcEntry | null> {
  try {
    const db = await openDb()
    return await new Promise<CcEntry | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(videoId)
      req.onsuccess = () => {
        const e = req.result as CcEntry | undefined
        // Reusing an entry from a different lang/model would mis-pair cues
        // (different transcript) and confuse Whisper's resume index.
        if (!e || e.lang !== lang || e.model !== model) return resolve(null)
        resolve(e)
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

// Replace previous-video entries so we never accumulate audio buffers
// (each is tens of MB) past the one in progress.
async function clearOthers(db: IDBDatabase, keepVideoId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      const value = cursor.value as CcEntry
      if (value.videoId !== keepVideoId) store.delete(value.videoId)
      cursor.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

export async function saveCcProgress(entry: CcEntry): Promise<void> {
  try {
    const db = await openDb()
    await clearOthers(db, entry.videoId)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ ...entry, updatedAt: Date.now() })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* best-effort */
  }
}

export async function clearCcProgress(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* best-effort */
  }
}
