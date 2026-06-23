// Decodes the first audio track of any container ffmpeg understands (MP4,
// MKV, AVI, MOV, …) into 16 kHz mono Float32 PCM, the format Whisper wants.
//
// The browser's native decodeAudioData refuses MKV outright and would also
// need to copy the entire file into a JS ArrayBuffer first. ffmpeg.wasm
// mounts the File via WORKERFS so reads happen on demand, and we use the
// fast input-level seek (`-ss` before `-i`) to pull short ranges so the
// pipeline can start transcribing the first minutes of audio without
// waiting for the whole file to decode.

const SAMPLE_RATE = 16000
const MOUNT_DIR = '/in'
const OUT_PATH = '/out.pcm'

let ffmpegPromise: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | null = null
// Which videoId is currently mounted at MOUNT_DIR. Mounting is cheap (no
// copy) but ffmpeg can only hold one WORKERFS mount at a time, so swapping
// videos forces an unmount + remount.
let mountedVideoId: string | null = null
let mountedName: string | null = null

async function getFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
        import('@ffmpeg/ffmpeg'),
        import('@ffmpeg/util'),
      ])

      const coreSrc = new URL(
        `${import.meta.env.BASE_URL}ffmpeg/ffmpeg-core.js`,
        document.baseURI,
      ).toString()
      const wasmSrc = new URL(
        `${import.meta.env.BASE_URL}ffmpeg/ffmpeg-core.wasm`,
        document.baseURI,
      ).toString()

      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(coreSrc, 'text/javascript'),
        toBlobURL(wasmSrc, 'application/wasm'),
      ])

      const ffmpeg = new FFmpeg()
      ffmpeg.on('log', ({ message }) => {
        if (message) console.debug('[ffmpeg]', message)
      })
      try {
        await ffmpeg.load({ coreURL, wasmURL })
      } catch (e) {
        ffmpegPromise = null
        throw new Error(
          `Falha ao carregar ffmpeg.wasm (${e instanceof Error ? e.message : String(e)}).`,
        )
      }
      return ffmpeg
    })()
  }
  return ffmpegPromise
}

async function ensureMounted(file: File, videoId: string) {
  const { FFFSType } = await import('@ffmpeg/ffmpeg')
  const ffmpeg = await getFfmpeg()
  if (mountedVideoId === videoId) return ffmpeg

  if (mountedVideoId !== null) {
    try { await ffmpeg.unmount(MOUNT_DIR) } catch { /* ignore */ }
    mountedVideoId = null
    mountedName = null
  }
  try {
    await ffmpeg.createDir(MOUNT_DIR)
  } catch { /* already exists */ }

  try {
    await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, MOUNT_DIR)
  } catch (e) {
    throw new Error(`mount falhou: ${describeError(e)}`)
  }
  mountedVideoId = videoId
  mountedName = file.name
  return ffmpeg
}

export async function probeDuration(file: File, videoId: string): Promise<number> {
  // Primary: ask the browser. Free, near-instant, and the browser must
  // already be able to demux this file (we're about to play it). This
  // avoids the ffmpeg-core ffprobe path entirely, which on mobile WASM
  // has been seen to abort with exit -1 against some MKV releases.
  try {
    return await probeViaMediaElement(file)
  } catch (e) {
    console.debug('[probe] media element failed:', e)
  }

  // Fallback: parse "Duration: HH:MM:SS.MS" out of ffmpeg's own stderr
  // when running with -i and no output. ffmpeg exits non-zero in this
  // mode (no output file specified) but emits the stream summary first,
  // which is all we need.
  const ffmpeg = await ensureMounted(file, videoId)
  let stderr = ''
  const handler = ({ message }: { message?: string }) => {
    if (message) stderr += message + '\n'
  }
  ffmpeg.on('log', handler)
  try {
    await ffmpeg.exec(['-i', `${MOUNT_DIR}/${mountedName}`])
  } catch {
    /* expected to exit with non-zero */
  } finally {
    ffmpeg.off('log', handler)
  }
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) {
    throw new Error('não encontrei a duração no log do ffmpeg')
  }
  const dur = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  if (!isFinite(dur) || dur <= 0) {
    throw new Error('duração inválida no log do ffmpeg')
  }
  return dur
}

async function probeViaMediaElement(file: File): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      video.src = ''
      fn()
    }
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => {
      const d = video.duration
      if (Number.isFinite(d) && d > 0) settle(() => resolve(d))
      else settle(() => reject(new Error('duração inválida via <video>')))
    }
    video.onerror = () => settle(() => reject(new Error('<video> não decodificou o arquivo')))
    // Don't block the pipeline forever if the browser can't load metadata.
    setTimeout(() => settle(() => reject(new Error('timeout ao ler metadados'))), 8000)
    video.src = url
  })
}

export interface RangeProgress {
  /** 0..1 within this single chunk, or null when ffmpeg can't report. */
  ratio: number | null
}

export interface AudioTrack {
  /** Index among audio streams only — what `-map 0:a:N` expects. */
  index: number
  /** Codec name as reported by ffmpeg (aac, ac3, eac3, dts, opus, …). */
  codec: string
  /** ISO 639-1/2 language tag from the container, if present. */
  language?: string
  /** Number of channels (1=mono, 2=stereo, 6=5.1, …). */
  channels?: number
  /** Whether the container marks this as the default audio. */
  isDefault: boolean
}

// Pulls the audio-stream summary out of `ffmpeg -i <file>` stderr. We use
// our existing ffmpeg singleton + mount, so the only cost is one extra
// no-output run; on MKVs with dual audio this is exactly what the user
// needs in order to pick the right language for CC.
export async function probeAudioTracks(file: File, videoId: string): Promise<AudioTrack[]> {
  const ffmpeg = await ensureMounted(file, videoId)
  let stderr = ''
  const handler = ({ message }: { message?: string }) => {
    if (message) stderr += message + '\n'
  }
  ffmpeg.on('log', handler)
  try {
    await ffmpeg.exec(['-i', `${MOUNT_DIR}/${mountedName}`])
  } catch {
    /* exits non-zero because no output is specified */
  } finally {
    ffmpeg.off('log', handler)
  }
  return parseAudioStreams(stderr)
}

function parseAudioStreams(stderr: string): AudioTrack[] {
  // Match lines like:
  //   Stream #0:1(fre): Audio: aac (LC), 48000 Hz, stereo, fltp, 192 kb/s (default)
  //   Stream #0:2(por): Audio: ac3, 48000 Hz, 5.1(side), fltp, 384 kb/s
  //   Stream #0:1[0x82]: Audio: ac3, 48000 Hz, stereo, fltp, 192 kb/s
  const re =
    /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\(([^)]+)\))?(?:[^:\n]*?)?:\s*Audio:\s*([A-Za-z0-9_]+)(?:\s*\([^)]*\))?(?:[^,]*?)(?:,\s*(\d+)\s*Hz)?(?:,\s*([^,(\n]+(?:\([^)]*\))?))?/g
  const tracks: AudioTrack[] = []
  let audioIdx = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(stderr)) !== null) {
    // Whole match line (re.lastIndex is just past it); look behind to see if
    // "(default)" appears on the same line.
    const lineStart = stderr.lastIndexOf('\n', m.index) + 1
    const lineEnd = stderr.indexOf('\n', re.lastIndex)
    const line = stderr.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    tracks.push({
      index: audioIdx,
      language: m[1] || undefined,
      codec: (m[2] || 'audio').toLowerCase(),
      channels: m[4] ? parseChannelLabel(m[4]) : undefined,
      isDefault: /\(default\)/.test(line),
    })
    audioIdx++
  }
  return tracks
}

function parseChannelLabel(label: string): number | undefined {
  const cleaned = label.trim().toLowerCase()
  if (cleaned === 'mono') return 1
  if (cleaned === 'stereo') return 2
  if (cleaned.startsWith('5.1')) return 6
  if (cleaned.startsWith('7.1')) return 8
  if (cleaned.startsWith('2.1')) return 3
  const m = cleaned.match(/^(\d+)\s*channels?/)
  return m ? Number(m[1]) : undefined
}

export async function extractAudioRange(
  file: File,
  videoId: string,
  startSec: number,
  durationSec: number,
  onProgress: (p: RangeProgress) => void,
  audioTrackIndex = 0,
): Promise<Float32Array> {
  const ffmpeg = await ensureMounted(file, videoId)

  const progressListener = ({ progress }: { progress: number }) => {
    const clamped = Math.max(0, Math.min(1, progress))
    onProgress({ ratio: clamped })
  }
  ffmpeg.on('progress', progressListener)
  onProgress({ ratio: null })

  try {
    // -ss BEFORE -i: input-level seek (jumps to nearest keyframe, fast).
    // Followed by -accurate_seek so the decoded range still starts at the
    // exact requested second — Whisper timestamps would otherwise drift by
    // whatever the keyframe interval is (~1-2s for most MKV releases).
    // -map 0:a:<index> picks the chosen audio track (defaults to the first
    // one, but dual-audio MKVs often need a specific one).
    const rc = await ffmpeg.exec([
      '-ss', String(startSec),
      '-accurate_seek',
      '-t', String(durationSec),
      '-i', `${MOUNT_DIR}/${mountedName}`,
      '-vn',
      '-map', `0:a:${audioTrackIndex}`,
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      OUT_PATH,
    ])
    if (rc !== 0) throw new Error(`ffmpeg exit ${rc}`)

    const data = await ffmpeg.readFile(OUT_PATH)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const aligned = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(aligned).set(bytes)
    try { await ffmpeg.deleteFile(OUT_PATH) } catch { /* ignore */ }
    return new Float32Array(aligned)
  } finally {
    ffmpeg.off('progress', progressListener)
  }
}

function describeError(e: unknown): string {
  if (e && typeof e === 'object') {
    const obj = e as { message?: unknown; errno?: unknown; code?: unknown; name?: unknown }
    const parts: string[] = []
    if (obj.name) parts.push(String(obj.name))
    if (obj.message) parts.push(String(obj.message))
    if (obj.code) parts.push(`code=${String(obj.code)}`)
    if (obj.errno !== undefined) parts.push(`errno=${String(obj.errno)}`)
    if (parts.length) return parts.join(' · ')
  }
  return String(e)
}
