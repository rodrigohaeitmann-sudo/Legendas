export interface Cue {
  start: number
  end: number
  text: string
}

export interface MergedCue {
  start: number
  end: number
  en: string
  pt: string
  ipa: string
}

export type TrackKey = 'ipa' | 'en' | 'pt'

export type Toggles = Record<TrackKey, boolean>

export interface LoadedMedia {
  videoUrl: string
  cues: MergedCue[]
}
