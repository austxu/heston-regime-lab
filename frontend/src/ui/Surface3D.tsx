import { useEffect, useRef, useState } from 'preact/hooks'
import { pct, tenor } from '../lib/format'
import { useReducedMotion } from '../lib/hooks'
import { SurfaceRenderer, type HoverInfo, type RendererOptions, type SurfaceData, type SurfacePoint } from '../render/surface3d'

interface Props {
  data: SurfaceData | null
  points?: SurfacePoint[]
  xLabel: string
  xTick: (x: number) => string
  xTicks: (lo: number, hi: number) => number[]
  xReadout: (x: number) => string
  autoRotate?: number
  onInteract?: () => void
  label: string
  hint?: string
  minimal?: boolean
  pad?: { top: number; bottom: number }
  /** Maturity axis spacing; 'sqrt' gives short expiries room. */
  tauScale?: 'linear' | 'sqrt'
  tauTicks?: number[]
  zRange?: [number, number]
  sway?: boolean
  fx?: boolean
  /** Wireframe target surface on the same grid as data (WebGL only). */
  wire?: ArrayLike<number> | null
}

const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches

/** The canvas surface plus an HTML hover readout and an accessible description. */
export function Surface3D(p: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const back = useRef<HTMLCanvasElement>(null)
  const glc = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<'webgl' | 'canvas'>('canvas')
  const r = useRef<SurfaceRenderer | null>(null)
  const reduced = useReducedMotion()
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const interact = useRef(p.onInteract)
  interact.current = p.onInteract

  useEffect(() => {
    const opts: RendererOptions = {
      xLabel: p.xLabel,
      xTick: p.xTick,
      xTicks: p.xTicks,
      onHover: setHover,
      onInteract: () => interact.current?.(),
      reducedMotion: reduced,
      minimal: p.minimal,
      pad: p.pad,
      tauScale: p.tauScale,
      tauTicks: p.tauTicks,
      zRange: p.zRange,
      sway: p.sway,
      fx: p.fx,
    }
    r.current = new SurfaceRenderer(canvas.current!, opts, { back: back.current!, gl: glc.current! })
    setMode(r.current.webgl ? 'webgl' : 'canvas')
    return () => r.current?.destroy()
  }, [])
  useEffect(() => r.current?.setOptions({ xLabel: p.xLabel, xTick: p.xTick, xTicks: p.xTicks }), [p.xLabel, p.xTick, p.xTicks])
  useEffect(() => r.current?.setReducedMotion(reduced), [reduced])
  useEffect(() => r.current?.setOptions({ zRange: p.zRange }), [p.zRange?.[0], p.zRange?.[1]])
  useEffect(() => {
    if (p.data) r.current?.setSurface(p.data)
  }, [p.data])
  useEffect(() => r.current?.setPoints(p.points ?? []), [p.points])
  useEffect(() => r.current?.setWire(p.wire ?? null), [p.wire])
  useEffect(() => r.current?.setAutoRotate(p.autoRotate ?? 0), [p.autoRotate, reduced])

  const tipLeft = hover ? Math.min(hover.px + 14, (canvas.current?.clientWidth ?? 0) - 150) : 0
  const tipTop = hover ? Math.max(8, hover.py - 70) : 0
  return (
    <div class="surface-wrap" data-renderer={mode}>
      <canvas ref={back} class="surface-layer" aria-hidden="true" />
      <canvas ref={glc} class="surface-layer" aria-hidden="true" />
      <canvas
        ref={canvas}
        class="surface-canvas"
        tabIndex={0}
        role="img"
        aria-label={`${p.label} Drag or use the arrow keys to rotate; Home resets the view.`}
      />
      {hover && (
        <div class="tooltip" style={{ left: `${tipLeft}px`, top: `${tipTop}px` }} aria-hidden="true">
          <div class="row">
            <span>strike</span>
            <b>{p.xReadout(hover.x)}</b>
          </div>
          <div class="row">
            <span>maturity</span>
            <b>{tenor(hover.tau)}</b>
          </div>
          <div class="row">
            <span>implied vol</span>
            <b>{pct(hover.iv, 2)}</b>
          </div>
          {hover.flagged && <div class="warn">wing below quadrature floor · extrapolated</div>}
        </div>
      )}
      {p.hint && (
        <div class="surface-hint">
          <span class="narrow-only">axes: {p.xLabel} × maturity · </span>
          {TOUCH ? p.hint.replace('hover', 'tap') : p.hint}
        </div>
      )}
    </div>
  )
}
