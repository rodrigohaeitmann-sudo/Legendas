import { useState } from 'react'
import type { LoadedMedia } from '../types'
import { parseSubtitles } from '../lib/parseSubtitles'
import { mergeCues } from '../lib/mergeCues'
import { saveSession } from '../lib/sessionStore'

interface Props {
  onReady: (media: LoadedMedia) => void
}

export default function FileSetup({ onReady }: Props) {
  const [video, setVideo] = useState<File | null>(null)
  const [enFile, setEnFile] = useState<File | null>(null)
  const [ptFile, setPtFile] = useState<File | null>(null)
  const [ipaFile, setIpaFile] = useState<File | null>(null)
  const [error, setError] = useState('')

  const canStart = video !== null && enFile !== null

  async function handleStart() {
    if (!video || !enFile) return
    setError('')
    try {
      const en = parseSubtitles(await enFile.text())
      const pt = ptFile ? parseSubtitles(await ptFile.text()) : []
      const ipa = ipaFile ? parseSubtitles(await ipaFile.text()) : []
      if (en.length === 0) {
        setError('Não encontrei legendas no arquivo de inglês. Verifique o formato (.srt/.vtt).')
        return
      }
      const cues = mergeCues(en, pt, ipa)
      const videoId = `${video.name}:${video.size}`
      // Show the video immediately; persist for auto-reopen in the background so
      // a large file write doesn't block playback.
      onReady({ videoUrl: URL.createObjectURL(video), videoId, cues })
      void saveSession({ videoId, videoBlob: video, cues }).catch(() => {
        // best-effort: storage quota or private mode; app still works this session
      })
    } catch {
      setError('Falha ao ler os arquivos de legenda.')
    }
  }

  return (
    <div className="setup">
      <h1>Treino de Listening</h1>
      <p className="setup-hint">
        Selecione o vídeo e as legendas. Inglês é obrigatório; português e IPA são opcionais.
      </p>

      <label className="file-field">
        <span>Vídeo (.mp4)</span>
        <input
          type="file"
          accept="video/mp4,video/*"
          onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
        />
        {video && <small>{video.name}</small>}
      </label>

      <label className="file-field">
        <span>Legenda em inglês (.srt / .vtt)</span>
        <input
          type="file"
          accept=".srt,.vtt"
          onChange={(e) => setEnFile(e.target.files?.[0] ?? null)}
        />
        {enFile && <small>{enFile.name}</small>}
      </label>

      <label className="file-field">
        <span>Legenda em português (opcional)</span>
        <input
          type="file"
          accept=".srt,.vtt"
          onChange={(e) => setPtFile(e.target.files?.[0] ?? null)}
        />
        {ptFile && <small>{ptFile.name}</small>}
      </label>

      <label className="file-field">
        <span>Legenda fonética IPA (opcional)</span>
        <input
          type="file"
          accept=".srt,.vtt"
          onChange={(e) => setIpaFile(e.target.files?.[0] ?? null)}
        />
        {ipaFile && <small>{ipaFile.name}</small>}
      </label>

      {error && <p className="setup-error">{error}</p>}

      <button className="start-btn" disabled={!canStart} onClick={handleStart}>
        Começar
      </button>
    </div>
  )
}
