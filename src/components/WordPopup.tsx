import { useEffect, useState } from 'react'
import { canSpeak, lookup, speak, type WordInfo } from '../lib/dictionary'

interface Props {
  word: string
  onClose: () => void
}

export default function WordPopup({ word, onClose }: Props) {
  const [info, setInfo] = useState<WordInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setInfo(null)
    lookup(word)
      .then((res) => {
        if (alive) setInfo(res)
      })
      .catch(() => {
        if (alive) setInfo({ word, matched: null, ipa: null, translations: [] })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [word])

  // Speak the word as soon as the popup opens.
  useEffect(() => {
    speak(word)
  }, [word])

  const display = info?.word || word.trim()

  return (
    <div className="word-sheet-backdrop" onClick={onClose}>
      <div className="word-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="word-sheet-head">
          <span className="word-sheet-term">{display}</span>
          {canSpeak() && (
            <button className="word-sheet-listen" onClick={() => speak(display)} aria-label="Ouvir">
              🔊 Ouvir
            </button>
          )}
        </div>

        {loading && <p className="word-sheet-status">Carregando…</p>}

        {!loading && info && (
          <>
            {info.ipa && <p className="word-sheet-ipa">/{info.ipa}/</p>}
            {info.translations.length > 0 ? (
              <ul className="word-sheet-trans">
                {info.translations.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            ) : (
              <p className="word-sheet-status">Tradução não encontrada no dicionário offline.</p>
            )}
          </>
        )}

        <button className="word-sheet-close" onClick={onClose}>
          Fechar
        </button>
      </div>
    </div>
  )
}
