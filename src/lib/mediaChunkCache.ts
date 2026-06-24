// Caches the fragmented MP4 chunks produced by extractMediaFmp4 in
// IndexedDB. Without this, every reopen of an already-extracted episode
// re-ran ffmpeg from chunk 0 — wasteful when most of the audio remux work
// was already done in a previous session.
//
// One entry per (videoId, trackIndex, startSec). The MSE stream feeds cached
// chunks straight into the SourceBuffer on resume and only re-runs ffmpeg
// for the gap between the cached range and the duration.

const DB_NAME = 'legendas-media-chunks'
const STORE = 'chunks'
const DB_VERSION = 1

export interface CachedChunk {
  /** Composite key: `${videoId}#${trackIndex}#${start}`. */
  key: string
  videoId: string
  trackIndex: number
  start: number
  dur: number
  bytes: Uint8Array
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' })
          store.createIndex('videoTrack', ['videoId', 'trackIndex'])
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function chunkKey(videoId: string, trackIndex: number, start: number): string {
  return `${videoId}#${trackIndex}#${start}`
}

export async function loadChunksFor(
  videoId: string,
  trackIndex: number,
): Promise<CachedChunk[]> {
  try {
    const db = await openDb()
    return await new Promise<CachedChunk[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const index = tx.objectStore(STORE).index('videoTrack')
      const req = index.getAll([videoId, trackIndex])
      req.onsuccess = () => {
        const all = (req.result as CachedChunk[]) ?? []
        all.sort((a, b) => a.start - b.start)
        resolve(all)
      }
      req.onerror = () => reject(req.error)
    })
  } catch {
    return []
  }
}

export async function saveChunk(
  videoId: string,
  trackIndex: number,
  start: number,
  dur: number,
  bytes: Uint8Array,
): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({
        key: chunkKey(videoId, trackIndex, start),
        videoId,
        trackIndex,
        start,
        dur,
        bytes,
      } satisfies CachedChunk)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* best-effort */
  }
}

// Evict everything for any (videoId, trackIndex) other than the one we're
// keeping. Audio chunks pile up at ~5-15 MB each, so leaving stale ones
// for previously-watched videos would eat IDB quota fast.
export async function pruneOtherVideos(
  keepVideoId: string,
  keepTrackIndex: number,
): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) return
        const v = cursor.value as CachedChunk
        if (v.videoId !== keepVideoId || v.trackIndex !== keepTrackIndex) {
          store.delete(v.key)
        }
        cursor.continue()
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    /* best-effort */
  }
}

export async function clearAllChunks(): Promise<void> {
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
