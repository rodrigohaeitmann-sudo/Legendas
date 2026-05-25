import ipaUrl from '../data/en-ipa.json?url'

type IpaDict = Record<string, string>

let cache: Promise<IpaDict> | null = null

function load(): Promise<IpaDict> {
  if (!cache) {
    cache = fetch(ipaUrl).then((r) => {
      if (!r.ok) throw new Error(`ipa ${r.status}`)
      return r.json() as Promise<IpaDict>
    })
  }
  return cache
}

function get(dict: IpaDict, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(dict, key)) return null
  const v = dict[key]
  return typeof v === 'string' ? v : null
}

// "Don't" -> "dont"; "isn't" -> "isnt"; strip quotes/punct, keep internal letters.
function normalize(token: string): string {
  return token.toLowerCase().replace(/[^a-z']/g, '').replace(/'/g, '')
}

// Convert one English line into per-word IPA, preserving word order and
// approximate spacing. Words without a pronunciation entry are kept as-is.
export async function lineToIpa(text: string): Promise<string> {
  const dict = await load()
  return text
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok)) return tok
      const word = normalize(tok)
      if (!word) return tok
      const ipa = get(dict, word)
      return ipa ?? tok
    })
    .join('')
}

// Convert many lines in parallel (fast; everything is in memory).
export async function linesToIpa(lines: string[]): Promise<string[]> {
  await load()
  return Promise.all(lines.map((l) => lineToIpa(l)))
}

export function preloadIpa(): Promise<unknown> {
  return load()
}
