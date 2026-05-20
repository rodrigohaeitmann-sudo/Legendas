import type { MergedCue, Toggles } from '../types'

interface Props {
  cue: MergedCue | null
  toggles: Toggles
}

export default function SubtitlePanel({ cue, toggles }: Props) {
  if (!cue) {
    return (
      <div className="subtitles">
        <p className="subtitle-empty">—</p>
      </div>
    )
  }

  return (
    <div className="subtitles">
      {toggles.ipa && cue.ipa && <p className="line line-ipa">{cue.ipa}</p>}
      {toggles.en && cue.en && <p className="line line-en">{cue.en}</p>}
      {toggles.pt && cue.pt && <p className="line line-pt">{cue.pt}</p>}
    </div>
  )
}
