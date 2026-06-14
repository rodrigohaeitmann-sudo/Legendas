// Thin wrapper around the Whisper worker (transcribeWorker.ts). The worker
// caches the model after first load — by keeping the same worker alive
// across chunks, the pipeline avoids the multi-second model warmup that
// would otherwise hit on every chunk.

import type { Cue } from '../types'
import type { SourceLang } from './detectLang'

export type WhisperModel = 'tiny' | 'base' | 'small'

export const WHISPER_MODELS: ReadonlyArray<{ id: WhisperModel; label: string }> = [
  { id: 'tiny', label: 'Rápido (~40 MB, menos preciso)' },
  { id: 'base', label: 'Equilibrado (~80 MB)' },
  { id: 'small', label: 'Preciso (~250 MB, lento)' },
]

export interface ModelProgress {
  pct: number | null
}

type Pending = {
  resolve: (cues: Cue[]) => void
  reject: (e: Error) => void
}

export class WhisperPool {
  private worker: Worker
  private pending: Pending | null = null
  private onModelProgress: (p: ModelProgress) => void
  private terminated = false

  constructor(onModelProgress: (p: ModelProgress) => void) {
    this.onModelProgress = onModelProgress
    this.worker = new Worker(new URL('./transcribeWorker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data
      if (msg.type === 'model-progress') {
        this.onModelProgress({ pct: msg.pct })
      } else if (msg.type === 'window-done') {
        const p = this.pending
        this.pending = null
        p?.resolve(msg.cues as Cue[])
      } else if (msg.type === 'error') {
        const p = this.pending
        this.pending = null
        p?.reject(new Error(msg.message))
      }
    }
    this.worker.onerror = (e: ErrorEvent) => {
      const p = this.pending
      this.pending = null
      p?.reject(new Error(e.message || 'worker error'))
    }
  }

  // Transcribes one audio chunk. `offsetSec` is added to the cue
  // timestamps so they're absolute against the full video timeline.
  transcribe(
    audio: Float32Array,
    offsetSec: number,
    lang: SourceLang,
    model: WhisperModel,
  ): Promise<Cue[]> {
    return new Promise<Cue[]>((resolve, reject) => {
      if (this.terminated) {
        reject(new Error('pool terminated'))
        return
      }
      if (this.pending) {
        reject(new Error('pool busy'))
        return
      }
      this.pending = { resolve, reject }
      this.worker.postMessage(
        { type: 'transcribe', audio, offset: offsetSec, lang, model },
        [audio.buffer],
      )
    })
  }

  terminate() {
    this.terminated = true
    this.worker.terminate()
    if (this.pending) {
      this.pending.reject(new Error('terminated'))
      this.pending = null
    }
  }
}
