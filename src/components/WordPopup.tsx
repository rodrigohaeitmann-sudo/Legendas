import { useEffect, useState } from 'react'
import { canSpeak, lookup, speak, type WordInfo } from '../lib/dictionary'
import { addSavedWord } from '../lib/savedWords'

interface Props {
  word: string
  /** Subtitle line the word was tapped in — saved as context. */
  context?: string
  /** Video filename / chapter label for the sheet. */
  chapter?: string
  onClose: () => void
}

export default function WordPopup({ word, context, chapter, onClose }: Props) {
  const [info, setInfo] = useState<WordInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setInfo(null)
    setSaved(false)
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

  async function handleSave() {
    if (saving || saved) return
    setSaving(true)
    try {
      await addSavedWord({
        text: display,
        kind: 'word',
        ipa: info?.ipa ?? '',
        translations: info?.translations ?? [],
        context: context ?? '',
        chapter: chapter ?? '',
        source: 'Listening',
      })
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="word-sheet-backdrop" onClick={onClose}>
      <div className="word-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="word-sheet-grip" />

        <div className="word-sheet-head">
          <div>
            <span className="word-sheet-term">{display}</span>
            {!loading && info?.ipa && <div className="word-sheet-ipa">/{info.ipa}/</div>}
          </div>
          {canSpeak() && (
            <button className="word-sheet-listen" onClick={() => speak(display)} aria-label="Ouvir">
              ♪ Ouvir
            </button>
          )}
        </div>

        {loading && <p className="word-sheet-status">Carregando…</p>}

        {!loading && info && (
          <>
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

        <p className="word-sheet-hint">
          💡 Selecione um trecho na legenda para salvar uma expressão inteira.
        </p>

        <div className="word-sheet-actions">
          <button
            className="word-sheet-save"
            onClick={handleSave}
            disabled={saving || saved}
          >
            {saved ? '✓ Salva' : saving ? 'Salvando…' : '🔖 Salvar palavra'}
          </button>
          <button className="word-sheet-close" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
