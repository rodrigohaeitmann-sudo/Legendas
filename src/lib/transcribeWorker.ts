// Web Worker that runs Whisper via transformers.js. Receives ~5-minute audio
// windows from transcribe.ts, emits per-window cues with absolute timestamps.
// The pipeline (and downloaded model) is created once and reused across
// windows; transformers.js caches model files in Cache Storage, so the
// download cost is paid only on the very first run.

import { pipeline, env } from '@huggingface/transformers'
import type { Cue } from '../types'

env.allowLocalModels = false

const MODEL_IDS: Record<string, string> = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
}

type Transcriber = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ chunks?: Array<{ timestamp: [number, number | null]; text: string }> }>

let transcriberPromise: Promise<Transcriber> | null = null

function getTranscriber(model: string): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      // Aggregate download progress across all model files.
      const files = new Map<string, { loaded: number; total: number }>()
      const progress_callback = (p: {
        status: string
        file?: string
        loaded?: number
        total?: number
      }) => {
        if (p.status === 'progress' && p.file && p.total) {
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total })
          let loaded = 0
          let total = 0
          for (const f of files.values()) {
            loaded += f.loaded
            total += f.total
          }
          self.postMessage({ type: 'model-progress', pct: (loaded / total) * 100 })
        }
      }

      const id = MODEL_IDS[model] ?? MODEL_IDS.base
      // WebGPU is roughly an order of magnitude faster when available; fall
      // back to WASM otherwise (or if instantiation fails mid-way).
      try {
        if ('gpu' in navigator) {
          return (await pipeline('automatic-speech-recognition', id, {
            device: 'webgpu',
            dtype: 'q8',
            progress_callback,
          })) as unknown as Transcriber
        }
      } catch {
        // fall through to wasm
      }
      return (await pipeline('automatic-speech-recognition', id, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback,
      })) as unknown as Transcriber
    })()
  }
  return transcriberPromise
}

self.onmessage = async (e: MessageEvent) => {
  const { type, audio, offset, lang, model } = e.data as {
    type: string
    audio: Float32Array
    offset: number
    lang: string
    model: string
  }
  if (type !== 'transcribe') return

  try {
    const transcriber = await getTranscriber(model)
    const windowDuration = audio.length / 16000
    const out = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: lang,
      task: 'transcribe',
      return_timestamps: true,
    })

    const cues: Cue[] = []
    for (const chunk of out.chunks ?? []) {
      const text = chunk.text.trim()
      if (!text) continue
      const start = (chunk.timestamp[0] ?? 0) + offset
      const end = (chunk.timestamp[1] ?? windowDuration) + offset
      // Whisper occasionally hallucinates repeated identical segments over
      // music/silence; drop exact consecutive duplicates.
      const prev = cues[cues.length - 1]
      if (prev && prev.text === text && start - prev.end < 1) {
        prev.end = end
        continue
      }
      cues.push({ start, end, text })
    }
    self.postMessage({ type: 'window-done', cues })
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
