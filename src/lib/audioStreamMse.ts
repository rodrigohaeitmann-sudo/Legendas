// MSE-backed streaming audio for the chosen track. Instead of extracting the
// entire audio file before playback (the previous approach — ~30 s wait on a
// 45-min episode), this orchestrator pulls audio in chunks: a small first
// chunk so playback starts in ~1-2 s, then bigger chunks fed in the
// background ahead of the playhead. The behaviour now feels close to a
// native player switching tracks, but is built entirely on top of the
// browser-supported pieces (MediaSource + fragmented MP4).

import { extractAudioFmp4 } from './audioExtract'

// Small first chunk → fast first audio. Large subsequent chunks → fewer
// ffmpeg.exec invocations, so per-call overhead doesn't dominate.
const FIRST_CHUNK_S = 5
const NEXT_CHUNK_S = 30
// How far ahead of the playhead we try to keep the buffer. Higher = fewer
// risk of stalls if extraction slows; lower = less memory pinned in MSE.
const BUFFER_AHEAD_S = 60
// MIME the SourceBuffer accepts — must match what extractAudioFmp4 outputs.
const MIME = 'audio/mp4; codecs="mp4a.40.2"'

export interface StreamProgress {
  /** True once the very first chunk has landed and playback can start. */
  firstReady: boolean
  /** Seconds of audio already appended to the SourceBuffer. */
  bufferedTo: number
  /** Total media duration in seconds. */
  duration: number
}

export interface StreamHandle {
  /** Object URL to assign to the <audio> element's src. */
  url: string
  /** Tear everything down — releases the MediaSource + URL + cancels feeds. */
  cancel: () => void
  /**
   * Let the streamer know where the playhead is. Used to gate when to
   * extract the next chunk so we don't get too far ahead of the buffer
   * window, and to wake the feeder back up after a seek.
   */
  setPlaybackTime: (t: number) => void
}

// Skip ftyp + moov from a chunk that isn't the first one. ffmpeg writes a
// full self-contained fMP4 every run; MSE only wants one set of init boxes,
// so we slice off everything before the first moof.
function stripInitSegment(bytes: Uint8Array): Uint8Array {
  let offset = 0
  const len = bytes.length
  while (offset + 8 <= len) {
    const size =
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    )
    if (type === 'moof') return bytes.subarray(offset)
    if (size === 0 || size > len - offset) break
    offset += size
  }
  // Fallback: send everything — the SourceBuffer will silently keep its
  // previous moov, and the appended init data either matches (no-op) or
  // gets rejected with a console error. Either way we don't get stuck.
  return bytes
}

function waitForUpdate(sb: SourceBuffer): Promise<void> {
  if (!sb.updating) return Promise.resolve()
  return new Promise((resolve) => {
    sb.addEventListener('updateend', () => resolve(), { once: true })
  })
}

export function createAudioStream(
  file: File,
  videoId: string,
  trackIndex: number,
  duration: number,
  onProgress: (p: StreamProgress) => void,
): StreamHandle {
  const ms = new MediaSource()
  const url = URL.createObjectURL(ms)
  let sourceBuffer: SourceBuffer | null = null
  let extractedTo = 0
  let playbackTime = 0
  let cancelled = false
  let firstReady = false
  // Reentry guard: feedChunk() is async; without this, the playback-time
  // poke could schedule a second invocation while one is still in flight,
  // racing on extractedTo.
  let feedingActive = false

  async function feedChunk() {
    if (feedingActive) return
    feedingActive = true
    try {
      while (!cancelled && sourceBuffer) {
        if (extractedTo >= duration) {
          if (ms.readyState === 'open') {
            try { ms.endOfStream() } catch { /* may already be ended */ }
          }
          return
        }
        if (extractedTo - playbackTime > BUFFER_AHEAD_S) {
          // Plenty of buffer ahead — pause and wait for the next
          // setPlaybackTime poke to re-enter.
          return
        }

        const start = extractedTo
        const chunkSec = start === 0 ? FIRST_CHUNK_S : NEXT_CHUNK_S
        const dur = Math.min(chunkSec, duration - start)
        if (dur <= 0) {
          if (ms.readyState === 'open') {
            try { ms.endOfStream() } catch { /* ignore */ }
          }
          return
        }

        let bytes: Uint8Array
        try {
          bytes = await extractAudioFmp4(file, videoId, trackIndex, start, dur)
        } catch (e) {
          console.error('audio chunk extract failed', e)
          return
        }
        if (cancelled || !sourceBuffer) return
        const dataToFeed = start === 0 ? bytes : stripInitSegment(bytes)

        await waitForUpdate(sourceBuffer)
        if (cancelled || !sourceBuffer) return
        try {
          sourceBuffer.appendBuffer(dataToFeed as BufferSource)
        } catch (e) {
          console.error('SourceBuffer.appendBuffer failed', e)
          return
        }
        await waitForUpdate(sourceBuffer)
        if (cancelled) return

        extractedTo = start + dur
        if (!firstReady) firstReady = true
        onProgress({ firstReady, bufferedTo: extractedTo, duration })
      }
    } finally {
      feedingActive = false
    }
  }

  function onSourceOpen() {
    if (cancelled) return
    try {
      sourceBuffer = ms.addSourceBuffer(MIME)
      sourceBuffer.mode = 'segments'
      // Let the duration be known up-front so seeking before the end of
      // buffered range works.
      try { ms.duration = duration } catch { /* may not be settable yet */ }
    } catch (e) {
      console.error('MSE addSourceBuffer failed', e)
      return
    }
    void feedChunk()
  }
  ms.addEventListener('sourceopen', onSourceOpen, { once: true })

  return {
    url,
    cancel: () => {
      cancelled = true
      try {
        if (sourceBuffer && ms.readyState === 'open') {
          ms.removeSourceBuffer(sourceBuffer)
        }
      } catch { /* ignore */ }
      URL.revokeObjectURL(url)
    },
    setPlaybackTime: (t) => {
      playbackTime = t
      // Wake the feeder back up if it paused because of BUFFER_AHEAD_S.
      void feedChunk()
    },
  }
}
