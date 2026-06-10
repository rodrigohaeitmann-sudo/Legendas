import { franc } from 'franc-min'

export type SourceLang =
  | 'en'
  | 'fr'
  | 'es'
  | 'de'
  | 'it'
  | 'pt'
  | 'nl'
  | 'ru'
  | 'pl'
  | 'ja'
  | 'ko'
  | 'zh'

export const SUPPORTED_LANGS: ReadonlyArray<{ code: SourceLang; label: string }> = [
  { code: 'en', label: 'Inglês' },
  { code: 'fr', label: 'Francês' },
  { code: 'es', label: 'Espanhol' },
  { code: 'de', label: 'Alemão' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Holandês' },
  { code: 'ru', label: 'Russo' },
  { code: 'pl', label: 'Polonês' },
  { code: 'ja', label: 'Japonês' },
  { code: 'ko', label: 'Coreano' },
  { code: 'zh', label: 'Chinês' },
]

// franc returns ISO 639-3; map only the languages we ship as options.
const ISO_3_TO_1: Record<string, SourceLang> = {
  eng: 'en',
  fra: 'fr',
  spa: 'es',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  nld: 'nl',
  rus: 'ru',
  pol: 'pl',
  jpn: 'ja',
  kor: 'ko',
  cmn: 'zh',
}

export function langLabel(code: SourceLang): string {
  return SUPPORTED_LANGS.find((l) => l.code === code)?.label ?? code
}

// Strip SRT/VTT timestamps and indices so franc scores on actual dialogue.
function dialogueOnly(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (!t) return false
      if (/^\d+$/.test(t)) return false
      if (/-->/.test(t)) return false
      if (/^WEBVTT/i.test(t)) return false
      return true
    })
    .join(' ')
}

export function detectLang(srtRaw: string): SourceLang | null {
  const sample = dialogueOnly(srtRaw).slice(0, 4000)
  const code = franc(sample, { minLength: 50 })
  return ISO_3_TO_1[code] ?? null
}
