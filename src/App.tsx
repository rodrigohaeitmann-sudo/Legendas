import { useEffect, useState } from 'react'
import type { LoadedMedia, Toggles, TrackKey } from './types'
import { usePlayer } from './hooks/usePlayer'
import { loadSession, clearSession } from './lib/sessionStore'
import FileSetup from './components/FileSetup'
import VideoPlayer from './components/VideoPlayer'
import SubtitleToggles from './components/SubtitleToggles'
import SubtitlePanel from './components/SubtitlePanel'
import ControlsFooter from './components/ControlsFooter'

const TOGGLES_KEY = 'legendas.toggles'
const DEFAULT_TOGGLES: Toggles = { ipa: true, en: true, pt: true }

function loadToggles(): Toggles {
  try {
    const raw = localStorage.getItem(TOGGLES_KEY)
    if (raw) return { ...DEFAULT_TOGGLES, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return DEFAULT_TOGGLES
}

export default function App() {
  const [media, setMedia] = useState<LoadedMedia | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [toggles, setToggles] = useState<Toggles>(loadToggles)

  useEffect(() => {
    localStorage.setItem(TOGGLES_KEY, JSON.stringify(toggles))
  }, [toggles])

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

  const cues = media?.cues ?? []
  const { videoRef, isPlaying, activeIndex, togglePlay, next, prev } = usePlayer(
    cues,
    media?.videoId,
  )

  function handleToggle(key: TrackKey) {
    setToggles((t) => ({ ...t, [key]: !t[key] }))
  }

  function handleChangeFiles() {
    if (media) URL.revokeObjectURL(media.videoUrl)
    void clearSession()
    setMedia(null)
  }

  if (restoring) {
    return <div className="splash" />
  }

  if (!media) {
    return <FileSetup onReady={setMedia} />
  }

  const currentCue = activeIndex >= 0 ? cues[activeIndex] : null

  return (
    <div className="player">
      <VideoPlayer videoRef={videoRef} src={media.videoUrl} />
      <SubtitleToggles toggles={toggles} onToggle={handleToggle} onChangeFiles={handleChangeFiles} />
      <SubtitlePanel cue={currentCue} toggles={toggles} />
      <ControlsFooter
        isPlaying={isPlaying}
        onPrev={prev}
        onTogglePlay={togglePlay}
        onNext={next}
      />
    </div>
  )
}
