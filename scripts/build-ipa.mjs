// Converts the CMU Pronouncing Dictionary (ARPAbet) into a compact
// word -> IPA JSON used at runtime to render phonetic subtitles.
//
// Usage: node scripts/build-ipa.mjs
//
// Output: src/data/en-ipa.json  ({ "house": "haʊs", ... })

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { dictionary } = require('cmu-pronouncing-dictionary')

// ARPAbet phoneme -> IPA. Stress markers (0/1/2 suffix) are stripped for
// compactness; the IPA stays readable without them.
const MAP = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ',
  EH: 'ɛ', ER: 'ɝ', EY: 'eɪ', IH: 'ɪ', IY: 'i', OW: 'oʊ',
  OY: 'ɔɪ', UH: 'ʊ', UW: 'u',
  B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h',
  JH: 'dʒ', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ', P: 'p',
  R: 'ɹ', S: 's', SH: 'ʃ', T: 't', TH: 'θ', V: 'v', W: 'w',
  Y: 'j', Z: 'z', ZH: 'ʒ',
}

function toIpa(arpa) {
  const out = []
  for (const tok of arpa.split(/\s+/)) {
    const phoneme = tok.replace(/[0-9]/g, '')
    const ipa = MAP[phoneme]
    if (ipa) out.push(ipa)
  }
  return out.join('')
}

const result = Object.create(null)
let skipped = 0
for (const [word, arpa] of Object.entries(dictionary)) {
  // CMU stores multiple pronunciations as word(1), word(2). Keep only the primary.
  if (/\(\d+\)$/.test(word)) continue
  // Skip leading punctuation entries like "'bout" — uncommon and noisy.
  if (!/^[a-z]/.test(word)) {
    skipped++
    continue
  }
  const ipa = toIpa(arpa)
  if (ipa) result[word] = ipa
}

const out = 'src/data/en-ipa.json'
writeFileSync(out, JSON.stringify(result))
const count = Object.keys(result).length
const bytes = Buffer.byteLength(JSON.stringify(result))
console.log(`wrote ${count} entries to ${out} (${(bytes / 1024 / 1024).toFixed(2)} MB, skipped ${skipped})`)
