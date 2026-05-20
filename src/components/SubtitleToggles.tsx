import type { Toggles, TrackKey } from '../types'

interface Props {
  toggles: Toggles
  onToggle: (key: TrackKey) => void
}

const LABELS: Record<TrackKey, string> = {
  ipa: 'IPA',
  en: 'EN',
  pt: 'PT',
}

export default function SubtitleToggles({ toggles, onToggle }: Props) {
  return (
    <div className="toggles">
      {(Object.keys(LABELS) as TrackKey[]).map((key) => (
        <button
          key={key}
          className={`chip ${toggles[key] ? 'chip-on' : ''}`}
          aria-pressed={toggles[key]}
          onClick={() => onToggle(key)}
        >
          {LABELS[key]}
        </button>
      ))}
    </div>
  )
}
