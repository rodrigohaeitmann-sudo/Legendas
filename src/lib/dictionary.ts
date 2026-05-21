import dictUrl from '../data/en-pt.json?url'

interface Entry {
  t: string[]
  i?: string
}

type Dict = Record<string, Entry>

export interface WordInfo {
  word: string
  matched: string | null
  ipa: string | null
  translations: string[]
}

let cache: Promise<Dict> | null = null

function load(): Promise<Dict> {
  if (!cache) {
    cache = fetch(dictUrl).then((r) => {
      if (!r.ok) throw new Error(`dict ${r.status}`)
      return r.json() as Promise<Dict>
    })
  }
  return cache
}

// Strip surrounding punctuation/quotes, keep internal apostrophes and hyphens.
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[^a-z']+/, '')
    .replace(/[^a-z']+$/, '')
    .replace(/[’‘]/g, "'")
}

// Common inflections -> likely lemma. Order matters; first hit in the dict wins.
function stems(w: string): string[] {
  const out: string[] = []
  const push = (s: string) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s)
  }
  const doubled = (b: string) => b.length >= 2 && b[b.length - 1] === b[b.length - 2]

  if (w.endsWith('ing')) {
    const b = w.slice(0, -3)
    push(b)
    push(b + 'e')
    if (doubled(b)) push(b.slice(0, -1))
  }
  if (w.endsWith('ed')) {
    const b = w.slice(0, -2)
    push(b)
    push(b + 'e')
    push(w.slice(0, -1))
    if (doubled(b)) push(b.slice(0, -1))
  }
  if (w.endsWith('ies')) push(w.slice(0, -3) + 'y')
  if (w.endsWith('es')) push(w.slice(0, -2))
  if (w.endsWith('s')) push(w.slice(0, -1))
  if (w.endsWith("'s") || w.endsWith("'ll") || w.endsWith("'re") || w.endsWith("'ve")) {
    push(w.slice(0, w.indexOf("'")))
  }
  return out
}

function get(dict: Dict, key: string): Entry | null {
  if (!Object.prototype.hasOwnProperty.call(dict, key)) return null
  const e = dict[key]
  return e && Array.isArray(e.t) ? e : null
}

export async function lookup(raw: string): Promise<WordInfo> {
  const word = normalize(raw)
  const info: WordInfo = { word, matched: null, ipa: null, translations: [] }
  if (!word) return info

  const dict = await load()
  const keys = [word, ...stems(word)]
  for (const key of keys) {
    const e = get(dict, key)
    if (e) {
      info.matched = key
      info.ipa = e.i ?? null
      info.translations = e.t
      break
    }
  }
  return info
}

let voicesReady = false
function ensureVoices() {
  if (voicesReady || typeof speechSynthesis === 'undefined') return
  speechSynthesis.getVoices()
  voicesReady = true
}

export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function speak(text: string): void {
  if (!canSpeak() || !text) return
  ensureVoices()
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'en-US'
  u.rate = 0.9
  const enVoice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('en'))
  if (enVoice) u.voice = enVoice
  speechSynthesis.speak(u)
}
