// Decodes the first audio track of any container ffmpeg understands (MP4,
// MKV, AVI, MOV, …) into 16 kHz mono Float32 PCM, the format Whisper wants.
//
// The browser's native decodeAudioData refuses MKV outright and would also
// need to copy the entire file into a JS ArrayBuffer first — fine for short
// MP4 clips, fatal for a 1+ GB movie on mobile. ffmpeg.wasm mounts the File
// via WORKERFS, which reads ranges from disk on demand instead of copying.

const SAMPLE_RATE = 16000
const MOUNT_DIR = '/in'
const OUT_PATH = '/out.pcm'

export interface ExtractProgress {
  /** 0..1, or null when ffmpeg can't report progress for this container. */
  ratio: number | null
}

let ffmpegPromise: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | null = null

async function getFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
        import('@ffmpeg/ffmpeg'),
        import('@ffmpeg/util'),
      ])

      // Resolve in the main thread, where document.baseURI is the page URL.
      // The FFmpeg internal worker lives under /assets/, so passing a
      // relative URL to it would resolve against the worker location and
      // produce /Legendas/assets/ffmpeg/... instead of /Legendas/ffmpeg/...
      const coreSrc = new URL(
        `${import.meta.env.BASE_URL}ffmpeg/ffmpeg-core.js`,
        document.baseURI,
      ).toString()
      const wasmSrc = new URL(
        `${import.meta.env.BASE_URL}ffmpeg/ffmpeg-core.wasm`,
        document.baseURI,
      ).toString()
      console.debug('[ffmpeg] fetching core from', coreSrc, 'wasm from', wasmSrc)

      // Convert to blob: URLs before handing them to ffmpeg. blob: URLs
      // have no path, so they can't be misresolved by code running in a
      // worker context — this is the canonical workaround the ffmpeg.wasm
      // team recommends for Vite/webpack deployments.
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

export async function extractAudioPcm(
  file: File,
  onProgress: (p: ExtractProgress) => void,
): Promise<Float32Array> {
  const { FFFSType } = await import('@ffmpeg/ffmpeg')
  const ffmpeg = await getFfmpeg()

  const progressListener = ({ progress }: { progress: number }) => {
    // ffmpeg reports progress in 0..1 but can briefly overshoot or drop
    // negative on some containers; clamp before exposing.
    const clamped = Math.max(0, Math.min(1, progress))
    onProgress({ ratio: clamped })
  }
  ffmpeg.on('progress', progressListener)

  try {
    onProgress({ ratio: null })
    // WORKERFS keeps the File backed by the browser's File handle. We only
    // pay RAM for the (much smaller) output PCM, not for the source video.
    await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, MOUNT_DIR)
    const inputPath = `${MOUNT_DIR}/${file.name}`

    // -vn: ignore video. -map 0:a:0: take the first audio track (Brazilian
    // dual releases typically have the original language on track 0, but
    // not always — exposed as a future setting if needed).
    // -ac 1 -ar 16000: mono at Whisper's required sample rate.
    // -f f32le: write raw little-endian 32-bit float PCM, no container, so
    // we can reinterpret the bytes as Float32Array with zero parsing.
    const rc = await ffmpeg.exec([
      '-i', inputPath,
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
    // The PCM buffer is byte-aligned but not guaranteed Float32-aligned, so
    // copy through a fresh ArrayBuffer rather than aliasing.
    const aligned = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(aligned).set(bytes)
    const pcm = new Float32Array(aligned)

    // Best-effort cleanup so a follow-up CC run starts fresh.
    try { await ffmpeg.deleteFile(OUT_PATH) } catch { /* ignore */ }
    try { await ffmpeg.unmount(MOUNT_DIR) } catch { /* ignore */ }

    return pcm
  } finally {
    ffmpeg.off('progress', progressListener)
  }
}
