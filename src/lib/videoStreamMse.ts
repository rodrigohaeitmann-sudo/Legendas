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
): Promise<StreamHandle> {
  // Step 1: extract a tiny probe chunk so we can read the actual codec
  // string from the avcC/hvcC box. Without the exact MSE codec string,
  // addSourceBuffer rejects everything.
  const probe = await extractMediaFmp4(file, videoId, audioTrackIndex, 0, 2)
  const codec = findAvcCodecString(probe) ?? findHevcCodecString(probe)
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
  // The 2 s probe is reused as the first init+media payload — no need to
  // re-run ffmpeg for chunk 0.
  let firstChunk: Uint8Array | null = probe

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
          // Plenty of buffer ahead — wait for the next setPlaybackTime poke.
          return
        }

        let bytes: Uint8Array
        let start: number
        let dur: number
        if (firstChunk) {
          bytes = firstChunk
          firstChunk = null
          start = 0
          // The probe ran with `-t 2` so we know its duration even without
          // demuxing the output. Pad with a fresh first chunk for the rest.
          dur = 2
        } else {
          start = extractedTo
          const chunkSec = start === 0 ? FIRST_CHUNK_S : NEXT_CHUNK_S
          dur = Math.min(chunkSec, duration - start)
          if (dur <= 0) {
            if (ms.readyState === 'open') {
              try { ms.endOfStream() } catch { /* ignore */ }
            }
            return
          }
          try {
            bytes = await extractMediaFmp4(file, videoId, audioTrackIndex, start, dur)
          } catch (e) {
            console.error('media chunk extract failed', e)
            return
          }
          if (cancelled || !sourceBuffer) return
        }

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
