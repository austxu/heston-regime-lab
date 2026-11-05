import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { num } from '../lib/format'
import { useReducedMotion } from '../lib/hooks'
import { MODEL_COLORS, MODEL_IDS, type SpxData } from '../lib/spx'
import { MODELS, type ModelId } from '../math/models'
import type { SurfaceData, SurfacePoint } from '../render/surface3d'
import { Surface3D } from '../ui/Surface3D'
import { request, send } from '../worker/client'
import type { MarketFrame } from '../worker/protocol'
import { buildSetup, startOf, TAU_TICKS, xReadoutK, xTickK, xTicksK } from './Market'

interface Frame extends MarketFrame {
  iteration: number
  rmse: number
}

const RUN_MS = 5200 // each model's fit is replayed over about this long
const HOLD_MS = 2600 // pause on each converged fit
const FINALE_MS = 4200 // pause on the full scoreboard before looping

/**
 * Attract loop for the embed (?embed=1&autoplay=1): Heston, Bates and double Heston take
 * turns fitting the real SPX quotes. The worker calibrates each model once; afterwards the
 * accepted Levenberg-Marquardt iterations are replayed on the rotating surface, with the
 * residual stems shrinking and a scoreboard filling in, in a loop. Reduced motion shows the
 * finished double-Heston fit and the final scoreboard without animation.
 */
export function Attract(props: { spx: SpxData | null; onInteract: () => void }) {
  const { spx } = props
  const reduced = useReducedMotion()
  const setup = useMemo(() => (spx ? buildSetup(spx) : null), [spx])
  const view = useMemo(() => (setup ? { ...setup.view, smileKs: setup.slices.map(() => []) } : null), [setup])
  const runs = useRef<Partial<Record<ModelId, Frame[]>>>({})
  const [ready, setReady] = useState<ModelId[]>([])
  const [cursor, setCursor] = useState<{ m: number; f: number; phase: 'run' | 'hold' | 'finale' }>({ m: 0, f: 0, phase: 'run' })
  const [still, setStill] = useState<Frame | null>(null)

  // Calibrate the three models in turn, streaming every accepted iteration.
  useEffect(() => {
    if (!setup || !view || reduced) return
    let live = true
    const handles: { cancel: () => void }[] = []
    const runModel = (i: number) => {
      if (!live || i >= MODEL_IDS.length || !spx) return
      const id = MODEL_IDS[i]
      const frames: Frame[] = []
      const h = send({ type: 'market-calibrate', model: id, start: startOf(spx, id), slices: setup.slices, view }, (msg) => {
        if (msg.type === 'market-iter') {
          frames.push({ ...msg, rmse: Math.sqrt(msg.loss / setup.n) })
          if (frames.length === 1) runs.current[id] = frames
        } else if (msg.type === 'market-done') {
          h.dispose()
          setReady((r) => [...r, id])
          runModel(i + 1)
        }
      })
      handles.push(h)
    }
    runModel(0)
    return () => {
      live = false
      handles.forEach((h) => h.cancel())
    }
  }, [setup, view, reduced])

  // Reduced motion: one still frame, the finished double-Heston fit.
  useEffect(() => {
    if (!setup || !view || !spx || !reduced) return
    const params = MODELS.double.names.map((n) => spx.fits.double.params[n])
    request({ type: 'market-eval', model: 'double', params, slices: setup.slices, view }, 'market-eval').then((m) => setStill({ ...m, iteration: -1, rmse: m.stats.rmse }))
  }, [setup, view, spx, reduced])

  // Playback clock: step through the current model's frames, hold, advance, loop.
  useEffect(() => {
    if (reduced) return
    const id = MODEL_IDS[cursor.m]
    const frames = runs.current[id]
    const done = ready.includes(id)
    let delay: number
    let next: typeof cursor
    if (cursor.phase === 'finale') {
      delay = FINALE_MS
      next = { m: 0, f: 0, phase: 'run' }
    } else if (cursor.phase === 'hold') {
      delay = HOLD_MS
      next = cursor.m + 1 < MODEL_IDS.length ? { m: cursor.m + 1, f: 0, phase: 'run' } : { ...cursor, phase: 'finale' }
    } else if (frames && cursor.f < frames.length - 1) {
      // Pace so a whole run takes ~RUN_MS whatever its number of iterations.
      const total = done ? frames.length : Math.max(frames.length, 12)
      delay = Math.min(600, Math.max(110, RUN_MS / total))
      next = { ...cursor, f: cursor.f + 1 }
    } else if (done) {
      delay = 0
      next = { ...cursor, phase: 'hold' }
    } else {
      delay = 150 // still calibrating: wait for the next streamed iteration
      next = cursor
    }
    const t = setTimeout(() => setCursor({ ...next }), delay)
    return () => clearTimeout(t)
  }, [cursor, ready, reduced])

  const activeId = MODEL_IDS[cursor.m]
  const frames = runs.current[activeId]
  const frame: Frame | null = reduced ? still : (frames?.[Math.min(cursor.f, frames.length - 1)] ?? null)

  const surface: SurfaceData | null = useMemo(() => (frame && setup ? { grid: setup.grid, iv: frame.surface, flag: frame.flag } : null), [frame, setup])
  const points: SurfacePoint[] = useMemo(() => {
    if (!setup) return []
    const out: SurfacePoint[] = []
    let o = 0
    for (const s of setup.slices) {
      for (let i = 0; i < s.k.length; i++, o++) out.push({ x: setup.qx[o], tau: s.tau, iv: s.iv[i], model: frame ? frame.modelIv[o] : undefined })
    }
    return out
  }, [setup, frame])

  // Scoreboard: finished models show their final RMSE, the active one its live RMSE.
  const score = (id: ModelId, i: number) => {
    if (reduced) return spx ? spx.fits[id].rmse : Number.NaN
    const f = runs.current[id]
    if (i < cursor.m || cursor.phase === 'finale' || (i === cursor.m && cursor.phase === 'hold')) return f ? f[f.length - 1].rmse : Number.NaN
    if (i === cursor.m && frame) return frame.rmse
    return Number.NaN
  }
  const finale = reduced || cursor.phase === 'finale'
  // Portfolio cards are small: tighter padding so the surface keeps most of the frame.
  const small = typeof window !== 'undefined' && (window.innerHeight < 340 || window.innerWidth < 560)
  const asOf = spx ? new Date(spx.asOf) : null
  const ratio = spx ? spx.fits.heston.rmse / spx.fits.double.rmse : Number.NaN
  const caption = !frame
    ? 'Loading the SPX option chain…'
    : finale
      ? `Two variance factors fit ${num(ratio, 1)}× better than one`
      : cursor.phase === 'hold'
        ? `${MODELS[activeId].label} converged: ${num(frame.rmse * 100, 2)} vol points`
        : `${MODELS[activeId].label} fitting · iteration ${frame.iteration}`

  return (
    <div class="attract">
      <Surface3D
        data={surface}
        points={points}
        xLabel="ln(K/F) / √T"
        xTick={xTickK}
        xTicks={xTicksK}
        xReadout={xReadoutK}
        tauScale="sqrt"
        tauTicks={TAU_TICKS}
        autoRotate={0.14}
        onInteract={props.onInteract}
        label={`Heston, Bates and double Heston calibrated live to ${setup?.n ?? 252} real SPX option quotes. ${caption}.`}
        minimal
        pad={small ? { top: 46, bottom: 38 } : { top: 70, bottom: 54 }}
      />
      <div class="attract-overlay">
        <p class="eyebrow">live · heston regime lab</p>
        <h1>Fitting real SPX options in your browser</h1>
        <p class="attract-caption" aria-live="off">
          {caption}
        </p>
      </div>
      <div class="attract-score" aria-hidden="true">
        {MODEL_IDS.map((id, i) => {
          const v = score(id, i)
          const active = !finale && i === cursor.m
          return (
            <span key={id} class={`chip score${active ? ' active' : ''}${Number.isFinite(v) ? '' : ' pending'}`} style={`--c: ${MODEL_COLORS[id]}`}>
              <i />
              <span class="lbl">{MODELS[id].label}</span>
              <span class="lbl-short">{id === 'double' ? '2-factor' : MODELS[id].label}</span>
              <b>{Number.isFinite(v) ? `${num(v * 100, 2)} vp` : '—'}</b>
            </span>
          )
        })}
      </div>
      <div class="attract-cta">
        {asOf ? `${setup?.n} Cboe quotes · ${asOf.toISOString().slice(0, 10)} close` : ''}
        <span> · drag to explore</span>
      </div>
    </div>
  )
}
