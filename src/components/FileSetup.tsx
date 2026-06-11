import { useRef, useState } from 'react'
import type { LoadedMedia, MergedCue } from '../types'
import { parseSubtitles } from '../lib/parseSubtitles'
import { phonemizeLines } from '../lib/phonemizer'
import { translateLines, type TranslationProgress } from '../lib/translateCues'
import { clearSession, saveSession } from '../lib/sessionStore'
import {
  detectLang,
  langLabel,
  SUPPORTED_LANGS,
  type SourceLang,
} from '../lib/detectLang'

interface Props {
  onReady: (media: LoadedMedia) => void
}

const EMAIL_KEY = 'legendas:mymemoryEmail'
const LANG_KEY = 'legendas:lastSourceLang'

function loadLastLang(): SourceLang {
  const stored = localStorage.getItem(LANG_KEY) as SourceLang | null
  return SUPPORTED_LANGS.some((l) => l.code === stored) ? (stored as SourceLang) : 'en'
}

export default function FileSetup({ onReady }: Props) {
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [srtFile, setSrtFile] = useState<File | null>(null)
  const [srtText, setSrtText] = useState('')
  const [sourceLang, setSourceLang] = useState<SourceLang>(loadLastLang)
  const [detectedLang, setDetectedLang] = useState<SourceLang | null>(null)
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_KEY) ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<TranslationProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const canStart = videoFile !== null && srtFile !== null && progress === null

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

  async function handleStart() {
    if (!videoFile || !srtFile || !srtText) return
    setError('')

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const srcCues = parseSubtitles(srtText)
      if (srcCues.length === 0) {
        setError('Não encontrei legendas no arquivo. Verifique o formato (.srt/.vtt).')
        return
      }

      setProgress({ done: 0, total: srcCues.length, failed: 0, provider: null })

      const srcTexts = srcCues.map((c) => c.text)

      // espeak-ng runs in a single batched call, so we just await it alongside
      // the translation pipeline. The wasm download dominates on first run; on
      // subsequent runs the browser serves it from cache.
      const ipaPromise = phonemizeLines(srcTexts, sourceLang).catch(() =>
        srcTexts.map(() => ''),
      )
      const ptPromise = translateLines(srcTexts, {
        signal: controller.signal,
        onProgress: setProgress,
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
      onReady({ videoUrl: URL.createObjectURL(videoFile), videoId, cues })
      void saveSession({ videoId, videoBlob: videoFile, cues }).catch(() => {
        // best-effort: storage quota or private mode; app still works this session
      })
    } catch {
      setError('Falha ao processar a legenda.')
      setProgress(null)
    } finally {
      abortRef.current = null
    }
  }

  function handleCancel() {
    abortRef.current?.abort()
    abortRef.current = null
    setProgress(null)
  }

  const detectionHint =
    detectedLang === null
      ? null
      : detectedLang === sourceLang
        ? `Detectado automaticamente: ${langLabel(detectedLang)}.`
        : `Detectado: ${langLabel(detectedLang)}.`

  return (
    <div className="setup">
      <h1>Treino de Listening</h1>
      <p className="setup-hint">
        Escolha o vídeo e a legenda. A tradução em português e a transcrição fonética (IPA) com
        fala conectada são geradas automaticamente.
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

      <label className="file-field">
        <span>Legenda (.srt / .vtt)</span>
        <input
          type="file"
          accept=".srt,.vtt"
          onChange={(e) => pickSrt(e.target.files?.[0] ?? null)}
        />
        {srtFile && <small>{srtFile.name}</small>}
      </label>

      <label className="file-field">
        <span>Idioma da legenda</span>
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

function ProgressOverlay({
  progress,
  onCancel,
}: {
  progress: TranslationProgress
  onCancel: () => void
}) {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  const providerLabel =
    progress.provider === 'google' ? 'Google' : progress.provider === 'mymemory' ? 'MyMemory' : null
  return (
    <div className="progress-backdrop">
      <div className="progress-card">
        <h2>Traduzindo legenda…</h2>
        <p className="progress-count">
          {progress.done}/{progress.total} linhas
          {progress.failed > 0 && ` · ${progress.failed} falharam`}
          {providerLabel && ` · via ${providerLabel}`}
        </p>
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <button className="progress-cancel" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
