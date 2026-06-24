// MSE-backed combined video+audio streaming for dual-audio files: replaces
// the earlier dual-element approach (muted <video> + separate <audio>), which
// suffered cumulative drift because two HTMLMediaElements have independent
// clocks. Here we package the video stream + the user's chosen audio track
// into a single fragmented MP4 stream and feed it to a SourceBuffer on the
// real <video> element — the browser's media engine handles A/V sync
// internally, eliminating drift entirely.
//
// Chunks come from ffmpeg.wasm with `-c:v copy -c:a aac`, so video is
// pixel-perfect and the only re-encode is the small audio stream.

import { extractMediaFmp4 } from './audioExtract'

// First chunk small so playback starts quickly; subsequent chunks bigger to
// amortise per-call ffmpeg overhead. Buffer ahead controls how far past the
// playhead we extract before pausing the feeder.
const FIRST_CHUNK_S = 8
const NEXT_CHUNK_S = 30
const BUFFER_AHEAD_S = 60

export interface StreamProgress {
  /** True once the very first chunk has landed and playback can start. */
  firstReady: boolean
  /** Seconds of media already appended to the SourceBuffer. */
  bufferedTo: number
  /** Total media duration in seconds. */
  duration: number
}

export interface StreamHandle {
  /** Object URL to assign to the <video> element's src. */
  url: string
  /** Tear everything down — releases the MediaSource + URL + cancels feeds. */
  cancel: () => void
  /** Notify of playhead movement so the feeder pulls ahead at the right pace. */
  setPlaybackTime: (t: number) => void
}

export interface CachedChunkInput {
  start: number
  dur: number
  bytes: Uint8Array
}

export interface CreateVideoStreamOptions {
  /** fMP4 chunks previously extracted in another session — replayed verbatim
   *  so we don't re-run ffmpeg over an already-processed range. Must be
   *  sorted by `start` and form a contiguous range from 0. */
  cachedChunks?: CachedChunkInput[]
  /** Fired whenever a fresh chunk lands (not for cached ones) so the
   *  caller can persist it to IDB for next-session resume. */
  onChunkExtracted?: (start: number, dur: number, bytes: Uint8Array) => void
}

// Walks the top-level boxes of a fragmented MP4 and returns everything from
// the first moof onwards. Used to strip ftyp + moov from chunks 2..N so the
// SourceBuffer keeps the init segment from chunk 1 and only appends new
// media data.
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
  return bytes
}

// Locates the avcC box (H.264 codec configuration) in the fMP4 init segment
// and reads the three bytes that uniquely identify an H.264 codec string
// (profile_idc, constraint flags, level_idc). MSE requires the exact codec
// string in the addSourceBuffer MIME — close-but-wrong rejections at the
// SourceBuffer.appendBuffer level.
function findAvcCodecString(bytes: Uint8Array): string | null {
  // 'avcC' = 0x61 0x76 0x63 0x43
  for (let i = 0; i + 8 < bytes.length; i++) {
    if (
      bytes[i] === 0x61 &&
      bytes[i + 1] === 0x76 &&
      bytes[i + 2] === 0x63 &&
      bytes[i + 3] === 0x43
    ) {
      // Box layout: [4: 'avcC'] [1: configurationVersion] [1: profile]
      // [1: profile_compatibility] [1: level], then SPS/PPS data.
      const profile = bytes[i + 5]
      const compat = bytes[i + 6]
      const level = bytes[i + 7]
      const hex = (n: number) => n.toString(16).padStart(2, '0')
      return `avc1.${hex(profile)}${hex(compat)}${hex(level)}`
    }
  }
  return null
}

// Same for HEVC (hev1/hvc1). hvcC layout is more involved than avcC, but
// the profile/level fields we need sit at known offsets right after the
// 8-byte box header.
function findHevcCodecString(bytes: Uint8Array): string | null {
  for (let i = 0; i + 24 < bytes.length; i++) {
    if (
      bytes[i] === 0x68 &&
      bytes[i + 1] === 0x76 &&
      bytes[i + 2] === 0x63 &&
      bytes[i + 3] === 0x43
    ) {
      // Skip 'hvcC' (4) + configurationVersion (1).
      const base = i + 5
      const profileSpace = (bytes[base] >> 6) & 0x03
      const tierFlag = (bytes[base] >> 5) & 0x01
      const profileIdc = bytes[base] & 0x1f
      const constraintFlags = bytes.subarray(base + 5, base + 11) // 6 bytes
      const levelIdc = bytes[base + 11]
      const profSpace = profileSpace === 0 ? '' : ['A', 'B', 'C'][profileSpace - 1]
      const tier = tierFlag === 0 ? 'L' : 'H'
      const compatHex = Array.from(constraintFlags)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .replace(/0+$/, '')
      return `hev1.${profSpace}${profileIdc}.${compatHex || '0'}.${tier}${levelIdc}`
    }
  }
  return null
}

function waitForUpdate(sb: SourceBuffer): Promise<void> {
  if (!sb.updating) return Promise.resolve()
  return new Promise((resolve) => {
    sb.addEventListener('updateend', () => resolve(), { once: true })
  })
}

export async function createVideoStream(
  file: File,
  videoId: string,
  audioTrackIndex: number,
  duration: number,
  onProgress: (p: StreamProgress) => void,
  opts: CreateVideoStreamOptions = {},
): Promise<StreamHandle> {
  // Step 1: get a chunk starting at 0 from which to read the codec string.
  // If a cached chunk exists for that range we reuse its bytes; otherwise
  // we ffmpeg-extract a tiny probe chunk. This means resumed sessions
  // never pay the probe cost again.
  const cached = (opts.cachedChunks ?? []).filter((c) => c.dur > 0).sort((a, b) => a.start - b.start)
  const cachedHead = cached[0]?.start === 0 ? cached[0] : null
  const probeBytes = cachedHead?.bytes ?? (await extractMediaFmp4(file, videoId, audioTrackIndex, 0, 2))
  const probeDur = cachedHead?.dur ?? 2
  const codec = findAvcCodecString(probeBytes) ?? findHevcCodecString(probeBytes)
  if (!codec) {
    throw new Error('codec de vídeo não detectado no fMP4 — provavelmente formato não suportado')
  }
  const mimeType = `video/mp4; codecs="${codec}, mp4a.40.2"`
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mimeType)) {
    throw new Error(`navegador não toca ${mimeType}`)
  }

  const ms = new MediaSource()
  const url = URL.createObjectURL(ms)
  let sourceBuffer: SourceBuffer | null = null
  let extractedTo = 0
  let playbackTime = 0
  let cancelled = false
  let firstReady = false
  let feedingActive = false
  // Queue of bytes already produced and waiting to be appended:
  // - The probe (or cached chunk 0) goes first.
  // - Any cached chunks with start > 0 follow, in order.
  // After this queue drains, the loop starts extracting from extractedTo.
  type Pending = { bytes: Uint8Array; start: number; dur: number; fromCache: boolean }
  const pending: Pending[] = []
  pending.push({ bytes: probeBytes, start: 0, dur: probeDur, fromCache: !!cachedHead })
  for (const c of cached) {
    if (c.start === 0) continue
    pending.push({ bytes: c.bytes, start: c.start, dur: c.dur, fromCache: true })
  }

  async function feedChunk() {
    if (feedingActive) return
    feedingActive = true
    try {
      while (!cancelled && sourceBuffer) {
        if (extractedTo >= duration && pending.length === 0) {
          if (ms.readyState === 'open') {
            try { ms.endOfStream() } catch { /* may already be ended */ }
          }
          return
        }
        if (
          pending.length === 0 &&
          extractedTo - playbackTime > BUFFER_AHEAD_S
        ) {
          // Plenty of buffer ahead — wait for the next setPlaybackTime poke.
          return
        }

        let next: Pending
        if (pending.length > 0) {
          next = pending.shift()!
        } else {
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
            bytes = await extractMediaFmp4(file, videoId, audioTrackIndex, start, dur)
          } catch (e) {
            console.error('media chunk extract failed', e)
            return
          }
          if (cancelled || !sourceBuffer) return
          next = { bytes, start, dur, fromCache: false }
        }

        const dataToFeed = next.start === 0 ? next.bytes : stripInitSegment(next.bytes)
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

        // extractedTo always advances to the end of the latest chunk we
        // appended, whether it came from cache or fresh extraction.
        extractedTo = Math.max(extractedTo, next.start + next.dur)
        if (!firstReady) firstReady = true
        if (!next.fromCache) opts.onChunkExtracted?.(next.start, next.dur, next.bytes)
        onProgress({ firstReady, bufferedTo: extractedTo, duration })
      }
    } finally {
      feedingActive = false
    }
  }

  ms.addEventListener('sourceopen', () => {
    if (cancelled) return
    try {
      sourceBuffer = ms.addSourceBuffer(mimeType)
      sourceBuffer.mode = 'segments'
      try { ms.duration = duration } catch { /* may not be settable yet */ }
    } catch (e) {
      console.error('MSE addSourceBuffer failed', e)
      return
    }
    void feedChunk()
  }, { once: true })

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
      void feedChunk()
    },
  }
}
