import { useEffect, useRef, useState } from 'react'
import { WHISPER_MODELS, type WhisperModel } from '../lib/transcribe'
import {
  detectLang,
  langLabel,
  SUPPORTED_LANGS,
  type SourceLang,
} from '../lib/detectLang'
import type { PipelineConfig } from '../lib/pipeline'
import { probeAudioTracks, type AudioTrack } from '../lib/audioExtract'

interface Props {
  onStart: (config: PipelineConfig) => void
  onOpenSync: () => void
  /** Files handed to us via PWA file_handlers / LaunchQueue. */
  initialFiles?: File[]
  /** Called once the initial files have been consumed (so App can clear). */
  onInitialFilesConsumed?: () => void
}

type SubtitleSource = 'srt' | 'audio'

const EMAIL_KEY = 'legendas:mymemoryEmail'
const LANG_KEY = 'legendas:lastSourceLang'
const WHISPER_KEY = 'legendas:whisperModel'
const VIDEO_EXTS = /\.(mp4|m4v|mkv|webm|mov|avi|flv|ts)$/i
const SUB_EXTS = /\.(srt|vtt)$/i

// Map of MKV/MP4 language tags (ISO 639-1 / 639-2) to a friendly Portuguese
// label. Tracks the same set as SUPPORTED_LANGS but with both 2- and 3-letter
// codes since containers use either.
const LANG_NAME: Record<string, string> = {
  en: 'Inglês', eng: 'Inglês',
  fr: 'Francês', fre: 'Francês', fra: 'Francês',
  pt: 'Português', por: 'Português',
  es: 'Espanhol', spa: 'Espanhol',
  de: 'Alemão', ger: 'Alemão', deu: 'Alemão',
  it: 'Italiano', ita: 'Italiano',
  ja: 'Japonês', jpn: 'Japonês',
  ko: 'Coreano', kor: 'Coreano',
  zh: 'Chinês', chi: 'Chinês', zho: 'Chinês', cmn: 'Chinês',
  ru: 'Russo', rus: 'Russo',
  pl: 'Polonês', pol: 'Polonês',
  nl: 'Holandês', dut: 'Holandês', nld: 'Holandês',
}

// True when an MKV language tag (e.g. "fre", "fr-FR") matches our 2-letter
// source language code — used to auto-pick the right track for CC.
function langTagMatches(tag: string | undefined, source: SourceLang): boolean {
  if (!tag) return false
  const norm = tag.toLowerCase().split(/[-_]/)[0]
  return LANG_NAME[norm] === LANG_NAME[source]
}

function trackLabel(t: AudioTrack): string {
  const tag = t.language?.toLowerCase()
  const lang = tag ? LANG_NAME[tag.split(/[-_]/)[0]] ?? tag.toUpperCase() : `Faixa ${t.index + 1}`
  const ch =
    t.channels === 1 ? 'mono'
    : t.channels === 2 ? 'stereo'
    : t.channels === 6 ? '5.1'
    : t.channels === 8 ? '7.1'
    : t.channels ? `${t.channels}ch`
    : ''
  const parts = [`${t.index + 1}. ${lang}`]
  if (t.codec) parts.push(t.codec.toUpperCase())
  if (ch) parts.push(ch)
  if (t.isDefault) parts.push('padrão')
  return parts.join(' · ')
}

function loadLastLang(): SourceLang {
  const stored = localStorage.getItem(LANG_KEY) as SourceLang | null
  return SUPPORTED_LANGS.some((l) => l.code === stored) ? (stored as SourceLang) : 'en'
}

function loadWhisperModel(): WhisperModel {
  const stored = localStorage.getItem(WHISPER_KEY) as WhisperModel | null
  return WHISPER_MODELS.some((m) => m.id === stored) ? (stored as WhisperModel) : 'base'
}

export default function FileSetup({ onStart, onOpenSync, initialFiles, onInitialFilesConsumed }: Props) {
  const [subSource, setSubSource] = useState<SubtitleSource>('srt')
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [srtFile, setSrtFile] = useState<File | null>(null)
  const [srtText, setSrtText] = useState('')
  const [sourceLang, setSourceLang] = useState<SourceLang>(loadLastLang)
  const [detectedLang, setDetectedLang] = useState<SourceLang | null>(null)
  const [whisperModel, setWhisperModel] = useState<WhisperModel>(loadWhisperModel)
  const [audioTracks, setAudioTracks] = useState<AudioTrack[] | null>(null)
  const [audioTrackIndex, setAudioTrackIndex] = useState(0)
  const [probingTracks, setProbingTracks] = useState(false)
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_KEY) ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState('')
  // True once the user manually overrides the auto-picked track — keeps a
  // sourceLang change from then forcing it back.
  const trackTouchedRef = useRef(false)

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

  // One picker, both files: user can multi-select the video + its subtitle in
  // the Android file chooser in a single tap. We route each picked file to
  // the right slot by extension. Single-file pickers still work as before.
  function handleFilesPicked(list: FileList | null) {
    if (!list || list.length === 0) return
    let assignedSrt: File | null = null
    let assignedVideo: File | null = null
    for (const f of Array.from(list)) {
      if (SUB_EXTS.test(f.name)) assignedSrt = f
      else if (f.type.startsWith('video/') || VIDEO_EXTS.test(f.name)) assignedVideo = f
    }
    if (assignedVideo) {
      setVideoFile(assignedVideo)
      // Picking a new video invalidates any probed track info.
      setAudioTracks(null)
      setAudioTrackIndex(0)
      trackTouchedRef.current = false
    }
    if (assignedSrt) {
      void pickSrt(assignedSrt)
      // If user dropped an SRT alongside the video, switch to SRT mode so
      // they can hit Start without an extra tap.
      setSubSource('srt')
    }
  }

  // Consume files handed in by PWA file_handlers / LaunchQueue (App passes
  // them as a fresh array on each launch; we treat them like a normal pick).
  useEffect(() => {
    if (!initialFiles || initialFiles.length === 0) return
    const list = new DataTransfer()
    for (const f of initialFiles) list.items.add(f)
    handleFilesPicked(list.files)
    onInitialFilesConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiles])

  // Probe the chosen video's audio tracks whenever we'd actually use them
  // (CC mode). Skipped in SRT mode — playback uses the browser's default
  // audio track regardless, and probing would force ffmpeg to load early.
  useEffect(() => {
    if (subSource !== 'audio' || !videoFile) {
      setAudioTracks(null)
      return
    }
    let cancelled = false
    setProbingTracks(true)
    const videoId = `${videoFile.name}:${videoFile.size}`
    probeAudioTracks(videoFile, videoId)
      .then((tracks) => {
        if (cancelled) return
        setAudioTracks(tracks)
        if (tracks.length === 0) return
        if (trackTouchedRef.current) return
        // Pick the track whose language tag matches the chosen source
        // language; otherwise prefer the container's "default", otherwise
        // fall back to the first one.
        const byLang = tracks.findIndex((t) => langTagMatches(t.language, sourceLang))
        if (byLang >= 0) {
          setAudioTrackIndex(byLang)
        } else {
          const def = tracks.findIndex((t) => t.isDefault)
          setAudioTrackIndex(def >= 0 ? def : 0)
        }
      })
      .catch((e) => {
        console.error('audio track probe failed', e)
        if (!cancelled) setAudioTracks([])
      })
      .finally(() => {
        if (!cancelled) setProbingTracks(false)
      })
    return () => {
      cancelled = true
    }
  }, [videoFile, subSource, sourceLang])

  function handleStart() {
    if (!videoFile) return
    setError('')
    const videoId = `${videoFile.name}:${videoFile.size}`
    const source: PipelineConfig['source'] =
      subSource === 'srt'
        ? { kind: 'srt', text: srtText }
        : { kind: 'cc', whisperModel, audioTrackIndex }
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
      <div className="setup-topbar">
        <h1>Treino de Listening</h1>
        <button
          className="setup-sync-btn"
          aria-label="Palavras salvas e sincronização"
          onClick={onOpenSync}
        >
          🔖
        </button>
      </div>
      <p className="setup-hint">
        Escolha o vídeo e (opcionalmente) a legenda no mesmo seletor — selecione os dois
        de uma vez. A reprodução começa imediatamente; tradução e fonética chegam em
        segundo plano.
      </p>

      <label className="file-field">
        <span>Vídeo (+ legenda opcional)</span>
        <input
          type="file"
          multiple
          accept="video/*,.mkv,.mp4,.webm,.m4v,.mov,.avi,.srt,.vtt"
          onChange={(e) => handleFilesPicked(e.target.files)}
        />
        {videoFile && <small>🎬 {videoFile.name}</small>}
        {srtFile && <small>🗒️ {srtFile.name}</small>}
        {!videoFile && !srtFile && (
          <small className="hint">
            Dica: no seletor do Android, segure pressionado e marque o vídeo + o .srt antes
            de tocar em "Abrir".
          </small>
        )}
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
        <>
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
              A transcrição roda no seu aparelho (nada é enviado). O modelo é baixado uma
              única vez. As legendas aparecem aos poucos no player conforme cada trecho
              fica pronto.
            </small>
          </label>

          {videoFile && (
            <label className="file-field">
              <span>Faixa de áudio</span>
              {probingTracks && <small>Lendo faixas do vídeo…</small>}
              {!probingTracks && audioTracks !== null && audioTracks.length === 0 && (
                <small>Não consegui ler as faixas — usarei a primeira disponível.</small>
              )}
              {!probingTracks && audioTracks && audioTracks.length > 0 && (
                <>
                  <select
                    value={audioTrackIndex}
                    onChange={(e) => {
                      trackTouchedRef.current = true
                      setAudioTrackIndex(Number(e.target.value))
                    }}
                  >
                    {audioTracks.map((t) => (
                      <option key={t.index} value={t.index}>
                        {trackLabel(t)}
                      </option>
                    ))}
                  </select>
                  {audioTracks.length > 1 && (
                    <small>
                      Vídeos dual áudio (ex.: francês + dublagem PT) tem várias faixas;
                      escolha a do idioma que quer treinar.
                    </small>
                  )}
                </>
              )}
            </label>
          )}
        </>
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
            Sobe o limite diário gratuito do MyMemory para 50 mil palavras. Se a cota
            acabar mesmo assim, a tradução continua automaticamente pelo Google Translate.
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
