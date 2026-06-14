import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { LoadedMedia, MergedCue, Settings, Toggles, TrackKey } from './types'
import { usePlayer } from './hooks/usePlayer'
import { clearSession, loadSession, saveSession } from './lib/sessionStore'
import {
  startPipeline,
  type PipelineConfig,
  type PipelineHandle,
  type PipelinePhase,
} from './lib/pipeline'
import { clearCcProgress } from './lib/ccCache'
import FileSetup from './components/FileSetup'
import VideoStage from './components/VideoStage'
import SubtitleToggles from './components/SubtitleToggles'
import SubtitlePanel from './components/SubtitlePanel'
import ControlsFooter from './components/ControlsFooter'
import SettingsPanel from './components/SettingsPanel'
import PipelineBanner from './components/PipelineBanner'

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
  const [phase, setPhase] = useState<PipelinePhase>({ kind: 'idle' })
  const pipelineRef = useRef<PipelineHandle | null>(null)
  // Keep the latest videoBlob aside so we can save the session on Done
  // without forcing FileSetup to thread it through every callback.
  const videoBlobRef = useRef<{ id: string; blob: Blob } | null>(null)

  useEffect(() => {
    localStorage.setItem(TOGGLES_KEY, JSON.stringify(toggles))
  }, [toggles])

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  // Reopen the last fully-built session automatically.
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

  // Persist the completed cue list once the pipeline finishes. Earlier
  // intermediate states stay in the CC cache (for resume) but don't pollute
  // the session store — we only land there with a fully-annotated set.
  useEffect(() => {
    if (phase.kind !== 'done') return
    const blob = videoBlobRef.current
    const current = media
    if (!blob || !current || blob.id !== current.videoId) return
    void saveSession({
      videoId: current.videoId,
      videoBlob: blob.blob,
      cues: current.cues,
    }).catch(() => undefined)
  }, [phase, media])

  function handleToggle(key: TrackKey) {
    setToggles((t) => ({ ...t, [key]: !t[key] }))
  }

  function startBuild(config: PipelineConfig) {
    // Cancel anything already in flight (defensive: shouldn't happen).
    pipelineRef.current?.cancel()

    const videoUrl = URL.createObjectURL(config.videoFile)
    videoBlobRef.current = { id: config.videoId, blob: config.videoFile }
    // Open the player immediately with an empty cue list; cues stream in.
    setMedia({ videoUrl, videoId: config.videoId, cues: [] })
    setPhase({ kind: 'idle' })

    // The previous session is no longer the one being viewed; drop it so a
    // reload mid-build doesn't restore the wrong file.
    void clearSession().catch(() => undefined)

    pipelineRef.current = startPipeline(config, {
      onCuesReplaced: (next) => {
        setMedia((m) => (m && m.videoId === config.videoId ? { ...m, cues: next } : m))
      },
      onCuesAppended: (newCues) => {
        setMedia((m) => {
          if (!m || m.videoId !== config.videoId) return m
          return { ...m, cues: [...m.cues, ...newCues] }
        })
      },
      onCueUpdated: (i, patch) => {
        setMedia((m) => {
          if (!m || m.videoId !== config.videoId) return m
          if (i < 0 || i >= m.cues.length) return m
          const nextCues = m.cues.slice()
          nextCues[i] = { ...nextCues[i], ...patch }
          return { ...m, cues: nextCues }
        })
      },
      onPhase: setPhase,
    })
  }

  function handleBack() {
    pipelineRef.current?.cancel()
    pipelineRef.current = null
    if (media) URL.revokeObjectURL(media.videoUrl)
    setMedia(null)
    setPhase({ kind: 'idle' })
    videoBlobRef.current = null
    // Drop the persisted session so the next launch shows FileSetup.
    void clearSession().catch(() => undefined)
    // CC cache is for resuming the in-flight build; explicit Back means
    // "start over next time" rather than "resume", so drop it too.
    void clearCcProgress().catch(() => undefined)
  }

  if (restoring) {
    return <div className="splash" />
  }

  if (!media) {
    return <FileSetup onStart={startBuild} />
  }

  const currentCue: MergedCue | null = activeIndex >= 0 ? cues[activeIndex] : null
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
      <PipelineBanner phase={phase} />
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
