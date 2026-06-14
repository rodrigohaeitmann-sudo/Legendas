// Builds MergedCues incrementally and pumps them into the player while
// playback is already running. Two source modes:
//
// - SRT: cues are known instantly; PT/IPA stream in next to playback.
// - CC:  chunk-by-chunk extract + Whisper. Each chunk (~3 min of audio)
//        is decoded with ffmpeg's input-level seek, fed to Whisper, then
//        annotated. The first cues land in ~1-2 min instead of waiting
//        for the entire file to be decoded.

import type { Cue, MergedCue } from '../types'
import type { SourceLang } from './detectLang'
import { extractAudioRange, probeDuration } from './audioExtract'
import { WhisperPool, type WhisperModel } from './transcribe'
import { parseSubtitles } from './parseSubtitles'
import { phonemizeLines } from './phonemizer'
import { translateLines, type ProviderId } from './translateCues'
import {
  clearCcProgress,
  loadCcProgress,
  saveCcProgress,
} from './ccCache'

const CHUNK_SECONDS = 180 // 3 min — short enough that the first cues
                          // appear quickly, long enough that Whisper's
                          // internal 30s context still lands inside one
                          // chunk most of the time.

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
  | {
      kind: 'cc'
      step: 'probe' | 'model' | 'extract' | 'transcribe'
      chunkIndex: number
      totalChunks: number
      pct: number | null
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
  onCuesReplaced: (cues: MergedCue[]) => void
  onCuesAppended: (newCues: MergedCue[]) => void
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
  let totalCount = 0
  let cancelled = false

  function abort() {
    cancelled = true
    controller.abort()
  }

  async function annotate(sourceTexts: string[], baseIndex: number) {
    if (cancelled || sourceTexts.length === 0) return

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

    // 1. Get duration — needed to compute chunk count up front.
    let duration: number
    if (cached?.duration && cached.duration > 0) {
      duration = cached.duration
    } else {
      cb.onPhase({ kind: 'cc', step: 'probe', chunkIndex: 0, totalChunks: 0, pct: null })
      try {
        duration = await probeDuration(config.videoFile, config.videoId)
      } catch (e) {
        cb.onPhase({
          kind: 'error',
          message: `Falha ao ler o vídeo: ${e instanceof Error ? e.message : String(e)}`,
        })
        return
      }
      if (cancelled) return
    }

    const totalChunks = Math.max(1, Math.ceil(duration / CHUNK_SECONDS))
    let chunkIndex = Math.min(cached?.chunkIndex ?? 0, totalChunks)
    const annotateJobs: Array<Promise<unknown>> = []
    const cuesAccum: Cue[] = [...(cached?.cues ?? [])]

    // Replay anything previously transcribed so the user can watch with
    // what's already done while we resume.
    if (cuesAccum.length) {
      const merged = cuesAccum.map(toMerged)
      cb.onCuesAppended(merged)
      totalCount += merged.length
      annotateJobs.push(annotate(cuesAccum.map((c) => c.text), 0))
    }

    const pool = new WhisperPool((p) => {
      if (cancelled) return
      cb.onPhase({
        kind: 'cc',
        step: 'model',
        chunkIndex,
        totalChunks,
        pct: p.pct,
      })
    })

    try {
      while (chunkIndex < totalChunks) {
        if (cancelled) return
        const startSec = chunkIndex * CHUNK_SECONDS
        const dur = Math.min(CHUNK_SECONDS, duration - startSec)
        if (dur <= 0) break

        cb.onPhase({
          kind: 'cc',
          step: 'extract',
          chunkIndex,
          totalChunks,
          pct: 0,
        })
        let audio: Float32Array
        try {
          audio = await extractAudioRange(config.videoFile, config.videoId, startSec, dur, (p) => {
            if (cancelled) return
            cb.onPhase({
              kind: 'cc',
              step: 'extract',
              chunkIndex,
              totalChunks,
              pct: p.ratio === null ? null : p.ratio * 100,
            })
          })
        } catch (e) {
          cb.onPhase({
            kind: 'error',
            message: `Falha ao extrair áudio do trecho ${chunkIndex + 1}/${totalChunks}: ${e instanceof Error ? e.message : String(e)}`,
          })
          return
        }
        if (cancelled) return
        if (audio.length === 0) {
          // empty range — skip and advance
          chunkIndex++
          continue
        }

        cb.onPhase({
          kind: 'cc',
          step: 'transcribe',
          chunkIndex,
          totalChunks,
          pct: null,
        })
        let chunkCues: Cue[]
        try {
          chunkCues = await pool.transcribe(audio, startSec, config.sourceLang, model)
        } catch (e) {
          cb.onPhase({
            kind: 'error',
            message: `Falha na transcrição do trecho ${chunkIndex + 1}/${totalChunks}: ${e instanceof Error ? e.message : String(e)}`,
          })
          return
        }
        if (cancelled) return

        if (chunkCues.length > 0) {
          const base = totalCount
          const merged = chunkCues.map(toMerged)
          cb.onCuesAppended(merged)
          totalCount += merged.length
          annotateJobs.push(annotate(chunkCues.map((c) => c.text), base))
          for (const c of chunkCues) cuesAccum.push(c)
        }

        chunkIndex++
        void saveCcProgress({
          videoId: config.videoId,
          lang: config.sourceLang,
          model,
          cues: cuesAccum,
          chunkIndex,
          duration,
          updatedAt: Date.now(),
        })
      }
    } finally {
      pool.terminate()
    }

    if (cancelled) return
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
