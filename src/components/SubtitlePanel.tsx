import { useState } from 'react'
import type { MergedCue, Toggles } from '../types'
import WordPopup from './WordPopup'

interface Props {
  cue: MergedCue | null
  toggles: Toggles
}

const HAS_LETTER = /[a-zA-Z]/

function EnglishLine({ text, onWord }: { text: string; onWord: (w: string) => void }) {
  // Split keeping whitespace so the original spacing is preserved.
  const tokens = text.split(/(\s+)/)
  return (
    <p className="line line-en">
      {tokens.map((tok, i) =>
        HAS_LETTER.test(tok) ? (
          <button key={i} type="button" className="word" onClick={() => onWord(tok)}>
            {tok}
          </button>
        ) : (
          <span key={i}>{tok}</span>
        ),
      )}
    </p>
  )
}

export default function SubtitlePanel({ cue, toggles }: Props) {
  const [selected, setSelected] = useState<string | null>(null)

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
      {toggles.en && cue.en && <EnglishLine text={cue.en} onWord={setSelected} />}
      {toggles.pt && cue.pt && <p className="line line-pt">{cue.pt}</p>}
      {selected && <WordPopup word={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
