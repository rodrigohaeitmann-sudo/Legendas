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

// Force every cue to be a single espeak clause. espeak breaks output into
// one line per clause and treats any of ., , ; : ! ? … — – as a clause
// separator. If any of those appear inside a cue, the cue produces multiple
// IPA lines and shifts the index of every following cue. Strip them all and
// append a single period as the cue terminator.
function sentenceTerminated(line: string): string {
  let flat = line.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  flat = flat.replace(/[.,;:!?…—–]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat + '.'
}

export async function phonemizeLines(lines: string[], lang: SourceLang): Promise<string[]> {
  const voice = VOICE[lang]
  if (!voice) return lines.map(() => '')

  // Drop empty cues from the batch but remember their original indices so
  // we can write '' back into those slots without disturbing alignment.
  const indices: number[] = []
  const inputs: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const s = sentenceTerminated(lines[i])
    if (s) {
      indices.push(i)
      inputs.push(s)
    }
  }

  const results = new Array<string>(lines.length).fill('')
  if (inputs.length === 0) return results

  const batch = inputs.join('\n')

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
  const outLines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (outLines.length !== inputs.length) {
    // The clause-strip in sentenceTerminated should make this impossible, but
    // if a future espeak version breaks on a new character we want to know
    // rather than silently scrambling the IPA column.
    console.warn(
      `phonemizer: expected ${inputs.length} IPA lines for ${lang}, got ${outLines.length}`,
    )
  }

  for (let i = 0; i < indices.length; i++) {
    results[indices[i]] = outLines[i] ?? ''
  }
  return results
}

export function isIpaSupported(lang: SourceLang): boolean {
  return lang in VOICE
}
