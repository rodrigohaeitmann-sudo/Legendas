import { cacheGet, cacheSet } from './translateCache'

const ENDPOINT = 'https://api.mymemory.translated.net/get'
const LANGPAIR = 'en|pt-BR'
const CONCURRENCY = 4

interface MyMemoryResponse {
  responseData?: { translatedText?: string }
  responseStatus?: number | string
}

export interface TranslationProgress {
  done: number
  total: number
  failed: number
}

export interface TranslateOptions {
  signal?: AbortSignal
  onProgress?: (p: TranslationProgress) => void
}

async function translateOne(text: string, signal?: AbortSignal): Promise<string> {
  const params = new URLSearchParams({ q: text, langpair: LANGPAIR })
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, { signal })
  if (!res.ok) throw new Error(`http ${res.status}`)
  const data = (await res.json()) as MyMemoryResponse
  const t = data.responseData?.translatedText
  if (!t) throw new Error('empty translation')
  // MyMemory echoes a "MYMEMORY WARNING" sentinel into translatedText when the
  // free quota is exhausted — treat that as a failure for that line.
  if (/MYMEMORY WARNING/i.test(t)) throw new Error('quota exceeded')
  return t
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export async function translateLines(
  lines: string[],
  opts: TranslateOptions = {},
): Promise<string[]> {
  const results = new Array<string>(lines.length).fill('')
  let done = 0
  let failed = 0
  const total = lines.length
  const report = () => opts.onProgress?.({ done, total, failed })

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
      const cached = await cacheGet(flat)
      if (cached !== null) {
        results[i] = cached
        done++
        report()
        continue
      }
      try {
        const t = await translateOne(flat, opts.signal)
        results[i] = t
        void cacheSet(flat, t)
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
