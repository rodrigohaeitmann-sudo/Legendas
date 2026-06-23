// IndexedDB cache for full audio tracks extracted from the video. The
// browser can't switch between audio tracks of a multi-track file (the
// HTMLMediaElement audioTracks API isn't implemented in Chrome), so when
// the user picks a non-default track we extract it once with ffmpeg and
// play it from a separate <audio> element synced to the video.

const DB_NAME = 'legendas-audio'
const STORE = 'streams'
const DB_VERSION = 1
const MIME = 'audio/mp4'

export interface CachedAudio {
  key: string
  bytes: Uint8Array
  createdAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

export function audioStreamKey(videoId: string, trackIndex: number): string {
  return `${videoId}#${trackIndex}`
}

export async function loadCachedAudio(key: string): Promise<Uint8Array | null> {
  try {
    const db = await openDb()
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => {
        const e = req.result as CachedAudio | undefined
        resolve(e ? e.bytes : null)
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

// Replace any previously cached audio (we only ever need the one currently
// being watched). Big blobs would otherwise pile up at 30-50 MB each.
async function clearOthers(db: IDBDatabase, keepKey: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      const value = cursor.value as CachedAudio
      if (value.key !== keepKey) store.delete(value.key)
      cursor.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

export async function saveCachedAudio(key: string, bytes: Uint8Array): Promise<void> {
  try {
    const db = await openDb()
    await clearOthers(db, key)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ key, bytes, createdAt: Date.now() } satisfies CachedAudio)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* best-effort */
  }
}

export async function clearAudioStreamCache(): Promise<void> {
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

export function bytesToBlobUrl(bytes: Uint8Array): string {
  // Slice to a fresh ArrayBuffer to satisfy lib.dom's BlobPart signature,
  // which doesn't accept Uint8Array whose backing buffer might be Shared.
  const ab = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer.slice(0)
    : bytes.slice().buffer
  return URL.createObjectURL(new Blob([ab as ArrayBuffer], { type: MIME }))
}
