import { useEffect, useRef, useState } from 'react'
import type { MergedCue, Toggles } from '../types'
import WordPopup from './WordPopup'
import { addSavedWord } from '../lib/savedWords'

interface Props {
  cue: MergedCue | null
  toggles: Toggles
  /** Video filename / chapter label, forwarded to saved words. */
  chapter?: string
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

export default function SubtitlePanel({ cue, toggles, chapter }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const [selection, setSelection] = useState('')
  const [savedExpr, setSavedExpr] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Watch for a text selection inside the subtitle area to offer saving a
  // whole expression. Cleared when the selection collapses or moves out.
  useEffect(() => {
    function onSelectionChange() {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection('')
        return
      }
      const text = sel.toString().trim()
      const container = containerRef.current
      if (!container || text.length < 2 || !text.includes(' ')) {
        setSelection('')
        return
      }
      // Only react when the selection actually lives inside the subtitles.
      const anchor = sel.anchorNode
      if (anchor && container.contains(anchor)) {
        setSelection(text)
        setSavedExpr(false)
      } else {
        setSelection('')
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  async function saveExpression() {
    if (!selection) return
    await addSavedWord({
      text: selection,
      kind: 'expression',
      context: cue?.en ?? '',
      chapter: chapter ?? '',
      source: 'Listening',
    })
    setSavedExpr(true)
    window.getSelection()?.removeAllRanges()
    window.setTimeout(() => {
      setSelection('')
      setSavedExpr(false)
    }, 1200)
  }

  if (!cue) {
    return (
      <div className="subtitles" ref={containerRef}>
        <p className="subtitle-empty">—</p>
      </div>
    )
  }

  return (
    <div className="subtitles" ref={containerRef}>
      {toggles.ipa && cue.ipa && <p className="line line-ipa">{cue.ipa}</p>}
      {toggles.en && cue.en && <EnglishLine text={cue.en} onWord={setSelected} />}
      {toggles.pt && cue.pt && <p className="line line-pt">{cue.pt}</p>}

      {selection && (
        <div className="sel-save-bar">
          <span className="sel-save-label">
            {savedExpr ? 'Expressão salva ✓' : 'Trecho selecionado'}
          </span>
          {!savedExpr && (
            <button className="sel-save-btn" onClick={saveExpression}>
              🔖 Salvar expressão
            </button>
          )}
        </div>
      )}

      {selected && (
        <WordPopup
          word={selected}
          context={cue.en}
          chapter={chapter}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
