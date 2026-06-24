import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'

interface Props {
  videoRef: RefObject<HTMLVideoElement>
  src: string
  currentTime: number
  duration: number
  isPlaying: boolean
  onSeek: (time: number) => void
  onBack: () => void
  onOpenSettings: () => void
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VideoStage({
  videoRef,
  src,
  currentTime,
  duration,
  isPlaying,
  onSeek,
  onBack,
  onOpenSettings,
}: Props) {
  const [visible, setVisible] = useState(true)
  const hideTimer = useRef<number | undefined>(undefined)

  function scheduleHide() {
    window.clearTimeout(hideTimer.current)
    if (isPlaying) hideTimer.current = window.setTimeout(() => setVisible(false), 3000)
  }
  function reveal() {
    setVisible(true)
    scheduleHide()
  }
  function toggle() {
    if (visible) {
      window.clearTimeout(hideTimer.current)
      setVisible(false)
    } else {
      reveal()
    }
  }

  // Keep controls up while paused; auto-hide a few seconds after playback resumes.
  useEffect(() => {
    if (!isPlaying) {
      window.clearTimeout(hideTimer.current)
      setVisible(true)
    } else if (visible) {
      scheduleHide()
    }
    return () => window.clearTimeout(hideTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, visible])

  const stop = (e: MouseEvent) => e.stopPropagation()

  return (
    <div className="video-wrap" onClick={toggle}>
      <video ref={videoRef} src={src} playsInline preload="metadata" />
      <div className={`overlay ${visible ? 'overlay-on' : ''}`}>
        <div className="overlay-top">
          <button
            className="ov-btn"
            aria-label="Voltar"
            onClick={(e) => {
              stop(e)
              onBack()
            }}
          >
            ←
          </button>
          <button
            className="ov-btn"
            aria-label="Configurações"
            onClick={(e) => {
              stop(e)
              onOpenSettings()
            }}
          >
            ⚙
          </button>
        </div>
        <div className="overlay-bottom" onClick={stop}>
          <span className="time">{formatTime(currentTime)}</span>
          <input
            className="seek"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={(e) => {
              onSeek(Number(e.target.value))
              reveal()
            }}
          />
          <span className="time">{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  )
}
