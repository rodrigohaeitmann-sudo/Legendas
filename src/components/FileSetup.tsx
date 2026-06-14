import { useState } from 'react'
import { WHISPER_MODELS, type WhisperModel } from '../lib/transcribe'
import {
  detectLang,
  langLabel,
  SUPPORTED_LANGS,
  type SourceLang,
} from '../lib/detectLang'
import type { PipelineConfig } from '../lib/pipeline'

interface Props {
  onStart: (config: PipelineConfig) => void
}

type SubtitleSource = 'srt' | 'audio'

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

export default function FileSetup({ onStart }: Props) {
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

  const canStart = videoFile !== null && (subSource === 'srt' ? srtFile !== null : true)

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

  function handleStart() {
    if (!videoFile) return
    setError('')
    const videoId = `${videoFile.name}:${videoFile.size}`
    const source =
      subSource === 'srt'
        ? ({ kind: 'srt' as const, text: srtText })
        : ({ kind: 'cc' as const, whisperModel })
    if (subSource === 'srt' && !srtText) {
      setError('A legenda parece vazia. Tente outro arquivo.')
      return
    }
    onStart({
      videoFile,
      videoId,
      source,
      sourceLang,
      email: email.trim() || undefined,
    })
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
        Escolha o vídeo e a legenda. A reprodução começa imediatamente; tradução e
        transcrição fonética chegam em segundo plano enquanto você assiste.
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
            vez. As legendas aparecem aos poucos no player conforme cada trecho fica pronto.
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
    </div>
  )
}
