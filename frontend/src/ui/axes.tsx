/** SVG axis + grid primitives shared by the 2D charts. */
import type { Scale } from '../lib/scale'

export interface Margin {
  top: number
  right: number
  bottom: number
  left: number
}

export function GridY({ y, ticks, x0, x1 }: { y: Scale; ticks: number[]; x0: number; x1: number }) {
  return (
    <g class="grid">
      {ticks.map((t) => (
        <line key={t} x1={x0} x2={x1} y1={y(t)} y2={y(t)} />
      ))}
    </g>
  )
}

export function GridX({ x, ticks, y0, y1 }: { x: Scale; ticks: number[]; y0: number; y1: number }) {
  return (
    <g class="grid">
      {ticks.map((t) => (
        <line key={t} y1={y0} y2={y1} x1={x(t)} x2={x(t)} />
      ))}
    </g>
  )
}

export function AxisLeft({ y, ticks, x, format, title }: { y: Scale; ticks: number[]; x: number; format: (v: number) => string; title?: string }) {
  return (
    <g>
      {ticks.map((t) => (
        <text key={t} x={x - 6} y={y(t)} text-anchor="end" dominant-baseline="middle">
          {format(t)}
        </text>
      ))}
      {title && (
        <text class="axis-title" x={x - 6} y={Math.min(...y.range) - 10} text-anchor="end">
          {title}
        </text>
      )}
    </g>
  )
}

export function AxisRight({ y, ticks, x, format, title }: { y: Scale; ticks: number[]; x: number; format: (v: number) => string; title?: string }) {
  return (
    <g>
      {ticks.map((t) => (
        <text key={t} x={x + 6} y={y(t)} text-anchor="start" dominant-baseline="middle">
          {format(t)}
        </text>
      ))}
      {title && (
        <text class="axis-title" x={x + 6} y={Math.min(...y.range) - 10} text-anchor="start">
          {title}
        </text>
      )}
    </g>
  )
}

export function AxisBottom({ x, ticks, y, format, title }: { x: Scale; ticks: number[]; y: number; format: (v: number) => string; title?: string }) {
  const [r0, r1] = x.range
  return (
    <g>
      {ticks.map((t) => (
        <text key={t} x={x(t)} y={y + 15} text-anchor="middle">
          {format(t)}
        </text>
      ))}
      {title && (
        <text class="axis-title" x={(r0 + r1) / 2} y={y + 32} text-anchor="middle">
          {title}
        </text>
      )}
    </g>
  )
}

/** SVG path for a polyline, skipping non-finite points. */
export function linePath(xs: ArrayLike<number>, ys: ArrayLike<number>, x: Scale, y: Scale): string {
  let d = ''
  let pen = false
  for (let i = 0; i < xs.length; i++) {
    const yv = ys[i]
    if (!Number.isFinite(yv)) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${x(xs[i]).toFixed(1)},${y(yv).toFixed(1)}`
    pen = true
  }
  return d
}
