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
  return (
    <div className="min-w-[180px]">
      <div className="mb-1 flex items-center justify-between">
        <span className="stat-label">{label}</span>
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
          className="w-full accent-sky-400"
          aria-label={`${label} minimum`}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={hi}
          onChange={(e) => onChange([lo, Math.max(Number(e.target.value), lo)])}
          className="w-full accent-sky-400"
          aria-label={`${label} maximum`}
        />
      </div>
    </div>
  )
}
