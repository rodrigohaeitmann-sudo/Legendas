import { useEffect, useState, type CSSProperties } from 'react'
import type { LoadedMedia, Settings, Toggles, TrackKey } from './types'
import { usePlayer } from './hooks/usePlayer'
import { clearSession, loadSession } from './lib/sessionStore'
import FileSetup from './components/FileSetup'
import VideoStage from './components/VideoStage'
import SubtitleToggles from './components/SubtitleToggles'
import SubtitlePanel from './components/SubtitlePanel'
import ControlsFooter from './components/ControlsFooter'
import SettingsPanel from './components/SettingsPanel'

const TOGGLES_KEY = 'legendas.toggles'
const SETTINGS_KEY = 'legendas.settings'
const DEFAULT_TOGGLES: Toggles = { ipa: true, en: true, pt: true }
const DEFAULT_SETTINGS: Settings = { fontScale: 1, fontFamily: 'system', speed: 1 }

const FONT_STACKS: Record<Settings['fontFamily'], string> = {
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return { ...fallback, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return fallback
}

function offsetKey(videoId?: string) {
  return videoId ? `legendas.offset.${videoId}` : ''
}

function loadOffset(videoId?: string): number {
  if (!videoId) return 0
  const n = Number(localStorage.getItem(offsetKey(videoId)))
  return Number.isFinite(n) ? n : 0
}

export default function App() {
  const [media, setMedia] = useState<LoadedMedia | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [toggles, setToggles] = useState<Toggles>(() => loadJson(TOGGLES_KEY, DEFAULT_TOGGLES))
  const [settings, setSettings] = useState<Settings>(() => loadJson(SETTINGS_KEY, DEFAULT_SETTINGS))
  const [offset, setOffset] = useState(0)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    localStorage.setItem(TOGGLES_KEY, JSON.stringify(toggles))
  }, [toggles])

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  // Reopen the last session automatically (e.g. after the app is backgrounded).
  useEffect(() => {
    loadSession()
      .then((session) => {
        if (session) {
          setMedia({
            videoUrl: URL.createObjectURL(session.videoBlob),
            videoId: session.videoId,
            cues: session.cues,
          })
        }
      })
      .catch(() => undefined)
      .finally(() => setRestoring(false))
  }, [])

  // Subtitle sync offset is per-video; load it when the video changes.
  useEffect(() => {
    setOffset(loadOffset(media?.videoId))
  }, [media?.videoId])

  useEffect(() => {
    const key = offsetKey(media?.videoId)
    if (key) localStorage.setItem(key, String(offset))
  }, [offset, media?.videoId])

  const cues = media?.cues ?? []
  const { videoRef, currentTime, duration, isPlaying, activeIndex, togglePlay, next, prev, seekTo } =
    usePlayer(cues, media?.videoId, offset)

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = settings.speed
  }, [settings.speed, media?.videoId, videoRef])

  function handleToggle(key: TrackKey) {
    setToggles((t) => ({ ...t, [key]: !t[key] }))
  }

  function handleBack() {
    if (media) URL.revokeObjectURL(media.videoUrl)
    setMedia(null)
    // Drop the persisted session so the next launch shows FileSetup instead of
    // auto-reopening the video the user just left.
    void clearSession().catch(() => undefined)
  }

  if (restoring) {
    return <div className="splash" />
  }

  if (!media) {
    return <FileSetup onReady={setMedia} />
  }

  const currentCue = activeIndex >= 0 ? cues[activeIndex] : null
  const stageStyle = {
    '--sub-scale': String(settings.fontScale),
    '--sub-font': FONT_STACKS[settings.fontFamily],
  } as CSSProperties

  return (
    <div className="player" style={stageStyle}>
      <VideoStage
        videoRef={videoRef}
        src={media.videoUrl}
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        onSeek={seekTo}
        onBack={handleBack}
        onOpenSettings={() => setShowSettings(true)}
      />
      <SubtitleToggles toggles={toggles} onToggle={handleToggle} />
      <SubtitlePanel cue={currentCue} toggles={toggles} />
      <ControlsFooter
        isPlaying={isPlaying}
        onPrev={prev}
        onTogglePlay={togglePlay}
        onNext={next}
      />
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          offset={offset}
          onOffsetChange={setOffset}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
