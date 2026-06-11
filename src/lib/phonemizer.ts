// Phonemizes subtitle lines into IPA using espeak-ng (compiled to WASM).
// Unlike a per-word dictionary lookup, espeak-ng applies language-level
// rules: English contractions, French liaison, German umlaut behavior, etc.
//
// The wasm is large (~9 MB gzip) but lazy-loaded on first IPA run and then
// cached by the browser. The JS wrapper is code-split via dynamic import,
// so the main bundle stays light when no IPA is needed.

import type { SourceLang } from './detectLang'

const VOICE: Record<SourceLang, string> = {
  en: 'en-us',
  fr: 'fr-fr',
  es: 'es',
  de: 'de',
  it: 'it',
  pt: 'pt-br',
  nl: 'nl',
  ru: 'ru',
  pl: 'pl',
  ja: 'ja',
  ko: 'ko',
  zh: 'cmn',
}

const IN_PATH = '/work/in.txt'
const OUT_PATH = '/work/out.txt'

// Force every cue to be its own sentence so espeak emits exactly one phoneme
// line per input line. Without this, espeak runs adjacent cues together when
// neither ends in . ! or ?.
function sentenceTerminated(line: string): string {
  const flat = line.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return /[.!?…]$/.test(flat) ? flat : flat + '.'
}

export async function phonemizeLines(lines: string[], lang: SourceLang): Promise<string[]> {
  const voice = VOICE[lang]
  if (!voice) return lines.map(() => '')

  const sanitized = lines.map(sentenceTerminated)
  // Replace fully-blank cues with a single space so espeak still emits a
  // (blank) line for them and the output stays index-aligned.
  const batch = sanitized.map((l) => l || ' ').join('\n')

  const ESpeakNg = (await import('espeak-ng')).default
  const wasmUrl = (await import('espeak-ng/dist/espeak-ng.wasm?url')).default

  const espeak = await ESpeakNg({
    locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path),
    arguments: [
      '--phonout', OUT_PATH,
      '-q',
      '--ipa=3',
      '-v', voice,
      '-f', IN_PATH,
    ],
    preRun: [
      (m: { FS: { mkdir: (p: string) => void; writeFile: (p: string, d: string) => void } }) => {
        try { m.FS.mkdir('/work') } catch { /* exists */ }
        m.FS.writeFile(IN_PATH, batch)
      },
    ],
  })

  const out: string = espeak.FS.readFile(OUT_PATH, { encoding: 'utf8' })
  const outLines = out.split('\n')
  // Drop the trailing empty line that espeak always appends.
  if (outLines.length && outLines[outLines.length - 1] === '') outLines.pop()
  // Defensive pad/trim against malformed input that produces extra/missing lines.
  while (outLines.length < lines.length) outLines.push('')
  return outLines.slice(0, lines.length).map((l) => l.trim())
}

export function isIpaSupported(lang: SourceLang): boolean {
  return lang in VOICE
}
