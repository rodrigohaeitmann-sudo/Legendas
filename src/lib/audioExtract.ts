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
const PROBE_PATH = '/duration.txt'

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
  const ffmpeg = await ensureMounted(file, videoId)
  const rc = await ffmpeg.ffprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    `${MOUNT_DIR}/${file.name}`,
    '-o', PROBE_PATH,
  ])
  if (rc !== 0) throw new Error(`ffprobe exit ${rc}`)
  const data = await ffmpeg.readFile(PROBE_PATH)
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
  try { await ffmpeg.deleteFile(PROBE_PATH) } catch { /* ignore */ }
  const dur = parseFloat(text.trim())
  if (!isFinite(dur) || dur <= 0) {
    throw new Error('duração inválida do vídeo')
  }
  return dur
}

export interface RangeProgress {
  /** 0..1 within this single chunk, or null when ffmpeg can't report. */
  ratio: number | null
}

export async function extractAudioRange(
  file: File,
  videoId: string,
  startSec: number,
  durationSec: number,
  onProgress: (p: RangeProgress) => void,
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
    const rc = await ffmpeg.exec([
      '-ss', String(startSec),
      '-accurate_seek',
      '-t', String(durationSec),
      '-i', `${MOUNT_DIR}/${mountedName}`,
      '-vn',
      '-map', '0:a:0',
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
