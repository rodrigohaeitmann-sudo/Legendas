import type { PipelinePhase } from '../lib/pipeline'

interface Props {
  phase: PipelinePhase
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

// Small non-blocking status bar under the video so the user knows the
// background work is still going. Hidden completely once the build is done
// (or before it starts) so the UI stays clean.
export default function PipelineBanner({ phase }: Props) {
  let label: string | null = null
  let pct: number | null = null
  let tone: 'progress' | 'error' = 'progress'

  switch (phase.kind) {
    case 'cc': {
      // Overall progress: chunkIndex completed out of totalChunks. Within
      // the current chunk, the step label tells what's happening; the bar
      // advances when the chunk completes.
      const step = CC_STEP_LABEL[phase.step]
      label =
        phase.totalChunks > 0
          ? `${step} · trecho ${phase.chunkIndex + 1}/${phase.totalChunks}`
          : step
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
      break
    }
    case 'translate': {
      const provider = phase.provider ? ` · ${PROVIDER_LABEL[phase.provider] ?? phase.provider}` : ''
      const failed = phase.failed > 0 ? ` · ${phase.failed} falharam` : ''
      label = `Traduzindo · ${phase.done}/${phase.total}${provider}${failed}`
      pct = phase.total > 0 ? (phase.done / phase.total) * 100 : 0
      break
    }
    case 'error':
      label = phase.message
      tone = 'error'
      break
    case 'done':
    case 'idle':
      return null
  }

  return (
    <div className={`pipeline-banner ${tone}`}>
      <div className="pipeline-banner-row">
        <span className="pipeline-banner-label">{label}</span>
        {pct !== null && tone === 'progress' && (
          <span className="pipeline-banner-pct">{Math.round(pct)}%</span>
        )}
      </div>
      {pct !== null && tone === 'progress' && (
        <div className="pipeline-banner-bar">
          <div className="pipeline-banner-bar-fill" style={{ width: `${Math.round(pct)}%` }} />
        </div>
      )}
    </div>
  )
}
