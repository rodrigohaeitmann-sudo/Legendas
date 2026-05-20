import type { Settings } from '../types'

interface Props {
  settings: Settings
  onChange: (settings: Settings) => void
  onClose: () => void
}

const SCALES: { label: string; value: number }[] = [
  { label: 'Pequeno', value: 0.85 },
  { label: 'Médio', value: 1 },
  { label: 'Grande', value: 1.2 },
  { label: 'Enorme', value: 1.4 },
]

const FONTS: { label: string; value: Settings['fontFamily'] }[] = [
  { label: 'Padrão', value: 'system' },
  { label: 'Serifada', value: 'serif' },
  { label: 'Mono', value: 'mono' },
]

const SPEEDS: { label: string; value: number }[] = [
  { label: '0,75×', value: 0.75 },
  { label: '1×', value: 1 },
  { label: '1,25×', value: 1.25 },
  { label: '1,5×', value: 1.5 },
]

export default function SettingsPanel({ settings, onChange, onClose }: Props) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch })

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Configurações</h2>
          <button className="close-btn" aria-label="Fechar" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="setting">
          <span className="setting-label">Tamanho da legenda</span>
          <div className="opt-row">
            {SCALES.map((o) => (
              <button
                key={o.value}
                className={`opt ${settings.fontScale === o.value ? 'opt-on' : ''}`}
                onClick={() => set({ fontScale: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting">
          <span className="setting-label">Fonte</span>
          <div className="opt-row">
            {FONTS.map((o) => (
              <button
                key={o.value}
                className={`opt ${settings.fontFamily === o.value ? 'opt-on' : ''}`}
                onClick={() => set({ fontFamily: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting">
          <span className="setting-label">Velocidade do vídeo</span>
          <div className="opt-row">
            {SPEEDS.map((o) => (
              <button
                key={o.value}
                className={`opt ${settings.speed === o.value ? 'opt-on' : ''}`}
                onClick={() => set({ speed: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
