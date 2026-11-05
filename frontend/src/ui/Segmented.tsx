import type { ComponentChildren } from 'preact'

interface Option<T> {
  value: T
  label: ComponentChildren
  title?: string
}

export function Segmented<T extends string | number>(p: {
  label: string
  value: T
  options: Option<T>[]
  onChange: (v: T) => void
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={p.label}>
      {p.options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === p.value}
          title={o.title}
          onClick={() => p.onChange(o.value)}
          key={String(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
