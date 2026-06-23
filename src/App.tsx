import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { LoadedMedia, MergedCue, Settings, Toggles, TrackKey } from './types'
import { usePlayer } from './hooks/usePlayer'
import {
  clearSession,
  loadSession,
  saveSession,
  type SessionResume,
  type StoredSession,
} from './lib/sessionStore'
import {
  startPipeline,
  type PipelineConfig,
  type PipelineHandle,
  type PipelinePhase,
} from './lib/pipeline'
import { clearCcProgress } from './lib/ccCache'
import { extractFullAudio, probeAudioTracks } from './lib/audioExtract'
import {
  audioStreamKey,
  bytesToBlobUrl,
  clearAudioStreamCache,
  loadCachedAudio,
  saveCachedAudio,
} from './lib/audioStream'
import FileSetup from './components/FileSetup'
import VideoStage from './components/VideoStage'
import SubtitleToggles from './components/SubtitleToggles'
import SubtitlePanel from './components/SubtitlePanel'
import ControlsFooter from './components/ControlsFooter'
import SettingsPanel from './components/SettingsPanel'
import PipelineBanner, { type AudioStatus } from './components/PipelineBanner'
import SyncPanel from './components/SyncPanel'

const TOGGLES_KEY = 'legendas.toggles'
const SETTINGS_KEY = 'legendas.settings'
const DEFAULT_TOGGLES: Toggles = { ipa: true, en: true, pt: true }
// Default to the editorial serif (Newsreader) so the amber theme reads as
// designed out of the box; users can switch back to sans in Settings.
const DEFAULT_SETTINGS: Settings = { fontScale: 1, fontFamily: 'serif', speed: 1 }
// How often to write the in-progress session to IndexedDB while the
// pipeline keeps streaming cues in.
const PARTIAL_SAVE_INTERVAL_MS = 5000

const FONT_STACKS: Record<Settings['fontFamily'], string> = {
  system: "'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "'Newsreader', Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
}

// Friendly chapter label for saved words: the video filename without the
// ":<size>" suffix baked into videoId.
function videoChapter(videoId?: string): string {
  if (!videoId) return ''
  return videoId.replace(/:\d+$/, '')
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
  const [showSync, setShowSync] = useState(false)
  const [phase, setPhase] = useState<PipelinePhase>({ kind: 'idle' })
  // Files handed to us by the OS when the PWA is launched via "Open with"
  // from a file manager — funnelled into FileSetup as pre-filled inputs.
  const [incomingFiles, setIncomingFiles] = useState<File[]>([])
  // Replacement audio track URL + extraction progress, for dual-audio MKVs
  // where the user chose a non-default track. null = play the video's own
  // audio (browser default).
  const [audioSrc, setAudioSrc] = useState<string | null>(null)
  const [audioStatus, setAudioStatus] = useState<AudioStatus>({ kind: 'idle' })

  const pipelineRef = useRef<PipelineHandle | null>(null)
  // Latest media kept in a ref so the periodic save interval doesn't go
  // stale between state updates.
  const mediaRef = useRef<LoadedMedia | null>(null)
  const phaseRef = useRef<PipelinePhase>({ kind: 'idle' })
  // Holds the videoBlob + pipeline source so the periodic save can
  // re-emit the full session record without forcing FileSetup to keep
  // passing the File around.
  const buildRef = useRef<{ videoBlob: Blob; resume: SessionResume } | null>(null)

  useEffect(() => { mediaRef.current = media }, [media])
  useEffect(() => { phaseRef.current = phase }, [phase])

  useEffect(() => {
    localStorage.setItem(TOGGLES_KEY, JSON.stringify(toggles))
  }, [toggles])

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  // PWA "Open with…" hand-off: when the user launches the installed app from
  // a file manager (Android picks the PWA because of file_handlers in the
  // manifest), Chrome routes the chosen files through LaunchQueue. Pull them
  // out and stash on state — FileSetup wires them into its file inputs.
  useEffect(() => {
    const lq = (window as unknown as {
      launchQueue?: {
        setConsumer: (cb: (params: { files?: FileSystemFileHandle[] }) => void) => void
      }
    }).launchQueue
    if (!lq) return
    lq.setConsumer(async (params) => {
      const handles = params.files
      if (!handles || handles.length === 0) return
      try {
        const files = await Promise.all(handles.map((h) => h.getFile()))
        setIncomingFiles(files)
      } catch (e) {
        console.error('launchQueue file read failed', e)
      }
    })
  }, [])

  // Background job that extracts the chosen audio track and hands its
  // blob URL to <VideoStage> for synced playback. Token guards against an
  // in-flight extraction landing after the user has gone Back / picked a
  // different video.
  const audioTokenRef = useRef(0)
  const audioObjectUrlRef = useRef<string | null>(null)

  const releaseAudio = useCallback(() => {
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current)
      audioObjectUrlRef.current = null
    }
    setAudioSrc(null)
    setAudioStatus({ kind: 'idle' })
  }, [])

  const runAudioTrackExtraction = useCallback((config: PipelineConfig) => {
    releaseAudio()
    // Track 0 is what the browser plays by default — no extraction needed.
    if (config.audioTrackIndex === 0) return
    const token = ++audioTokenRef.current
    const key = audioStreamKey(config.videoId, config.audioTrackIndex)

    void (async () => {
      try {
        const cached = await loadCachedAudio(key)
        if (token !== audioTokenRef.current) return
        if (cached) {
          const url = bytesToBlobUrl(cached)
          audioObjectUrlRef.current = url
          setAudioSrc(url)
          setAudioStatus({ kind: 'idle' })
          return
        }
        setAudioStatus({ kind: 'extracting', pct: null })
        // Probe to get the codec — we need it to decide copy vs transcode.
        const tracks = await probeAudioTracks(config.videoFile, config.videoId)
        if (token !== audioTokenRef.current) return
        const track = tracks[config.audioTrackIndex]
        if (!track) {
          setAudioStatus({ kind: 'error', message: 'Faixa de áudio não encontrada.' })
          return
        }
        const bytes = await extractFullAudio(
          config.videoFile,
          config.videoId,
          config.audioTrackIndex,
          track.codec,
          (p) => {
            if (token !== audioTokenRef.current) return
            setAudioStatus({ kind: 'extracting', pct: p.ratio === null ? null : p.ratio * 100 })
          },
        )
        if (token !== audioTokenRef.current) return
        void saveCachedAudio(key, bytes).catch(() => undefined)
        const url = bytesToBlobUrl(bytes)
        audioObjectUrlRef.current = url
        setAudioSrc(url)
        setAudioStatus({ kind: 'idle' })
      } catch (e) {
        if (token !== audioTokenRef.current) return
        console.error('audio track extraction failed', e)
        setAudioStatus({
          kind: 'error',
          message: `Falha ao preparar áudio: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    })()
  }, [releaseAudio])

  const startBuildInternal = useCallback(
    (config: PipelineConfig, initialMedia?: LoadedMedia) => {
      pipelineRef.current?.cancel()

      const videoUrl = initialMedia?.videoUrl ?? URL.createObjectURL(config.videoFile)
      const opening: LoadedMedia = initialMedia ?? {
        videoUrl,
        videoId: config.videoId,
        cues: [],
      }
      setMedia(opening)
      mediaRef.current = opening
      setPhase({ kind: 'idle' })

      buildRef.current = {
        videoBlob: config.videoFile,
        resume: {
          sourceLang: config.sourceLang,
          email: config.email,
          audioTrackIndex: config.audioTrackIndex,
          source: config.source,
        },
      }

      // Kick off background extraction of the chosen audio track when it
      // isn't track 0 — fixes dual-audio MKVs where the browser plays the
      // wrong language. Track 0 is the browser default; trust it.
      runAudioTrackExtraction(config)

      // Write an immediate baseline so even a fast reload right after
      // Start still finds the file + resume info in IDB.
      void saveSession({
        videoId: opening.videoId,
        videoBlob: config.videoFile,
        cues: opening.cues,
        resume: buildRef.current.resume,
      }).catch(() => undefined)

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
    },
    [runAudioTrackExtraction],
  )

  // Auto-restore on launch. If the previous session was still building
  // (has resume info), open the player with the cues we managed to save
  // and continue the pipeline from where it left off.
  useEffect(() => {
    loadSession()
      .then((session) => {
        if (!session) return
        const videoUrl = URL.createObjectURL(session.videoBlob)
        const initialMedia: LoadedMedia = {
          videoUrl,
          videoId: session.videoId,
          cues: session.cues,
        }
        if (session.resume) {
          // The File object is preserved as a Blob in IDB; cast it back to
          // File so the rest of the pipeline (ffmpeg WORKERFS, name-based
          // paths) keeps working.
          const videoFile = session.videoBlob instanceof File
            ? session.videoBlob
            : new File([session.videoBlob], 'video.mkv')
          const config: PipelineConfig = {
            videoFile,
            videoId: session.videoId,
            source: session.resume.source,
            sourceLang: session.resume.sourceLang,
            email: session.resume.email,
            audioTrackIndex: session.resume.audioTrackIndex ?? 0,
            initialCueCount: session.cues.length,
          }
          startBuildInternal(config, initialMedia)
        } else {
          setMedia(initialMedia)
          mediaRef.current = initialMedia
        }
      })
      .catch(() => undefined)
      .finally(() => setRestoring(false))
  }, [startBuildInternal])

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

  // Save in-progress state regularly while the pipeline is running, and
  // again right before the tab goes hidden — covers backgrounding, swipe
  // to recents, and explicit tab close.
  useEffect(() => {
    const running =
      phase.kind === 'cc' || phase.kind === 'translate'
    if (!running) return

    const writeCurrent = (): Promise<unknown> | undefined => {
      const m = mediaRef.current
      const build = buildRef.current
      if (!m || !build) return undefined
      const record: StoredSession = {
        videoId: m.videoId,
        videoBlob: build.videoBlob,
        cues: m.cues,
        resume: build.resume,
      }
      return saveSession(record).catch(() => undefined)
    }

    const interval = window.setInterval(writeCurrent, PARTIAL_SAVE_INTERVAL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') writeCurrent()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [phase.kind])

  // Once the build is fully done, write the final session without resume
  // info so the next launch reads it as "complete" rather than restarting
  // the pipeline.
  useEffect(() => {
    if (phase.kind !== 'done') return
    const build = buildRef.current
    const current = media
    if (!build || !current) return
    void saveSession({
      videoId: current.videoId,
      videoBlob: build.videoBlob,
      cues: current.cues,
    }).catch(() => undefined)
    buildRef.current = null
  }, [phase, media])

  function handleToggle(key: TrackKey) {
    setToggles((t) => ({ ...t, [key]: !t[key] }))
  }

  function startBuild(config: PipelineConfig) {
    // Picking a new file from FileSetup invalidates any earlier session;
    // wipe both stores so we don't merge with stale data. The audio
    // stream cache is keyed by videoId+track, so it survives a re-open of
    // the same file; only Back wipes it explicitly.
    void clearSession().catch(() => undefined)
    void clearCcProgress().catch(() => undefined)
    startBuildInternal(config)
  }

  function handleBack() {
    pipelineRef.current?.cancel()
    pipelineRef.current = null
    audioTokenRef.current++ // invalidate any in-flight extraction job
    releaseAudio()
    if (media) URL.revokeObjectURL(media.videoUrl)
    setMedia(null)
    setPhase({ kind: 'idle' })
    buildRef.current = null
    void clearSession().catch(() => undefined)
    void clearCcProgress().catch(() => undefined)
    void clearAudioStreamCache().catch(() => undefined)
  }

  if (restoring) {
    return <div className="splash" />
  }

  if (!media) {
    return (
      <>
        <FileSetup
          onStart={startBuild}
          onOpenSync={() => setShowSync(true)}
          initialFiles={incomingFiles}
          onInitialFilesConsumed={() => setIncomingFiles([])}
        />
        {showSync && <SyncPanel onClose={() => setShowSync(false)} />}
      </>
    )
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
        audioSrc={audioSrc}
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        onSeek={seekTo}
        onBack={handleBack}
        onOpenSettings={() => setShowSettings(true)}
      />
      <PipelineBanner phase={phase} audio={audioStatus} />
      <SubtitleToggles toggles={toggles} onToggle={handleToggle} />
      <SubtitlePanel cue={currentCue} toggles={toggles} chapter={videoChapter(media.videoId)} />
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
          onOpenSync={() => {
            setShowSettings(false)
            setShowSync(true)
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showSync && <SyncPanel onClose={() => setShowSync(false)} />}
    </div>
  )
}
