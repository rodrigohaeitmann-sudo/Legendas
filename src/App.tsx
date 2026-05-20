import { useEffect, useState } from 'react'
import type { LoadedMedia, Toggles, TrackKey } from './types'
import { usePlayer } from './hooks/usePlayer'
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
  const [toggles, setToggles] = useState<Toggles>(loadToggles)

  useEffect(() => {
    localStorage.setItem(TOGGLES_KEY, JSON.stringify(toggles))
  }, [toggles])

  const cues = media?.cues ?? []
  const { videoRef, isPlaying, activeIndex, togglePlay, next, prev } = usePlayer(cues)

  function handleToggle(key: TrackKey) {
    setToggles((t) => ({ ...t, [key]: !t[key] }))
  }

  if (!media) {
    return <FileSetup onReady={setMedia} />
  }

  const currentCue = activeIndex >= 0 ? cues[activeIndex] : null

  return (
    <div className="player">
      <VideoPlayer videoRef={videoRef} src={media.videoUrl} />
      <SubtitleToggles toggles={toggles} onToggle={handleToggle} />
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
