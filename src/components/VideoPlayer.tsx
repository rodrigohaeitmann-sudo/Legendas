import type { RefObject } from 'react'

interface Props {
  videoRef: RefObject<HTMLVideoElement>
  src: string
}

export default function VideoPlayer({ videoRef, src }: Props) {
  return (
    <div className="video-wrap">
      <video ref={videoRef} src={src} playsInline preload="metadata" />
    </div>
  )
}
