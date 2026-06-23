import type { PipelinePhase } from '../lib/pipeline'

export type AudioStatus =
  | { kind: 'idle' }
  | { kind: 'extracting'; pct: number | null }
  | { kind: 'error'; message: string }

interface Props {
  phase: PipelinePhase
  audio?: AudioStatus
}

const PROVIDER_LABEL: Record<string, string> = {
  google: 'Google',
  mymemory: 'MyMemory',
}

const CC_STEP_LABEL: Record<'probe' | 'model' | 'extract' | 'transcribe', string> = {
  probe: 'Lendo metadados',
  model: 'Baixando modelo',
  extract: 'Extraindo áudio',
  transcribe: 'Transcrevendo',
}

interface Row {
  label: string
  pct: number | null
  tone: 'progress' | 'error'
}

function phaseRow(phase: PipelinePhase): Row | null {
  switch (phase.kind) {
    case 'cc': {
      const step = CC_STEP_LABEL[phase.step]
      const label =
        phase.totalChunks > 0
          ? `${step} · trecho ${phase.chunkIndex + 1}/${phase.totalChunks}`
          : step
      let pct: number | null
      if (phase.totalChunks > 0) {
        // Smoothly blend chunk progress: extract = 0..50% of slot,
        // transcribe = 50..100% of slot. Probe/model don't move the bar.
        const slotPct =
          phase.step === 'extract'
            ? Math.min(50, ((phase.pct ?? 0) / 100) * 50)
            : phase.step === 'transcribe'
              ? 50
              : 0
        pct = ((phase.chunkIndex + slotPct / 100) / phase.totalChunks) * 100
      } else {
        pct = phase.pct
      }
      return { label, pct, tone: 'progress' }
    }
    case 'translate': {
      const provider = phase.provider ? ` · ${PROVIDER_LABEL[phase.provider] ?? phase.provider}` : ''
      const failed = phase.failed > 0 ? ` · ${phase.failed} falharam` : ''
      return {
        label: `Traduzindo · ${phase.done}/${phase.total}${provider}${failed}`,
        pct: phase.total > 0 ? (phase.done / phase.total) * 100 : 0,
        tone: 'progress',
      }
    }
    case 'error':
      return { label: phase.message, pct: null, tone: 'error' }
    case 'done':
    case 'idle':
      return null
  }
}

function audioRow(audio: AudioStatus | undefined): Row | null {
  if (!audio) return null
  switch (audio.kind) {
    case 'extracting':
      return {
        label: 'Preparando faixa de áudio escolhida',
        pct: audio.pct,
        tone: 'progress',
      }
    case 'error':
      return { label: audio.message, pct: null, tone: 'error' }
    case 'idle':
      return null
  }
}

function RowView({ row }: { row: Row }) {
  return (
    <div className={`pipeline-banner ${row.tone}`}>
      <div className="pipeline-banner-row">
        <span className="pipeline-banner-label">{row.label}</span>
        {row.pct !== null && row.tone === 'progress' && (
          <span className="pipeline-banner-pct">{Math.round(row.pct)}%</span>
        )}
      </div>
      {row.pct !== null && row.tone === 'progress' && (
        <div className="pipeline-banner-bar">
          <div
            className="pipeline-banner-bar-fill"
            style={{ width: `${Math.round(row.pct)}%` }}
          />
        </div>
      )}
    </div>
  )
}

// Small non-blocking status bar under the video so the user knows the
// background work is still going. Hidden completely once everything is done
// (or before any of it starts) so the UI stays clean. Renders up to two
// rows: pipeline state + audio-track extraction.
export default function PipelineBanner({ phase, audio }: Props) {
  const rows = [audioRow(audio), phaseRow(phase)].filter(Boolean) as Row[]
  if (rows.length === 0) return null
  return (
    <>
      {rows.map((row, i) => (
        <RowView key={i} row={row} />
      ))}
    </>
  )
}
