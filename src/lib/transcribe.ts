// In-browser speech-to-text via Whisper (transformers.js), used to generate
// CC-style cues straight from the video's audio track when no faithful
// subtitle file exists (common for French, where most subs are simplified).
//
// Heavy work happens in a Web Worker (see transcribeWorker.ts). This module
// owns the browser-only part: decoding the MP4's audio to 16 kHz mono PCM,
// splitting it into windows at low-energy (silence-ish) points, and relaying
// progress.

import type { Cue } from '../types'
import type { SourceLang } from './detectLang'
import { extractAudioPcm } from './audioExtract'

export type WhisperModel = 'tiny' | 'base' | 'small'

export const WHISPER_MODELS: ReadonlyArray<{ id: WhisperModel; label: string }> = [
  { id: 'tiny', label: 'Rápido (~40 MB, menos preciso)' },
  { id: 'base', label: 'Equilibrado (~80 MB)' },
  { id: 'small', label: 'Preciso (~250 MB, lento)' },
]

export interface CcProgress {
  phase: 'decode' | 'model' | 'transcribe'
  pct: number | null
}

const SAMPLE_RATE = 16000
// Each worker call covers ~5 min of audio: long enough that whisper's own
// internal 30s chunking + stride does the stitching, short enough to give
// real progress updates and cancellation points between calls.
const WINDOW_S = 300
// How far around the nominal window edge we search for the quietest moment.
const EDGE_SEARCH_S = 5

export async function extractAudio(
  file: File,
  onProgress: (ratio: number | null) => void,
): Promise<Float32Array> {
  return extractAudioPcm(file, (p) => onProgress(p.ratio))
}

// Find the quietest 100ms frame within [center - radius, center + radius] so
// window boundaries fall in pauses instead of mid-word.
function quietestSplit(audio: Float32Array, center: number, radius: number): number {
  const frame = Math.floor(SAMPLE_RATE * 0.1)
  const from = Math.max(0, center - radius)
  const to = Math.min(audio.length - frame, center + radius)
  let best = center
  let bestEnergy = Infinity
  for (let i = from; i <= to; i += frame) {
    let e = 0
    for (let j = i; j < i + frame; j++) e += audio[j] * audio[j]
    if (e < bestEnergy) {
      bestEnergy = e
      best = i
    }
  }
  return best
}

// Window boundaries as sample indices; slices are materialized lazily, one at
// a time, so peak memory stays at master + current window.
function splitBoundaries(audio: Float32Array): number[] {
  const bounds: number[] = [0]
  const radius = SAMPLE_RATE * EDGE_SEARCH_S
  let start = 0
  while (start < audio.length) {
    const nominalEnd = start + WINDOW_S * SAMPLE_RATE
    const end =
      nominalEnd >= audio.length ? audio.length : quietestSplit(audio, nominalEnd, radius)
    bounds.push(end)
    start = end
  }
  return bounds
}

export interface TranscribeHandle {
  promise: Promise<Cue[]>
  cancel: () => void
}

export function transcribeAudio(
  audio: Float32Array,
  lang: SourceLang,
  model: WhisperModel,
  onProgress: (p: CcProgress) => void,
): TranscribeHandle {
  const worker = new Worker(new URL('./transcribeWorker.ts', import.meta.url), {
    type: 'module',
  })

  const bounds = splitBoundaries(audio)
  const windowCount = bounds.length - 1
  const totalSamples = audio.length
  let cancelled = false

  const promise = new Promise<Cue[]>((resolve, reject) => {
    const cues: Cue[] = []
    let windowIndex = 0

    function sendNext() {
      if (cancelled) return
      if (windowIndex >= windowCount) {
        worker.terminate()
        resolve(cues)
        return
      }
      const from = bounds[windowIndex]
      const to = bounds[windowIndex + 1]
      const samples = audio.slice(from, to)
      worker.postMessage(
        { type: 'transcribe', audio: samples, offset: from / SAMPLE_RATE, lang, model },
        [samples.buffer],
      )
    }

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data
      if (msg.type === 'model-progress') {
        onProgress({ phase: 'model', pct: msg.pct })
      } else if (msg.type === 'window-done') {
        for (const c of msg.cues as Cue[]) cues.push(c)
        windowIndex++
        const doneSamples = bounds[windowIndex]
        onProgress({
          phase: 'transcribe',
          pct: Math.min(99, (doneSamples / totalSamples) * 100),
        })
        sendNext()
      } else if (msg.type === 'error') {
        worker.terminate()
        reject(new Error(msg.message))
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'worker error'))
    }

    onProgress({ phase: 'model', pct: null })
    sendNext()
  })

  return {
    promise,
    cancel: () => {
      cancelled = true
      worker.terminate()
    },
  }
}
