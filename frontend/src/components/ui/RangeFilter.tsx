import { useId } from 'react'

interface RangeFilterProps {
  label: string
  min: number
  max: number
  step: number
  value: [number, number]
  onChange: (range: [number, number]) => void
  format?: (v: number) => string
}

/** A compact two-handle (min/max) range control built from two native sliders. */
export function RangeFilter({ label, min, max, step, value, onChange, format }: RangeFilterProps) {
  const [lo, hi] = value
  const fmt = format ?? ((v: number) => v.toString())
  const labelId = useId()
  return (
    <div className="min-w-[180px] flex-1 sm:max-w-[260px]" role="group" aria-labelledby={labelId}>
      <div className="mb-1 flex items-center justify-between">
        <span id={labelId} className="stat-label">{label}</span>
        <span className="font-mono text-xs text-ink">
          {fmt(lo)} – {fmt(hi)}
        </span>
      </div>
      <div className="space-y-1">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={lo}
          onChange={(e) => onChange([Math.min(Number(e.target.value), hi), hi])}
          className="h-5 w-full cursor-pointer accent-sky-400"
          aria-label={`${label} minimum`}
          aria-valuetext={fmt(lo)}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={hi}
          onChange={(e) => onChange([lo, Math.max(Number(e.target.value), lo)])}
          className="h-5 w-full cursor-pointer accent-sky-400"
          aria-label={`${label} maximum`}
          aria-valuetext={fmt(hi)}
        />
      </div>
    </div>
  )
}
