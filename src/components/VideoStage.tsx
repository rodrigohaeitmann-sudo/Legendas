import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'

interface Props {
  videoRef: RefObject<HTMLVideoElement>
  src: string
  /** When set, this URL is played from a hidden <audio> in sync with the
      muted video — used to override the browser's default audio track for
      dual-audio MKVs where audioTracks API isn't available. */
  audioSrc?: string | null
  currentTime: number
  duration: number
  isPlaying: boolean
  onSeek: (time: number) => void
  onBack: () => void
  onOpenSettings: () => void
}

// Sync drift before we hard-correct the <audio> element to the video's
// timeline. Smaller = more jumps; bigger = audio can drift slightly out
// of lipsync. 300 ms is the threshold most A/V sync references quote.
const MAX_DRIFT_MS = 300

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VideoStage({
  videoRef,
  src,
  audioSrc,
  currentTime,
  duration,
  isPlaying,
  onSeek,
  onBack,
  onOpenSettings,
}: Props) {
  const [visible, setVisible] = useState(true)
  const hideTimer = useRef<number | undefined>(undefined)
  const audioRef = useRef<HTMLAudioElement>(null)

  // When a replacement audio track is supplied, mute the video element and
  // mirror every play / pause / seek / rate change onto the <audio> element.
  // This is the only way to swap audio tracks on the web — the audioTracks
  // API is in the spec but no shipping browser exposes it.
  useEffect(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !audio || !audioSrc) {
      if (video) video.muted = false
      return
    }
    video.muted = true
    // Match the starting state of the video.
    audio.currentTime = video.currentTime
    audio.playbackRate = video.playbackRate
    if (!video.paused) void audio.play().catch(() => undefined)

    const onPlay = () => void audio.play().catch(() => undefined)
    const onPause = () => audio.pause()
    const onSeeked = () => { audio.currentTime = video.currentTime }
    const onRate = () => { audio.playbackRate = video.playbackRate }
    const onTime = () => {
      const drift = Math.abs(audio.currentTime - video.currentTime) * 1000
      if (drift > MAX_DRIFT_MS) audio.currentTime = video.currentTime
    }

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('ratechange', onRate)
    video.addEventListener('timeupdate', onTime)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('ratechange', onRate)
      video.removeEventListener('timeupdate', onTime)
      audio.pause()
      video.muted = false
    }
  }, [audioSrc, videoRef])

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
      {audioSrc && (
        <audio
          ref={audioRef}
          src={audioSrc}
          preload="auto"
          style={{ display: 'none' }}
        />
      )}
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
