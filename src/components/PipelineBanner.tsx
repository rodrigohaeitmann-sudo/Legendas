import type { PipelinePhase } from '../lib/pipeline'

interface Props {
  phase: PipelinePhase
}

const PROVIDER_LABEL: Record<string, string> = {
  google: 'Google',
  mymemory: 'MyMemory',
}

// Small non-blocking status bar under the video so the user knows the
// background work is still going. Hidden completely once the build is done
// (or before it starts) so the UI stays clean.
export default function PipelineBanner({ phase }: Props) {
  let label: string | null = null
  let pct: number | null = null
  let tone: 'progress' | 'error' = 'progress'

  switch (phase.kind) {
    case 'extract':
      label = 'Extraindo áudio'
      pct = phase.pct
      break
    case 'model':
      label = 'Baixando modelo de transcrição'
      pct = phase.pct
      break
    case 'transcribe':
      label = `Transcrevendo · ${phase.windowsDone}/${phase.totalWindows} janelas`
      pct = phase.pct
      break
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
