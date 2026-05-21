// Converts the FreeDict eng-por TEI dictionary into a compact JSON lookup
// used by the in-app word popup (offline EN->PT translation + IPA).
//
// Source: https://github.com/freedict/fd-dictionaries (eng-por, GPL-2.0+).
// Usage: node scripts/build-dict.mjs <path-to-eng-por.tei>
//
// Output shape (src/data/en-pt.json):
//   { "house": { "i": "haʊs", "t": ["casa"] }, ... }
//   i = IPA (optional), t = list of Portuguese translations.

import { readFileSync, writeFileSync } from 'node:fs'

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/build-dict.mjs <eng-por.tei>')
  process.exit(1)
}

const xml = readFileSync(src, 'utf8')

function decode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

const body = xml.slice(xml.indexOf('<body>'), xml.indexOf('</body>'))
const entries = body.match(/<entry>[\s\S]*?<\/entry>/g) ?? []

const dict = Object.create(null)

for (const entry of entries) {
  const orthMatch = entry.match(/<orth>([\s\S]*?)<\/orth>/)
  if (!orthMatch) continue
  const word = decode(orthMatch[1]).toLowerCase()
  if (!word) continue

  const pronMatch = entry.match(/<pron>([\s\S]*?)<\/pron>/)
  const ipa = pronMatch ? decode(pronMatch[1]) : ''

  const translations = []
  for (const cit of entry.match(/<cit type="trans">[\s\S]*?<\/cit>/g) ?? []) {
    const q = cit.match(/<quote>([\s\S]*?)<\/quote>/)
    if (q) {
      const t = decode(q[1])
      if (t && !translations.includes(t)) translations.push(t)
    }
  }

  if (translations.length === 0 && !ipa) continue

  const existing = dict[word]
  if (existing) {
    for (const t of translations) if (!existing.t.includes(t)) existing.t.push(t)
    if (!existing.i && ipa) existing.i = ipa
  } else {
    const value = { t: translations }
    if (ipa) value.i = ipa
    dict[word] = value
  }
}

const out = 'src/data/en-pt.json'
writeFileSync(out, JSON.stringify(dict))
const count = Object.keys(dict).length
const bytes = Buffer.byteLength(JSON.stringify(dict))
console.log(`wrote ${count} entries to ${out} (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
