import type { JSX } from 'preact'

interface Props {
  id: string
  sym: string
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  aside?: string
  onInput: (v: number) => void
  onFocus?: () => void
  onCommit?: () => void
}

/** A native range input (keyboard-operable, labelled) styled as an instrument control. */
export function Slider(p: Props) {
  const pct = ((p.value - p.min) / (p.max - p.min)) * 100
  const style = { '--pct': `${pct}%` } as JSX.CSSProperties
  return (
    <div class="slider" onPointerEnter={p.onFocus}>
      <label for={p.id}>
        <span class="sym">{p.sym}</span>
        <span>{p.label}</span>
      </label>
      <output for={p.id} aria-hidden="true">
        {p.format(p.value)}
        {p.aside && <small>{p.aside}</small>}
      </output>
      <input
        id={p.id}
        type="range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={p.value}
        style={style}
        aria-valuetext={`${p.format(p.value)}${p.aside ? ` (${p.aside})` : ''}`}
        onInput={(e) => p.onInput(+(e.currentTarget as HTMLInputElement).value)}
        onChange={() => p.onCommit?.()}
        onFocus={p.onFocus}
      />
    </div>
  )
}
