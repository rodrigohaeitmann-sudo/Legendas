import { useCallback, useEffect, useRef, useState } from 'react'
import type { MergedCue } from '../types'

// If the current cue has been playing for longer than this, prev() restarts
// it instead of jumping to the previous cue ("repeat the line" behaviour).
const REPEAT_THRESHOLD = 1

export function usePlayer(cues: MergedCue[], videoId?: string) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTime = () => setCurrentTime(video.currentTime)
    const onDuration = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('loadedmetadata', onDuration)
    video.addEventListener('durationchange', onDuration)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    setIsPlaying(!video.paused)
    onDuration()
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('loadedmetadata', onDuration)
      video.removeEventListener('durationchange', onDuration)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [videoId])

  // Persist playback position per video so it resumes where it stopped.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoId) return
    const key = `legendas.progress.${videoId}`

    const restore = () => {
      const saved = Number(localStorage.getItem(key))
      if (saved > 1 && (!video.duration || saved < video.duration - 1)) {
        video.currentTime = saved
      }
    }
    if (video.readyState >= 1) restore()
    else video.addEventListener('loadedmetadata', restore, { once: true })

    let lastSaved = 0
    const save = () => {
      if (video.currentTime > 0) localStorage.setItem(key, String(video.currentTime))
    }
    const onTime = () => {
      const now = Date.now()
      if (now - lastSaved > 4000) {
        lastSaved = now
        save()
      }
    }
    const onHidden = () => {
      if (document.hidden) save()
    }
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('pause', save)
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      video.removeEventListener('loadedmetadata', restore)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('pause', save)
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [videoId])

  // Index of the active cue, or the next upcoming one when in a gap. -1 before the first.
  const activeIndex = (() => {
    if (cues.length === 0) return -1
    const within = cues.findIndex((c) => currentTime >= c.start && currentTime < c.end)
    if (within !== -1) return within
    const upcoming = cues.findIndex((c) => c.start > currentTime)
    if (upcoming !== -1) return Math.max(0, upcoming - 1)
    return cues.length - 1
  })()

  const seekTo = useCallback((time: number) => {
    const video = videoRef.current
    if (video) video.currentTime = Math.max(0, time)
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }, [])

  const next = useCallback(() => {
    if (activeIndex === -1 || cues.length === 0) {
      if (cues[0]) seekTo(cues[0].start)
      return
    }
    const target = cues[activeIndex + 1]
    if (target) seekTo(target.start)
  }, [activeIndex, cues, seekTo])

  const prev = useCallback(() => {
    if (activeIndex === -1 || cues.length === 0) return
    const current = cues[activeIndex]
    if (currentTime - current.start > REPEAT_THRESHOLD) {
      seekTo(current.start)
      return
    }
    const target = cues[activeIndex - 1]
    seekTo(target ? target.start : current.start)
  }, [activeIndex, cues, currentTime, seekTo])

  return { videoRef, currentTime, duration, isPlaying, activeIndex, togglePlay, next, prev, seekTo }
}
