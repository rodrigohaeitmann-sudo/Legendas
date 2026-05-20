import type { Cue, MergedCue } from '../types'

// Merges the three tracks using English as the canonical dialogue timeline.
// PT and IPA are matched to EN cues by index (same order/count assumed).
export function mergeCues(en: Cue[], pt: Cue[], ipa: Cue[]): MergedCue[] {
  return en.map((cue, i) => ({
    start: cue.start,
    end: cue.end,
    en: cue.text,
    pt: pt[i]?.text ?? '',
    ipa: ipa[i]?.text ?? '',
  }))
}
