import { useEffect, useRef, useState } from 'react'
import type { Cue, LoadedMedia, MergedCue } from '../types'
import { parseSubtitles } from '../lib/parseSubtitles'
import { phonemizeLines } from '../lib/phonemizer'
import { translateLines, type TranslationProgress } from '../lib/translateCues'
import { clearSession, saveSession } from '../lib/sessionStore'
import {
  clearCcProgress,
  loadCcProgress,
  saveCcProgress,
} from '../lib/ccCache'
import {
  extractAudio,
  transcribeAudio,
  WHISPER_MODELS,
  type CcProgress,
  type TranscribeHandle,
  type WhisperModel,
} from '../lib/transcribe'
import {
  detectLang,
  langLabel,
  SUPPORTED_LANGS,
  type SourceLang,
} from '../lib/detectLang'

interface Props {
  onReady: (media: LoadedMedia) => void
}

type SubtitleSource = 'srt' | 'audio'

type SetupProgress =
  | { kind: 'cc'; phase: CcProgress['phase']; pct: number | null }
  | { kind: 'translate'; p: TranslationProgress }

const EMAIL_KEY = 'legendas:mymemoryEmail'
const LANG_KEY = 'legendas:lastSourceLang'
const WHISPER_KEY = 'legendas:whisperModel'

function loadLastLang(): SourceLang {
  const stored = localStorage.getItem(LANG_KEY) as SourceLang | null
  return SUPPORTED_LANGS.some((l) => l.code === stored) ? (stored as SourceLang) : 'en'
}

function loadWhisperModel(): WhisperModel {
  const stored = localStorage.getItem(WHISPER_KEY) as WhisperModel | null
  return WHISPER_MODELS.some((m) => m.id === stored) ? (stored as WhisperModel) : 'base'
}

export default function FileSetup({ onReady }: Props) {
  const [subSource, setSubSource] = useState<SubtitleSource>('srt')
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [srtFile, setSrtFile] = useState<File | null>(null)
  const [srtText, setSrtText] = useState('')
  const [sourceLang, setSourceLang] = useState<SourceLang>(loadLastLang)
  const [detectedLang, setDetectedLang] = useState<SourceLang | null>(null)
  const [whisperModel, setWhisperModel] = useState<WhisperModel>(loadWhisperModel)
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_KEY) ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<SetupProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const transcribeRef = useRef<TranscribeHandle | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)

  // Mobile browsers auto-release the wake lock when the tab loses focus.
  // If the user comes back while a CC run is still going, re-acquire it
  // so the screen stays on for the rest of the work.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'visible' && progress !== null && wakeLockRef.current === null) {
        void acquireWakeLock(wakeLockRef)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [progress])

  const canStart =
    videoFile !== null &&
    (subSource === 'srt' ? srtFile !== null : true) &&
    progress === null

  function updateEmail(value: string) {
    setEmail(value)
    const trimmed = value.trim()
    if (trimmed) localStorage.setItem(EMAIL_KEY, trimmed)
    else localStorage.removeItem(EMAIL_KEY)
  }

  function updateSourceLang(value: SourceLang) {
    setSourceLang(value)
    localStorage.setItem(LANG_KEY, value)
  }

  function updateWhisperModel(value: WhisperModel) {
    setWhisperModel(value)
    localStorage.setItem(WHISPER_KEY, value)
  }

  async function pickSrt(file: File | null) {
    setSrtFile(file)
    setDetectedLang(null)
    if (!file) {
      setSrtText('')
      return
    }
    try {
      const text = await file.text()
      setSrtText(text)
      const detected = detectLang(text)
      setDetectedLang(detected)
      if (detected) {
        setSourceLang(detected)
        localStorage.setItem(LANG_KEY, detected)
      }
    } catch {
      setSrtText('')
    }
  }

  async function getSourceCues(): Promise<Cue[] | null> {
    if (subSource === 'srt') {
      if (!srtText) return null
      const cues = parseSubtitles(srtText)
      if (cues.length === 0) {
        setError('Não encontrei legendas no arquivo. Verifique o formato (.srt/.vtt).')
        return null
      }
      return cues
    }

    // CC mode: decode the video's audio track and transcribe it locally.
    const videoId = `${videoFile!.name}:${videoFile!.size}`
    const cached = await loadCcProgress(videoId, sourceLang, whisperModel)

    let audio: Float32Array
    if (cached?.audio) {
      // Skip the extract phase entirely — same file, same audio.
      audio = cached.audio
    } else {
      setProgress({ kind: 'cc', phase: 'decode', pct: null })
      try {
        audio = await extractAudio(videoFile!, (ratio) =>
          setProgress({ kind: 'cc', phase: 'decode', pct: ratio === null ? null : ratio * 100 }),
        )
      } catch (e) {
        console.error('audio extraction failed', e)
        const detail = e instanceof Error ? e.message : String(e)
        setError(`Falha ao extrair o áudio: ${detail}`)
        return null
      }
      // Persist the audio right after extract so the next resume can skip
      // straight to transcription.
      await saveCcProgress({
        videoId,
        lang: sourceLang,
        model: whisperModel,
        audio,
        cues: cached?.cues ?? [],
        windowIndex: cached?.windowIndex ?? 0,
        updatedAt: Date.now(),
      })
    }

    const handle = transcribeAudio(audio, sourceLang, whisperModel, (p) =>
      setProgress({ kind: 'cc', phase: p.phase, pct: p.pct }),
    {
      resumeCues: cached?.cues,
      resumeWindowIndex: cached?.windowIndex,
      onWindowDone: (cues, windowIndex) => {
        // Fire-and-forget; an in-flight save in progress when the next
        // window completes is fine because saveCcProgress is keyed by
        // videoId and overwrites.
        void saveCcProgress({
          videoId,
          lang: sourceLang,
          model: whisperModel,
          audio,
          cues,
          windowIndex,
          updatedAt: Date.now(),
        })
      },
    })
    transcribeRef.current = handle
    try {
      const cues = await handle.promise
      if (cues.length === 0) {
        setError('A transcrição não encontrou falas no áudio.')
        return null
      }
      return cues
    } catch {
      setError('Falha na transcrição. Verifique a conexão (o modelo é baixado na primeira vez).')
      return null
    } finally {
      transcribeRef.current = null
    }
  }

  async function handleStart() {
    if (!videoFile) return
    setError('')

    const controller = new AbortController()
    abortRef.current = controller
    await acquireWakeLock(wakeLockRef)
    try {
      const srcCues = await getSourceCues()
      if (!srcCues) {
        setProgress(null)
        return
      }
      if (controller.signal.aborted) return

      setProgress({
        kind: 'translate',
        p: { done: 0, total: srcCues.length, failed: 0, provider: null },
      })

      const srcTexts = srcCues.map((c) => c.text)

      const ipaPromise = phonemizeLines(srcTexts, sourceLang).catch(() =>
        srcTexts.map(() => ''),
      )
      const ptPromise = translateLines(srcTexts, {
        signal: controller.signal,
        onProgress: (p) => setProgress({ kind: 'translate', p }),
        email: email.trim() || undefined,
        source: sourceLang,
      })

      const [ipaLines, ptLines] = await Promise.all([ipaPromise, ptPromise])
      if (controller.signal.aborted) return

      const cues: MergedCue[] = srcCues.map((c, i) => ({
        start: c.start,
        end: c.end,
        en: c.text,
        pt: ptLines[i] ?? '',
        ipa: ipaLines[i] ?? '',
      }))

      const videoId = `${videoFile.name}:${videoFile.size}`
      await clearSession().catch(() => undefined)
      // CC progress is no longer needed — cues are now in the session store.
      void clearCcProgress().catch(() => undefined)
      onReady({ videoUrl: URL.createObjectURL(videoFile), videoId, cues })
      void saveSession({ videoId, videoBlob: videoFile, cues }).catch(() => {
        // best-effort: storage quota or private mode; app still works this session
      })
    } catch {
      setError('Falha ao processar a legenda.')
      setProgress(null)
    } finally {
      abortRef.current = null
      releaseWakeLock(wakeLockRef)
    }
  }

  function handleCancel() {
    transcribeRef.current?.cancel()
    transcribeRef.current = null
    abortRef.current?.abort()
    abortRef.current = null
    releaseWakeLock(wakeLockRef)
    setProgress(null)
  }

  const detectionHint =
    subSource === 'srt' && detectedLang !== null
      ? detectedLang === sourceLang
        ? `Detectado automaticamente: ${langLabel(detectedLang)}.`
        : `Detectado: ${langLabel(detectedLang)}.`
      : null

  return (
    <div className="setup">
      <h1>Treino de Listening</h1>
      <p className="setup-hint">
        Use um arquivo de legenda, ou gere closed captions direto do áudio do vídeo — útil
        quando as legendas disponíveis resumem as falas em vez de transcrevê-las.
      </p>

      <label className="file-field">
        <span>Vídeo (.mp4)</span>
        <input
          type="file"
          accept="video/mp4,video/*"
          onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
        />
        {videoFile && <small>{videoFile.name}</small>}
      </label>

      <div className="source-tabs">
        <button
          type="button"
          className={`source-tab ${subSource === 'srt' ? 'active' : ''}`}
          onClick={() => setSubSource('srt')}
        >
          Arquivo de legenda
        </button>
        <button
          type="button"
          className={`source-tab ${subSource === 'audio' ? 'active' : ''}`}
          onClick={() => setSubSource('audio')}
        >
          Gerar do áudio (CC)
        </button>
      </div>

      {subSource === 'srt' ? (
        <label className="file-field">
          <span>Legenda (.srt / .vtt)</span>
          <input
            type="file"
            accept=".srt,.vtt"
            onChange={(e) => pickSrt(e.target.files?.[0] ?? null)}
          />
          {srtFile && <small>{srtFile.name}</small>}
        </label>
      ) : (
        <label className="file-field">
          <span>Qualidade da transcrição</span>
          <select
            value={whisperModel}
            onChange={(e) => updateWhisperModel(e.target.value as WhisperModel)}
          >
            {WHISPER_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <small>
            A transcrição roda no seu aparelho (nada é enviado). O modelo é baixado uma única
            vez. Em celulares, prefira "Rápido" — mesmo assim pode levar vários minutos por
            episódio.
          </small>
        </label>
      )}

      <label className="file-field">
        <span>{subSource === 'srt' ? 'Idioma da legenda' : 'Idioma do áudio'}</span>
        <select
          value={sourceLang}
          onChange={(e) => updateSourceLang(e.target.value as SourceLang)}
        >
          {SUPPORTED_LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        {detectionHint && <small>{detectionHint}</small>}
      </label>

      <button
        type="button"
        className="advanced-toggle"
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? '− Avançado' : '+ Avançado'}
      </button>

      {showAdvanced && (
        <label className="file-field">
          <span>E-mail (opcional)</span>
          <input
            type="email"
            placeholder="seu@email.com"
            value={email}
            onChange={(e) => updateEmail(e.target.value)}
            autoComplete="email"
            inputMode="email"
          />
          <small>
            Sobe o limite diário gratuito do MyMemory para 50 mil palavras. Se a cota acabar
            mesmo assim, a tradução continua automaticamente pelo Google Translate.
          </small>
        </label>
      )}

      {error && <p className="setup-error">{error}</p>}

      <button className="start-btn" disabled={!canStart} onClick={handleStart}>
        Começar
      </button>

      {progress && <ProgressOverlay progress={progress} onCancel={handleCancel} />}
    </div>
  )
}

const CC_TITLES: Record<CcProgress['phase'], string> = {
  decode: 'Extraindo áudio…',
  model: 'Baixando modelo de transcrição…',
  transcribe: 'Transcrevendo áudio…',
}

async function acquireWakeLock(ref: { current: WakeLockSentinel | null }) {
  if (ref.current) return
  try {
    const wl = await navigator.wakeLock?.request('screen')
    if (!wl) return
    ref.current = wl
    wl.addEventListener('release', () => {
      if (ref.current === wl) ref.current = null
    })
  } catch {
    // user denied, no permission, or unsupported — work proceeds, but the
    // user will need to keep the screen on themselves.
  }
}

function releaseWakeLock(ref: { current: WakeLockSentinel | null }) {
  const wl = ref.current
  ref.current = null
  if (wl) {
    void wl.release().catch(() => undefined)
  }
}

function ProgressOverlay({
  progress,
  onCancel,
}: {
  progress: SetupProgress
  onCancel: () => void
}) {
  let title: string
  let detail: string
  let pct: number | null

  if (progress.kind === 'cc') {
    title = CC_TITLES[progress.phase]
    pct = progress.pct
    detail =
      progress.phase === 'transcribe'
        ? `${Math.round(pct ?? 0)}% — você pode trocar de app, o progresso é salvo`
        : pct !== null
          ? `${Math.round(pct)}%`
          : ''
  } else {
    const p = progress.p
    title = 'Traduzindo legenda…'
    pct = p.total > 0 ? (p.done / p.total) * 100 : 0
    const providerLabel =
      p.provider === 'google' ? 'Google' : p.provider === 'mymemory' ? 'MyMemory' : null
    detail =
      `${p.done}/${p.total} linhas` +
      (p.failed > 0 ? ` · ${p.failed} falharam` : '') +
      (providerLabel ? ` · via ${providerLabel}` : '')
  }

  return (
    <div className="progress-backdrop">
      <div className="progress-card">
        <h2>{title}</h2>
        {detail && <p className="progress-count">{detail}</p>}
        <div className={`progress-bar ${pct === null ? 'indeterminate' : ''}`}>
          <div
            className="progress-bar-fill"
            style={pct !== null ? { width: `${Math.round(pct)}%` } : undefined}
          />
        </div>
        <button className="progress-cancel" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
