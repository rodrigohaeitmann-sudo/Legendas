import { useCallback, useEffect, useState } from 'react'
import {
  recentSavedWords,
  savedCounts,
  type SavedWord,
} from '../lib/savedWords'
import {
  getLastSync,
  getScriptUrl,
  isValidScriptUrl,
  setScriptUrl,
  syncNow,
} from '../lib/sheetSync'

interface Props {
  onClose: () => void
}

function formatRelative(ts: number | null): string {
  if (!ts) return 'Nunca sincronizado'
  const d = new Date(ts)
  const diffMin = Math.round((Date.now() - ts) / 60000)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  let rel: string
  if (diffMin < 1) rel = 'agora mesmo'
  else if (diffMin < 60) rel = `há ${diffMin} min`
  else if (diffMin < 1440) rel = `há ${Math.round(diffMin / 60)} h`
  else rel = `há ${Math.round(diffMin / 1440)} d`
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return `${sameDay ? 'Hoje' : d.toLocaleDateString('pt-BR')}, ${hh}:${mm} · ${rel}`
}

export default function SyncPanel({ onClose }: Props) {
  const [url, setUrl] = useState(() => getScriptUrl())
  const [urlSaved, setUrlSaved] = useState(false)
  const [counts, setCounts] = useState({ total: 0, pending: 0 })
  const [recent, setRecent] = useState<SavedWord[]>([])
  const [lastSync, setLastSync] = useState<number | null>(() => getLastSync())
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    const [c, r] = await Promise.all([savedCounts(), recentSavedWords(12)])
    setCounts(c)
    setRecent(r)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const connected = isValidScriptUrl(url) && Boolean(getScriptUrl())

  function saveUrl() {
    setScriptUrl(url)
    setUrlSaved(true)
    setMessage(null)
    window.setTimeout(() => setUrlSaved(false), 1800)
  }

  async function pasteUrl() {
    try {
      const text = await navigator.clipboard.readText()
      if (text) setUrl(text.trim())
    } catch {
      setMessage({ tone: 'error', text: 'Não consegui acessar a área de transferência.' })
    }
  }

  async function handleSync() {
    if (!isValidScriptUrl(url)) {
      setMessage({ tone: 'error', text: 'Salve uma URL /exec do Apps Script primeiro.' })
      return
    }
    // Persist the URL implicitly so the user doesn't have to tap Salvar first.
    setScriptUrl(url)
    setSyncing(true)
    setMessage(null)
    try {
      const result = await syncNow()
      setLastSync(getLastSync())
      await refresh()
      setMessage({
        tone: 'ok',
        text: result.alreadyEmpty
          ? 'Tudo já estava sincronizado.'
          : `${result.pushed} ${result.pushed === 1 ? 'palavra enviada' : 'palavras enviadas'} para a planilha.`,
      })
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="sync-screen">
      <div className="sync-head">
        <button className="sync-back" aria-label="Voltar" onClick={onClose}>
          ←
        </button>
        <h1 className="sync-title">Sincronização</h1>
      </div>

      <div className="sync-card">
        <div className="sync-status">
          <span className={`sync-dot ${connected ? 'on' : 'off'}`} />
          <span className={`sync-status-text ${connected ? 'on' : 'off'}`}>
            {connected ? 'Conectado' : 'Sem URL configurada'}
          </span>
        </div>
        <div className="sync-meta-label">Última sincronização</div>
        <div className="sync-meta-value">{formatRelative(lastSync)}</div>
        <div className="sync-stats">
          <div className="sync-stat">
            <div className="sync-stat-num">{counts.total}</div>
            <div className="sync-stat-label">palavras salvas</div>
          </div>
          <div className="sync-stat">
            <div className="sync-stat-num accent">{counts.pending}</div>
            <div className="sync-stat-label">pendentes de envio</div>
          </div>
        </div>
      </div>

      <button className="sync-btn" disabled={syncing} onClick={handleSync}>
        {syncing ? 'Sincronizando…' : '⟳ Sincronizar agora'}
      </button>

      {message && <div className={`sync-msg ${message.tone}`}>{message.text}</div>}

      <div className="sync-url-block">
        <div className="sync-url-label">URL do script do Google Planilhas</div>
        <div className="sync-url-box">
          <span className="sync-url-icon">🔗</span>
          <input
            className="sync-url-input"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://script.google.com/macros/…/exec"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="sync-url-actions">
          <button className="sync-url-btn ghost" onClick={pasteUrl}>
            Colar
          </button>
          <button className="sync-url-btn accent" onClick={saveUrl}>
            {urlSaved ? 'Salva ✓' : 'Salvar URL'}
          </button>
        </div>
      </div>

      <div className="sync-recent-block">
        <div className="sync-recent-label">Salvas recentemente</div>
        {recent.length === 0 ? (
          <div className="sync-recent-empty">
            Nenhuma palavra salva ainda. Toque numa palavra na legenda e use “Salvar”.
          </div>
        ) : (
          <div className="sync-recent">
            {recent.map((w) => (
              <span
                key={w.id}
                className={`sync-chip ${w.synced ? '' : 'pending'}`}
                title={w.synced ? 'Sincronizada' : 'Pendente'}
              >
                {w.text}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
