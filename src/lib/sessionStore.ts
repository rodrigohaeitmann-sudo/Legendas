import type { MergedCue } from '../types'
import type { SourceLang } from './detectLang'
import type { WhisperModel } from './transcribe'

// Persists the last loaded video (as a Blob) + parsed cues in IndexedDB so the
// app can reopen them automatically, even after the page is discarded.
const DB_NAME = 'legendas'
const STORE = 'session'
const KEY = 'last'

export interface SessionResume {
  sourceLang: SourceLang
  email?: string
  source:
    | { kind: 'srt'; text: string }
    | { kind: 'cc'; whisperModel: WhisperModel }
}

export interface StoredSession {
  videoId: string
  videoBlob: Blob
  cues: MergedCue[]
  /** Chosen audio track. Stays in the session even after the pipeline
      completes so reopens know to resume the MSE re-mux for the right
      track instead of falling back to the file's default audio. */
  audioTrackIndex?: number
  /** Present only while the build is still in progress; cleared on done. */
  resume?: SessionResume
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveSession(session: StoredSession): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(session, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function loadSession(): Promise<StoredSession | null> {
  const db = await openDb()
  try {
    return await new Promise<StoredSession | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve((req.result as StoredSession) ?? null)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function clearSession(): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
