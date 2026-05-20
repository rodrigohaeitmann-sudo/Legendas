import type { Cue } from '../types'

// "hh:mm:ss,ms" (SRT) or "hh:mm:ss.ms" / "mm:ss.ms" (VTT) -> seconds
function timestampToSeconds(raw: string): number {
  const cleaned = raw.trim().replace(',', '.')
  const parts = cleaned.split(':').map(Number)
  if (parts.some((n) => Number.isNaN(n))) return NaN
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return seconds
}

const TIME_LINE = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/

// Parses an SRT or VTT file into a list of cues, ordered by start time.
export function parseSubtitles(content: string): Cue[] {
  const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = text.split(/\n\s*\n/)
  const cues: Cue[] = []

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (lines.length === 0) continue

    const timeIndex = lines.findIndex((l) => TIME_LINE.test(l))
    if (timeIndex === -1) continue // header (WEBVTT), notes, etc.

    const [startRaw, endRaw] = lines[timeIndex].split('-->')
    const start = timestampToSeconds(startRaw)
    const end = timestampToSeconds(endRaw.trim().split(/\s+/)[0]) // drop VTT cue settings
    if (Number.isNaN(start) || Number.isNaN(end)) continue

    const textLines = lines.slice(timeIndex + 1)
    if (textLines.length === 0) continue

    cues.push({ start, end, text: textLines.join('\n').trim() })
  }

  return cues.sort((a, b) => a.start - b.start)
}
