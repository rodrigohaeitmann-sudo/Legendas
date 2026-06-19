// Pushes locally-saved words to a Google Sheet through a published Apps Script
// web app (the same script + spreadsheet shared with the EPUB reader app).
//
// CORS note: Apps Script /exec endpoints don't answer CORS preflight. Sending
// the body as text/plain keeps the request "simple" (no preflight); the script
// reads e.postData.contents and JSON.parses it regardless of content type, and
// the 302→googleusercontent redirect it returns *does* carry permissive CORS,
// so fetch can follow it and read the JSON result.

import { markSynced, pendingSavedWords, type SavedWord } from './savedWords'

const URL_KEY = 'legendas:sheetScriptUrl'
const LAST_SYNC_KEY = 'legendas:sheetLastSync'

export function getScriptUrl(): string {
  return localStorage.getItem(URL_KEY) ?? ''
}

export function setScriptUrl(url: string): void {
  const trimmed = url.trim()
  if (trimmed) localStorage.setItem(URL_KEY, trimmed)
  else localStorage.removeItem(URL_KEY)
}

export function isValidScriptUrl(url: string): boolean {
  try {
    const u = new URL(url.trim())
    return u.protocol === 'https:' && u.hostname.endsWith('script.google.com')
  } catch {
    return false
  }
}

export function getLastSync(): number | null {
  const raw = localStorage.getItem(LAST_SYNC_KEY)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : null
}

function setLastSync(ts: number): void {
  localStorage.setItem(LAST_SYNC_KEY, String(ts))
}

interface ScriptResponse {
  ok?: boolean
  saved?: number
  error?: string
}

// Shapes a SavedWord into the exact field names the Apps Script expects.
function toPayloadWord(w: SavedWord) {
  return {
    text: w.text,
    kind: w.kind,
    ipa: w.ipa,
    translations: w.translations,
    context: w.context,
    chapter: w.chapter,
    source: w.source,
    savedAt: w.savedAt,
    id: w.id,
  }
}

export interface SyncResult {
  pushed: number
  alreadyEmpty: boolean
}

export async function syncNow(): Promise<SyncResult> {
  const url = getScriptUrl()
  if (!isValidScriptUrl(url)) {
    throw new Error('URL do script inválida. Cole a URL /exec do Apps Script.')
  }

  const pending = await pendingSavedWords()
  if (pending.length === 0) {
    setLastSync(Date.now())
    return { pushed: 0, alreadyEmpty: true }
  }

  const payload = { words: pending.map(toPayloadWord) }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      // text/plain avoids the CORS preflight Apps Script can't answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    })
  } catch (e) {
    throw new Error(
      `Não consegui contactar o script (${e instanceof Error ? e.message : String(e)}). Verifique a URL e a conexão.`,
    )
  }

  let data: ScriptResponse | null = null
  try {
    data = (await res.json()) as ScriptResponse
  } catch {
    // Some environments block reading the redirected response body. If the
    // request itself succeeded (2xx/opaque-redirect), assume the script got
    // the data — better than re-sending duplicates on the next sync.
    if (!res.ok && res.type !== 'opaqueredirect') {
      throw new Error(`Resposta inesperada do script (HTTP ${res.status}).`)
    }
  }

  if (data && data.ok === false) {
    throw new Error(data.error || 'O script retornou um erro.')
  }

  await markSynced(pending.map((w) => w.id))
  setLastSync(Date.now())
  return { pushed: pending.length, alreadyEmpty: false }
}
