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
import { probeDuration } from './lib/audioExtract'
import { createVideoStream, type StreamHandle } from './lib/videoStreamMse'
import {
  clearAllChunks,
  loadChunksFor,
  pruneOtherVideos,
  saveChunk,
} from './lib/mediaChunkCache'
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
  // Status of the MSE stream that swaps the chosen audio track in for
  // dual-audio MKVs. media.videoUrl is what actually changes when the
  // stream is ready; this just drives the progress banner.
  const [audioStatus, setAudioStatus] = useState<AudioStatus>({ kind: 'idle' })

  const pipelineRef = useRef<PipelineHandle | null>(null)
  // Latest media kept in a ref so the periodic save interval doesn't go
  // stale between state updates.
  const mediaRef = useRef<LoadedMedia | null>(null)
  const phaseRef = useRef<PipelinePhase>({ kind: 'idle' })
  // Holds the videoBlob + pipeline source so the periodic save can
  // re-emit the full session record without forcing FileSetup to keep
  // passing the File around.
  const buildRef = useRef<{ videoBlob: Blob; audioTrackIndex: number; resume: SessionResume } | null>(null)

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

  // Streams the combined video + chosen audio track via MSE so the browser
  // handles A/V sync internally — fixes the drift the dual-element
  // <video>/<audio> approach had. We swap media.videoUrl from the native
  // file blob to the MediaSource URL once the codec probe lands.
  const audioTokenRef = useRef(0)
  const audioStreamRef = useRef<StreamHandle | null>(null)

  const releaseAudio = useCallback(() => {
    if (audioStreamRef.current) {
      audioStreamRef.current.cancel()
      audioStreamRef.current = null
    }
    setAudioStatus({ kind: 'idle' })
  }, [])

  // Prepares the MSE stream for the chosen audio track and returns the URL
  // the <video> element should use. Returns null for track 0 (no remux).
  // Caller hands the URL to setMedia directly — no mid-stream src swap.
  const prepareAudioTrack = useCallback(
    async (params: {
      videoFile: File
      videoId: string
      audioTrackIndex: number
    }): Promise<string | null> => {
      releaseAudio()
      const { videoFile, videoId, audioTrackIndex } = params
      if (audioTrackIndex === 0) return null
      const token = ++audioTokenRef.current
      console.debug('[audio] preparing track', { videoId, audioTrackIndex })

      try {
        setAudioStatus({ kind: 'extracting', pct: null })
        // Duration probe is cheap (uses <video> metadata, no ffmpeg).
        const duration = await probeDuration(videoFile, videoId)
        if (token !== audioTokenRef.current) return null
        const cached = await loadChunksFor(videoId, audioTrackIndex)
        if (token !== audioTokenRef.current) return null
        console.debug('[audio] cached chunks:', cached.length, 'duration:', duration)
        // Evict cache for other videos/tracks — keeps IDB bounded.
        void pruneOtherVideos(videoId, audioTrackIndex).catch(() => undefined)

        const stream = createVideoStream(
          videoFile,
          videoId,
          audioTrackIndex,
          duration,
          (p) => {
            if (token !== audioTokenRef.current) return
            const pct = duration > 0 ? Math.min(100, (p.bufferedTo / duration) * 100) : null
            if (p.bufferedTo >= duration) {
              setAudioStatus({ kind: 'idle' })
            } else {
              setAudioStatus({ kind: 'extracting', pct })
            }
          },
          {
            cachedChunks: cached.map((c) => ({
              start: c.start,
              dur: c.dur,
              bytes: c.bytes,
            })),
            onChunkExtracted: (start, dur, bytes) => {
              void saveChunk(videoId, audioTrackIndex, start, dur, bytes).catch(() => undefined)
            },
            onError: (e) => {
              if (token !== audioTokenRef.current) return
              console.error('[audio] MSE setup error:', e)
              setAudioStatus({
                kind: 'error',
                message: `Falha no áudio: ${e.message}. Caia em "padrão" no seletor de faixa.`,
              })
            },
          },
        )
        if (token !== audioTokenRef.current) {
          stream.cancel()
          return null
        }
        audioStreamRef.current = stream
        return stream.url
      } catch (e) {
        if (token !== audioTokenRef.current) return null
        console.error('[audio] preparation failed', e)
        setAudioStatus({
          kind: 'error',
          message: `Falha ao preparar áudio: ${e instanceof Error ? e.message : String(e)}`,
        })
        return null
      }
    },
    [releaseAudio],
  )

  const startBuildInternal = useCallback(
    async (config: PipelineConfig, initialMedia?: LoadedMedia) => {
      pipelineRef.current?.cancel()

      // For non-default audio tracks, prepare the MSE stream FIRST and use
      // its URL as media.videoUrl. The old "open with native blob URL then
      // swap to MSE" path left Chrome on Android with a stalled <video>
      // element (black, no decode) on some files. With one URL across the
      // session's lifetime, there's nothing to swap.
      const mseUrl = await prepareAudioTrack({
        videoFile: config.videoFile,
        videoId: config.videoId,
        audioTrackIndex: config.audioTrackIndex,
      })
      const videoUrl =
        initialMedia?.videoUrl ?? mseUrl ?? URL.createObjectURL(config.videoFile)
      const opening: LoadedMedia = initialMedia
        ? { ...initialMedia, videoUrl }
        : { videoUrl, videoId: config.videoId, cues: [] }
      setMedia(opening)
      mediaRef.current = opening
      setPhase({ kind: 'idle' })

      buildRef.current = {
        videoBlob: config.videoFile,
        audioTrackIndex: config.audioTrackIndex,
        resume: {
          sourceLang: config.sourceLang,
          email: config.email,
          source: config.source,
        },
      }

      // Write an immediate baseline so even a fast reload right after
      // Start still finds the file + audio-track + resume info in IDB.
      void saveSession({
        videoId: opening.videoId,
        videoBlob: config.videoFile,
        cues: opening.cues,
        audioTrackIndex: config.audioTrackIndex,
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
    [prepareAudioTrack],
  )

  // Auto-restore on launch. If the previous session was still building
  // (has resume info), open the player with the cues we managed to save
  // and continue the pipeline from where it left off.
  useEffect(() => {
    void (async () => {
      try {
        const session = await loadSession()
        if (!session) return
        const videoFile = session.videoBlob instanceof File
          ? session.videoBlob
          : new File([session.videoBlob], 'video.mkv')
        const legacyResume = session.resume as { audioTrackIndex?: number } | undefined
        const audioTrackIndex =
          session.audioTrackIndex ?? legacyResume?.audioTrackIndex ?? 0
        console.debug('[restore] session loaded;', {
          videoId: session.videoId,
          audioTrackIndex,
          cues: session.cues.length,
          hasResume: !!session.resume,
        })

        if (session.resume) {
          // startBuildInternal is async and will prepare the MSE URL if
          // audioTrackIndex != 0 before opening the player.
          const config: PipelineConfig = {
            videoFile,
            videoId: session.videoId,
            source: session.resume.source,
            sourceLang: session.resume.sourceLang,
            email: session.resume.email,
            audioTrackIndex,
            initialCueCount: session.cues.length,
          }
          // Pass a placeholder initialMedia so cues persist visually during
          // the brief async wait; videoUrl will be overridden inside.
          const placeholder: LoadedMedia = {
            videoUrl: '',
            videoId: session.videoId,
            cues: session.cues,
          }
          await startBuildInternal(config, placeholder)
        } else {
          // Build finished in a previous session. Prepare the MSE URL (if a
          // non-default track was chosen) before opening the player so the
          // <video> element is created with its final src and never has to
          // reload mid-flight.
          const mseUrl =
            audioTrackIndex !== 0
              ? await prepareAudioTrack({
                  videoFile,
                  videoId: session.videoId,
                  audioTrackIndex,
                })
              : null
          const videoUrl = mseUrl ?? URL.createObjectURL(session.videoBlob)
          const initialMedia: LoadedMedia = {
            videoUrl,
            videoId: session.videoId,
            cues: session.cues,
          }
          setMedia(initialMedia)
          mediaRef.current = initialMedia
          // Migration write-back so the next reload skips the legacy path.
          if (session.audioTrackIndex === undefined && audioTrackIndex !== 0) {
            void saveSession({
              videoId: session.videoId,
              videoBlob: session.videoBlob,
              cues: session.cues,
              audioTrackIndex,
            }).catch(() => undefined)
          }
        }
      } catch (e) {
        console.error('[restore] failed', e)
      } finally {
        setRestoring(false)
      }
    })()
  }, [startBuildInternal, prepareAudioTrack])

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

  // Wakes the MSE feeder up after seeks so it pulls fresh chunks at the
  // new playhead position instead of staying paused on BUFFER_AHEAD.
  useEffect(() => {
    audioStreamRef.current?.setPlaybackTime(currentTime)
  }, [currentTime])

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
        audioTrackIndex: build.audioTrackIndex,
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
    // Keep audioTrackIndex in the final record so reopens after the build
    // completes still know which track to re-mux via MSE. Drop `resume`
    // — that's only for "pipeline still in progress".
    void saveSession({
      videoId: current.videoId,
      videoBlob: build.videoBlob,
      cues: current.cues,
      audioTrackIndex: build.audioTrackIndex,
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
    // startBuildInternal is now async (it awaits the MSE probe when a
    // non-default audio track is chosen), but we don't need to surface
    // its completion to FileSetup — errors land in audioStatus + banner.
    void startBuildInternal(config)
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
    // Back is "I'm done with this video"; drop the cached audio chunks too
    // so they don't take IDB space until the user picks the same file again.
    void clearAllChunks().catch(() => undefined)
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
