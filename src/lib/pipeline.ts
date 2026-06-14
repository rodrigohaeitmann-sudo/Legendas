// Builds MergedCues incrementally and pumps them into the player while
// playback is already running. Two source modes:
//
// - SRT: cues are known instantly; PT/IPA stream in next to playback.
// - CC:  audio extract + Whisper run in the background, each window
//        appends new cues, which then get translated/phonemized.
//
// The pipeline owns no React state — it just exposes callbacks the caller
// (App) wires into setState. Cancel terminates every in-flight worker.

import type { Cue, MergedCue } from '../types'
import type { SourceLang } from './detectLang'
import {
  extractAudio,
  transcribeAudio,
  type CcProgress,
  type WhisperModel,
} from './transcribe'
import { parseSubtitles } from './parseSubtitles'
import { phonemizeLines } from './phonemizer'
import { translateLines, type ProviderId } from './translateCues'
import {
  clearCcProgress,
  loadCcProgress,
  saveCcProgress,
} from './ccCache'

export type SubtitleSource =
  | { kind: 'srt'; text: string }
  | { kind: 'cc'; whisperModel: WhisperModel }

export interface PipelineConfig {
  videoFile: File
  videoId: string
  source: SubtitleSource
  sourceLang: SourceLang
  email?: string
}

export type PipelinePhase =
  | { kind: 'idle' }
  | { kind: 'extract'; pct: number | null }
  | { kind: 'model'; pct: number | null }
  | {
      kind: 'transcribe'
      pct: number
      windowsDone: number
      totalWindows: number
    }
  | {
      kind: 'translate'
      done: number
      total: number
      failed: number
      provider: ProviderId | null
    }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

export interface PipelineCallbacks {
  /** Replace the whole cue list (used when SRT is parsed up front). */
  onCuesReplaced: (cues: MergedCue[]) => void
  /** Append new cues (CC mode: each Whisper window emits a batch). */
  onCuesAppended: (newCues: MergedCue[]) => void
  /** Patch a single cue in place (PT and IPA stream in after creation). */
  onCueUpdated: (index: number, patch: Partial<MergedCue>) => void
  onPhase: (phase: PipelinePhase) => void
}

export interface PipelineHandle {
  cancel: () => void
}

function toMerged(cue: Cue): MergedCue {
  return { start: cue.start, end: cue.end, en: cue.text, pt: '', ipa: '' }
}

export function startPipeline(
  config: PipelineConfig,
  cb: PipelineCallbacks,
): PipelineHandle {
  const controller = new AbortController()
  // Tracks the offset for index-aligned updates from translate/phonemize.
  // When new cues are appended (CC mode) we know they live at
  // [totalCount, totalCount + N), and any update by *local* index maps to
  // global = base + local.
  let totalCount = 0
  let cancelled = false

  function abort() {
    cancelled = true
    controller.abort()
  }

  // Translate + phonemize a batch of newly-available source cues. Updates
  // arrive line-by-line so the user sees PT/IPA appear next to the active
  // cue without waiting for the whole batch.
  async function annotate(sourceTexts: string[], baseIndex: number) {
    if (cancelled || sourceTexts.length === 0) return

    // espeak's batch call is fast (≤1s for hundreds of lines), so we just
    // run it once over the batch and fan out updates.
    const ipaPromise = phonemizeLines(sourceTexts, config.sourceLang)
      .then((lines) => {
        if (cancelled) return
        lines.forEach((ipa, i) => {
          if (ipa) cb.onCueUpdated(baseIndex + i, { ipa })
        })
      })
      .catch(() => undefined)

    const ptPromise = translateLines(sourceTexts, {
      signal: controller.signal,
      source: config.sourceLang,
      email: config.email,
      onLine: (i, pt) => {
        if (cancelled) return
        if (pt) cb.onCueUpdated(baseIndex + i, { pt })
      },
      onProgress: (p) => {
        if (cancelled) return
        // Only relevant when there's no CC streaming in progress. CC mode
        // re-publishes its own transcribe phase between translate batches,
        // so this gets overridden naturally.
        cb.onPhase({
          kind: 'translate',
          done: p.done,
          total: p.total,
          failed: p.failed,
          provider: p.provider,
        })
      },
    }).catch(() => undefined)

    await Promise.all([ipaPromise, ptPromise])
  }

  async function runSrt(text: string) {
    const srcCues = parseSubtitles(text)
    if (srcCues.length === 0) {
      cb.onPhase({ kind: 'error', message: 'Não encontrei legendas no arquivo.' })
      return
    }
    const merged = srcCues.map(toMerged)
    totalCount = merged.length
    cb.onCuesReplaced(merged)
    cb.onPhase({ kind: 'translate', done: 0, total: merged.length, failed: 0, provider: null })

    await annotate(srcCues.map((c) => c.text), 0)
    if (!cancelled) cb.onPhase({ kind: 'done' })
  }

  async function runCc(model: WhisperModel) {
    cb.onCuesReplaced([])
    totalCount = 0

    const cached = await loadCcProgress(config.videoId, config.sourceLang, model)

    let audio: Float32Array
    if (cached?.audio) {
      audio = cached.audio
    } else {
      cb.onPhase({ kind: 'extract', pct: null })
      try {
        audio = await extractAudio(config.videoFile, (ratio) => {
          if (cancelled) return
          cb.onPhase({ kind: 'extract', pct: ratio === null ? null : ratio * 100 })
        })
      } catch (e) {
        cb.onPhase({
          kind: 'error',
          message: `Falha ao extrair o áudio: ${e instanceof Error ? e.message : String(e)}`,
        })
        return
      }
      if (cancelled) return
      await saveCcProgress({
        videoId: config.videoId,
        lang: config.sourceLang,
        model,
        audio,
        cues: cached?.cues ?? [],
        windowIndex: cached?.windowIndex ?? 0,
        updatedAt: Date.now(),
      })
    }

    // Annotation runs in parallel with transcription, but "done" must wait
    // for both, otherwise the final cues land in the session store with
    // missing PT/IPA columns.
    const annotateJobs: Array<Promise<unknown>> = []

    if (cached?.cues?.length) {
      const merged = cached.cues.map(toMerged)
      cb.onCuesAppended(merged)
      totalCount += merged.length
      annotateJobs.push(annotate(cached.cues.map((c) => c.text), 0))
    }

    const handle = transcribeAudio(audio, config.sourceLang, model, (p: CcProgress) => {
      if (cancelled) return
      if (p.phase === 'model') {
        cb.onPhase({ kind: 'model', pct: p.pct })
      }
    }, {
      resumeCues: cached?.cues,
      resumeWindowIndex: cached?.windowIndex,
      onWindowDone: (cues, windowIndex, totalWindows) => {
        if (cancelled) return
        const newSourceCues = cues.slice(totalCount)
        if (newSourceCues.length > 0) {
          const base = totalCount
          const newMerged = newSourceCues.map(toMerged)
          cb.onCuesAppended(newMerged)
          totalCount += newMerged.length
          annotateJobs.push(annotate(newSourceCues.map((c) => c.text), base))
        }
        cb.onPhase({
          kind: 'transcribe',
          pct: (windowIndex / totalWindows) * 100,
          windowsDone: windowIndex,
          totalWindows,
        })
        void saveCcProgress({
          videoId: config.videoId,
          lang: config.sourceLang,
          model,
          audio,
          cues,
          windowIndex,
          updatedAt: Date.now(),
        })
      },
    })

    try {
      await handle.promise
    } catch (e) {
      if (!cancelled) {
        cb.onPhase({
          kind: 'error',
          message: `Falha na transcrição: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
      return
    }
    if (cancelled) return

    // Wait for every in-flight annotate batch before declaring done — the
    // session save in App reads media.cues, and we want PT/IPA finalized.
    await Promise.allSettled(annotateJobs)
    if (cancelled) return

    void clearCcProgress().catch(() => undefined)
    cb.onPhase({ kind: 'done' })
  }

  ;(async () => {
    try {
      if (config.source.kind === 'srt') {
        await runSrt(config.source.text)
      } else {
        await runCc(config.source.whisperModel)
      }
    } catch (e) {
      if (!cancelled) {
        cb.onPhase({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
      }
    }
  })()

  return { cancel: abort }
}
