import { cacheGet, cacheSet } from './translateCache'
import type { SourceLang } from './detectLang'

const CONCURRENCY = 4
const TARGET = 'pt-BR'

export interface TranslationProgress {
  done: number
  total: number
  failed: number
  provider: ProviderId | null
}

export type ProviderId = 'mymemory' | 'google'

export interface TranslateOptions {
  signal?: AbortSignal
  onProgress?: (p: TranslationProgress) => void
  email?: string
  source?: SourceLang
}

class QuotaError extends Error {
  constructor() {
    super('quota')
  }
}

// ---------- Providers ----------

interface MyMemoryResponse {
  responseData?: { translatedText?: string }
}

async function viaMyMemory(
  text: string,
  source: SourceLang,
  email: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const params = new URLSearchParams({ q: text, langpair: `${source}|${TARGET}` })
  if (email) params.set('de', email)
  const res = await fetch(`https://api.mymemory.translated.net/get?${params.toString()}`, { signal })
  if (!res.ok) {
    if (res.status === 429) throw new QuotaError()
    throw new Error(`http ${res.status}`)
  }
  const data = (await res.json()) as MyMemoryResponse
  const t = data.responseData?.translatedText
  if (!t) throw new Error('empty')
  // The free tier signals exhaustion by inlining a "MYMEMORY WARNING ..." string
  // into translatedText instead of using a proper error code.
  if (/MYMEMORY WARNING/i.test(t)) throw new QuotaError()
  return t
}

// Public Google Translate endpoint used by translate-shell and similar tools.
// No API key, supports CORS, returns chunked JSON. Rate-limits on heavy abuse
// (HTTP 429) but otherwise has no documented daily quota.
async function viaGoogle(text: string, source: SourceLang, signal?: AbortSignal): Promise<string> {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: source,
    tl: TARGET,
    dt: 't',
    q: text,
  })
  const res = await fetch(
    `https://translate.googleapis.com/translate_a/single?${params.toString()}`,
    { signal },
  )
  if (!res.ok) {
    if (res.status === 429) throw new QuotaError()
    throw new Error(`http ${res.status}`)
  }
  const data = (await res.json()) as unknown
  const chunks = Array.isArray(data) && Array.isArray((data as unknown[])[0]) ? ((data as unknown[])[0] as unknown[]) : []
  let out = ''
  for (const item of chunks) {
    if (Array.isArray(item) && typeof item[0] === 'string') out += item[0]
  }
  if (!out) throw new Error('empty')
  return out
}

// ---------- Runner with sticky provider fallback ----------

class Runner {
  private dead = new Set<ProviderId>()
  current: ProviderId = 'mymemory'

  constructor(private source: SourceLang, private email?: string) {}

  private order(): ProviderId[] {
    const all: ProviderId[] = ['mymemory', 'google']
    return all.filter((p) => !this.dead.has(p))
  }

  async translate(text: string, signal?: AbortSignal): Promise<string> {
    let lastErr: unknown
    for (const p of this.order()) {
      try {
        const t =
          p === 'mymemory'
            ? await viaMyMemory(text, this.source, this.email, signal)
            : await viaGoogle(text, this.source, signal)
        this.current = p
        return t
      } catch (e) {
        lastErr = e
        if (signal?.aborted) throw e
        if (e instanceof QuotaError) {
          // Sticky: don't keep retrying a provider that's out for the rest of the run.
          this.dead.add(p)
          continue
        }
        // Transient/unknown error: try next provider, but don't mark dead.
        continue
      }
    }
    throw (lastErr as Error) ?? new Error('all providers failed')
  }
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// Cache key namespaces translations by source language so the same surface
// text in different source languages doesn't collide (e.g. "Pi" in en vs it).
function cacheKey(source: SourceLang, text: string): string {
  return `${source}\t${text}`
}

export async function translateLines(
  lines: string[],
  opts: TranslateOptions = {},
): Promise<string[]> {
  const source: SourceLang = opts.source ?? 'en'
  const runner = new Runner(source, opts.email)
  const results = new Array<string>(lines.length).fill('')
  let done = 0
  let failed = 0
  const total = lines.length
  const report = () => opts.onProgress?.({ done, total, failed, provider: runner.current })

  const queue: number[] = lines.map((_, i) => i)
  report()

  async function worker() {
    while (queue.length) {
      if (opts.signal?.aborted) return
      const i = queue.shift()
      if (i === undefined) break
      const flat = flatten(lines[i])
      if (!flat) {
        results[i] = ''
        done++
        report()
        continue
      }
      const key = cacheKey(source, flat)
      const cached = await cacheGet(key)
      if (cached !== null) {
        results[i] = cached
        done++
        report()
        continue
      }
      try {
        const t = await runner.translate(flat, opts.signal)
        results[i] = t
        void cacheSet(key, t)
      } catch {
        results[i] = ''
        failed++
      }
      done++
      report()
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return results
}
