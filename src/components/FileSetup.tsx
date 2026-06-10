import { useRef, useState } from 'react'
import type { LoadedMedia, MergedCue } from '../types'
import { parseSubtitles } from '../lib/parseSubtitles'
import { linesToIpa, preloadIpa } from '../lib/ipa'
import { translateLines, type TranslationProgress } from '../lib/translateCues'
import { clearSession, saveSession } from '../lib/sessionStore'

interface Props {
  onReady: (media: LoadedMedia) => void
}

type SourceMode = 'file' | 'url'

const EMAIL_KEY = 'legendas:mymemoryEmail'
const URL_KEY = 'legendas:lastVideoUrl'

export default function FileSetup({ onReady }: Props) {
  const [sourceMode, setSourceMode] = useState<SourceMode>('file')
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoUrl, setVideoUrl] = useState(() => localStorage.getItem(URL_KEY) ?? '')
  const [enFile, setEnFile] = useState<File | null>(null)
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_KEY) ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<TranslationProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const sourceReady =
    sourceMode === 'file' ? videoFile !== null : videoUrl.trim() !== ''
  const canStart = sourceReady && enFile !== null && progress === null

  function updateEmail(value: string) {
    setEmail(value)
    const trimmed = value.trim()
    if (trimmed) localStorage.setItem(EMAIL_KEY, trimmed)
    else localStorage.removeItem(EMAIL_KEY)
  }

  function updateVideoUrl(value: string) {
    setVideoUrl(value)
    const trimmed = value.trim()
    if (trimmed) localStorage.setItem(URL_KEY, trimmed)
    else localStorage.removeItem(URL_KEY)
  }

  async function handleStart() {
    if (!enFile) return
    setError('')

    // Resolve the video source up front so we can fail fast on a bad URL
    // before kicking off the translation work.
    let mediaUrl: string
    let videoId: string
    let videoBlob: File | null = null
    if (sourceMode === 'file') {
      if (!videoFile) return
      mediaUrl = URL.createObjectURL(videoFile)
      videoId = `${videoFile.name}:${videoFile.size}`
      videoBlob = videoFile
    } else {
      const url = videoUrl.trim()
      try {
        const parsed = new URL(url)
        if (!/^https?:$/.test(parsed.protocol)) throw new Error('protocol')
      } catch {
        setError('URL inválida. Use http:// ou https://')
        return
      }
      mediaUrl = url
      videoId = `url:${url}`
    }

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const enCues = parseSubtitles(await enFile.text())
      if (enCues.length === 0) {
        setError('Não encontrei legendas no arquivo de inglês. Verifique o formato (.srt/.vtt).')
        return
      }

      setProgress({ done: 0, total: enCues.length, failed: 0, provider: null })

      const enTexts = enCues.map((c) => c.text)

      // IPA is offline and fast; kick off the dict load while translation runs.
      const ipaPromise = preloadIpa().then(() => linesToIpa(enTexts))
      const ptPromise = translateLines(enTexts, {
        signal: controller.signal,
        onProgress: setProgress,
        email: email.trim() || undefined,
      })

      const [ipaLines, ptLines] = await Promise.all([ipaPromise, ptPromise])
      if (controller.signal.aborted) return

      const cues: MergedCue[] = enCues.map((c, i) => ({
        start: c.start,
        end: c.end,
        en: c.text,
        pt: ptLines[i] ?? '',
        ipa: ipaLines[i] ?? '',
      }))

      // Always drop the previous persisted session: in URL mode we don't save
      // a new one (no blob), and in file mode the save below replaces it.
      await clearSession().catch(() => undefined)
      onReady({ videoUrl: mediaUrl, videoId, cues })
      if (videoBlob) {
        void saveSession({ videoId, videoBlob, cues }).catch(() => {
          // best-effort: storage quota or private mode; app still works this session
        })
      }
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

  return (
    <div className="setup">
      <h1>Treino de Listening</h1>
      <p className="setup-hint">
        Escolha um vídeo local ou cole a URL do servidor do Stremio. A tradução em português e
        a transcrição fonética (IPA) são geradas automaticamente.
      </p>

      <div className="source-tabs">
        <button
          type="button"
          className={`source-tab ${sourceMode === 'file' ? 'active' : ''}`}
          onClick={() => setSourceMode('file')}
        >
          Arquivo local
        </button>
        <button
          type="button"
          className={`source-tab ${sourceMode === 'url' ? 'active' : ''}`}
          onClick={() => setSourceMode('url')}
        >
          URL (Stremio)
        </button>
      </div>

      {sourceMode === 'file' ? (
        <label className="file-field">
          <span>Vídeo (.mp4)</span>
          <input
            type="file"
            accept="video/mp4,video/*"
            onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
          />
          {videoFile && <small>{videoFile.name}</small>}
        </label>
      ) : (
        <label className="file-field">
          <span>URL do vídeo</span>
          <input
            type="url"
            placeholder="http://127.0.0.1:11470/..."
            value={videoUrl}
            onChange={(e) => updateVideoUrl(e.target.value)}
            autoComplete="off"
            inputMode="url"
          />
          <small>
            Capture a URL no Stremio Android via "Reproduzir em player externo" + um app de
            intercept (ex.: Intent Intercept). Só toca no mesmo aparelho onde o servidor do
            Stremio está rodando.
          </small>
        </label>
      )}

      <label className="file-field">
        <span>Legenda em inglês (.srt / .vtt)</span>
        <input
          type="file"
          accept=".srt,.vtt"
          onChange={(e) => setEnFile(e.target.files?.[0] ?? null)}
        />
        {enFile && <small>{enFile.name}</small>}
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
