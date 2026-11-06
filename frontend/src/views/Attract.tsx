import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { dateLabel, num } from '../lib/format'
import { useReducedMotion } from '../lib/hooks'
import { REGIME_COLORS, type MarketData } from '../lib/market'
import { MODEL_COLORS, MODEL_IDS, type SpxData } from '../lib/spx'
import { MODELS, type ModelId } from '../math/models'
import { sviW } from '../math/svi'
import type { SurfaceData } from '../render/surface3d'
import { Surface3D } from '../ui/Surface3D'
import { request, send } from '../worker/client'
import type { MarketFrame } from '../worker/protocol'
import { buildSetup, startOf, TAU_TICKS, xReadoutK, xTickK, xTicksK } from './Market'

interface Frame extends MarketFrame {
  iteration: number
  rmse: number
}

const RUN_MS = 2600 // each model's fit is replayed over about this long
const HOLD_MS = 1100 // pause on each converged fit
const FINALE_MS = 1700 // pause on the full scoreboard
const DAY_STEP = 5 // history replay: one frame every 5 trading days…
const DAY_MS = 24 // …about 200 trading days per second

type Phase = 'run' | 'hold' | 'finale' | 'history'

/** One history frame: the day's index into market.series and its Heston proxy parameters. */
interface HistoryDay {
  i: number
  params: number[]
}

/**
 * A Heston surface for one day of FRED history. Kappa, sigma and rho are today's SPX option
 * fit (the shape of the skew); the day's VIX^2 and VIX3M^2, the expected average variance
 * over 30 and 93 days under Heston,
 *   w_T = theta + (v0 - theta) (1 - e^{-kappa T}) / (kappa T),
 * give two equations for that day's theta and v0 (its level and term structure).
 */
/**
 * The market's surface on the display grid, from the per-expiry SVI fits: total variance at
 * fixed log-moneyness interpolated linearly in maturity between quoted expiries. It is drawn
 * as the wireframe the models are fitted towards.
 */
function marketSurface(spx: SpxData, grid: { x: number[]; tau: number[] }): Float64Array {
  const sl = spx.slices
  const out = new Float64Array(grid.tau.length * grid.x.length)
  grid.tau.forEach((tau, i) => {
    let j = sl.findIndex((s) => s.tau >= tau)
    if (j <= 0) j = 1
    const a = sl[j - 1]
    const b = sl[Math.min(j, sl.length - 1)]
    const f = b.tau > a.tau ? Math.min(1, Math.max(0, (tau - a.tau) / (b.tau - a.tau))) : 0
    grid.x.forEach((x, c) => {
      const k = x * Math.sqrt(tau)
      const w = (1 - f) * sviW(k, a.svi) + f * sviW(k, b.svi)
      out[i * grid.x.length + c] = Math.sqrt(Math.max(w, 1e-8) / tau)
    })
  })
  return out
}

function historyDays(m: MarketData, fit: Record<string, number>): HistoryDay[] {
  const { kappa, sigma, rho } = fit
  const f = (days: number) => {
    const T = days / 365
    return (1 - Math.exp(-kappa * T)) / (kappa * T)
  }
  const [d1, d2] = m.estimation.tenorsDays
  const f1 = f(d1)
  const f2 = f(d2)
  const out: HistoryDay[] = []
  for (let i = 0; i < m.series.t.length; i += DAY_STEP) {
    const w1 = (m.series.vix[i] / 100) ** 2
    const w2 = (m.series.vix3m[i] / 100) ** 2
    const d = (w1 - w2) / (f1 - f2)
    const theta = Math.max(0.002, w1 - d * f1)
    const v0 = Math.max(0.002, theta + d)
    out.push({ i, params: [kappa, theta, sigma, rho, v0] })
  }
  return out
}

/**
 * Attract loop for the embed (?embed=1&autoplay=1), in two acts. First a race: Heston, Bates
 * and double Heston take turns fitting today's real SPX quotes (the worker calibrates each
 * once; the accepted Levenberg-Marquardt iterations are replayed on the rotating surface while
 * residual stems shrink and a scoreboard fills in). Then nine years of real market history:
 * each day's VIX and VIX3M re-level the fitted Heston surface, replayed at ~200 trading days
 * a second over a VIX timeline coloured by HMM regime. Reduced motion shows the finished
 * double-Heston fit without animation.
 */
export function Attract(props: { spx: SpxData | null; market: MarketData | null; onInteract: () => void }) {
  const { spx, market } = props
  const reduced = useReducedMotion()
  const setup = useMemo(() => (spx ? buildSetup(spx) : null), [spx])
  const view = useMemo(() => (setup ? { ...setup.view, smileKs: setup.slices.map(() => []) } : null), [setup])
  const days = useMemo(() => (market && spx ? historyDays(market, spx.fits.heston.params) : null), [market, spx])
  const runs = useRef<Partial<Record<ModelId, Frame[]>>>({})
  const [ready, setReady] = useState<ModelId[]>([])
  const [cursor, setCursor] = useState<{ m: number; f: number; phase: Phase }>({ m: 0, f: 0, phase: 'run' })
  const [still, setStill] = useState<Frame | null>(null)
  const [history, setHistory] = useState<{ surfaces: Float64Array[]; clipped: boolean[]; cap: number } | null>(null)

  // Act one: calibrate the three models in turn, streaming every accepted iteration.
  useEffect(() => {
    if (!spx || !setup || !view || reduced) return
    let live = true
    const handles: { cancel: () => void }[] = []
    const runModel = (i: number) => {
      if (!live || i >= MODEL_IDS.length) return
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
  }, [spx, setup, view, reduced])

  // Act two: price the history surfaces once the calibrations are done (the worker is free).
  useEffect(() => {
    if (!view || !days || reduced || ready.length < MODEL_IDS.length || history) return
    let live = true
    request({ type: 'surface-batch', model: 'heston', params: days.map((d) => d.params), view }, 'surface-batch').then((m) => {
      if (!live) return
      // Cap the IV axis at the 99.9th percentile of every cell so ordinary years fill the box;
      // the few crisis cells above it plateau at the cap, and those frames say so.
      const all = Float64Array.from(m.surfaces.flatMap((s) => Array.from(s)).filter(Number.isFinite)).sort()
      const cap = Math.ceil(all[Math.floor(all.length * 0.999)] * 20) / 20
      setHistory({ surfaces: m.surfaces.map((s) => s.map((v) => Math.min(v, cap))), clipped: m.surfaces.map((s) => s.some((v) => v > cap)), cap })
    })
    return () => {
      live = false
    }
  }, [view, days, reduced, ready.length, history])

  // Reduced motion: one still frame, the finished double-Heston fit.
  useEffect(() => {
    if (!spx || !setup || !view || !reduced) return
    const params = MODELS.double.names.map((n) => spx.fits.double.params[n])
    request({ type: 'market-eval', model: 'double', params, slices: setup.slices, view }, 'market-eval').then((m) => setStill({ ...m, iteration: -1, rmse: m.stats.rmse }))
  }, [spx, setup, view, reduced])

  // Playback clock.
  useEffect(() => {
    if (reduced) return
    const id = MODEL_IDS[cursor.m]
    const frames = runs.current[id]
    const done = ready.includes(id)
    let delay: number
    let next: typeof cursor
    if (cursor.phase === 'history') {
      delay = DAY_MS
      next = history && cursor.f < history.surfaces.length - 1 ? { ...cursor, f: cursor.f + 1 } : { m: 0, f: 0, phase: 'run' }
    } else if (cursor.phase === 'finale') {
      delay = FINALE_MS
      next = history ? { m: cursor.m, f: 0, phase: 'history' } : { m: 0, f: 0, phase: 'run' }
    } else if (cursor.phase === 'hold') {
      delay = HOLD_MS
      next = cursor.m + 1 < MODEL_IDS.length ? { m: cursor.m + 1, f: 0, phase: 'run' } : { ...cursor, phase: 'finale' }
    } else if (frames && cursor.f < frames.length - 1) {
      // Pace so a whole run takes ~RUN_MS whatever its number of iterations.
      const total = done ? frames.length : Math.max(frames.length, 12)
      delay = Math.min(260, Math.max(55, RUN_MS / total))
      next = { ...cursor, f: cursor.f + 1 }
    } else if (done) {
      delay = 0
      next = { ...cursor, phase: 'hold' }
    } else {
      delay = 100 // still calibrating: wait for the next streamed iteration
      next = cursor
    }
    const t = setTimeout(() => setCursor({ ...next }), delay)
    return () => clearTimeout(t)
  }, [cursor, ready, reduced, history])

  const replay = !reduced && cursor.phase === 'history' && !!history && !!days && !!market
  const activeId = MODEL_IDS[cursor.m]
  const frames = runs.current[activeId]
  const frame: Frame | null = reduced ? still : (frames?.[Math.min(cursor.f, frames.length - 1)] ?? null)
  const day = replay ? days![Math.min(cursor.f, days!.length - 1)] : null
  const dayIndex = replay ? Math.min(cursor.f, history!.surfaces.length - 1) : 0
  const daySurface = replay ? history!.surfaces[dayIndex] : null

  const surface: SurfaceData | null = useMemo(() => {
    if (!setup) return null
    if (daySurface) return { grid: setup.grid, iv: daySurface, flag: new Uint8Array(daySurface.length) }
    return frame ? { grid: setup.grid, iv: frame.surface, flag: frame.flag } : null
  }, [frame, setup, daySurface])
  const market3d = useMemo(() => (spx && setup ? marketSurface(spx, setup.grid) : null), [spx, setup])

  // A fixed IV axis per act, so a moving surface is seen moving rather than rescaled.
  const raceRange = useMemo((): [number, number] | undefined => {
    if (!setup || ready.length < MODEL_IDS.length) return undefined
    return niceRange([...(market3d ? [market3d] : []), ...Object.values(runs.current).flatMap((fr) => (fr ?? []).map((f) => f.surface))])
  }, [setup, ready.length, market3d])
  const historyRange = useMemo(() => (history ? niceRange(history.surfaces) : undefined), [history])

  // Scoreboard: finished models show their final RMSE, the active one its live RMSE.
  const finale = reduced || cursor.phase === 'finale'
  const score = (id: ModelId, i: number) => {
    if (reduced) return spx ? spx.fits[id].rmse : Number.NaN
    const f = runs.current[id]
    if (i < cursor.m || finale || (i === cursor.m && cursor.phase === 'hold')) return f ? f[f.length - 1].rmse : Number.NaN
    if (i === cursor.m && frame) return frame.rmse
    return Number.NaN
  }
  // Portfolio cards are small: tighter padding so the surface keeps most of the frame.
  const small = typeof window !== 'undefined' && (window.innerHeight < 340 || window.innerWidth < 560)
  const asOf = spx ? new Date(spx.asOf) : null
  const ratio = spx ? spx.fits.heston.rmse / spx.fits.double.rmse : Number.NaN
  const regimeName = day && market ? market.regimes[market.series.regime[day.i]].name : ''
  const dayDate = day && market ? new Date(market.times[day.i]) : null
  const caption = day
    ? `${dateLabel(dayDate!)} · VIX ${num(market!.series.vix[day.i], 1)} · ${regimeName} regime`
    : !frame
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
        wire={replay ? null : market3d}
        fx
        xLabel="ln(K/F) / √T"
        xTick={xTickK}
        xTicks={xTicksK}
        xReadout={xReadoutK}
        tauScale="sqrt"
        tauTicks={TAU_TICKS}
        autoRotate={0.3}
        sway
        zRange={replay ? historyRange : raceRange}
        onInteract={props.onInteract}
        label={`Heston, Bates and double Heston calibrated live to ${setup?.n ?? 252} real SPX option quotes, then nine years of VIX-implied Heston surfaces. ${caption}.`}
        minimal
        pad={small ? { top: 46, bottom: 38 } : { top: 70, bottom: 54 }}
      />
      <div class="attract-overlay">
        <p class="eyebrow">{replay ? 'real history · heston regime lab' : 'live · heston regime lab'}</p>
        <h1>{replay ? 'Nine years of S&P 500 volatility, replayed' : 'Fitting real SPX options in your browser'}</h1>
        <p class="attract-caption" aria-live="off">
          {caption}
        </p>
      </div>
      {replay && history!.clipped[dayIndex] ? <div class="attract-cap">off the scale: IV axis capped at {Math.round(history!.cap * 100)}%</div> : null}
      {!replay && frame ? <div class="attract-legend">ember wireframe: market (252 quotes, SVI-smoothed) · surface: model</div> : null}
      {replay && market ? (
        <VixTimeline market={market} at={day!.i} />
      ) : (
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
      )}
      <div class="attract-cta">
        {replay ? 'level: daily VIX/VIX3M · skew: today’s SPX fit' : asOf ? `${setup?.n} Cboe quotes · ${asOf.toISOString().slice(0, 10)} close` : ''}
        <span> · drag to explore</span>
      </div>
    </div>
  )
}

function niceRange(arrays: ArrayLike<number>[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i])) continue
      lo = Math.min(lo, a[i])
      hi = Math.max(hi, a[i])
    }
  }
  return [Math.max(0, Math.floor(lo * 20) / 20), Math.ceil(hi * 20) / 20]
}

/** VIX since 2017 as a strip coloured by HMM regime, with a playhead at the replayed day. */
function VixTimeline(p: { market: MarketData; at: number }) {
  const { series } = p.market
  const W = 400
  const H = 34
  const n = series.vix.length
  const vmax = Math.max(...series.vix)
  const x = (i: number) => (i / (n - 1)) * W
  const y = (v: number) => H - 2 - (Math.sqrt(v) / Math.sqrt(vmax)) * (H - 6)
  const geometry = useMemo(() => {
    let line = ''
    for (let i = 0; i < n; i += 2) line += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(series.vix[i]).toFixed(1)}`
    // Regime bands as runs of equal state.
    const bands: { a: number; b: number; k: number }[] = []
    let a = 0
    for (let i = 1; i <= n; i++) {
      if (i === n || series.regime[i] !== series.regime[a]) {
        bands.push({ a, b: i - 1, k: series.regime[a] })
        a = i
      }
    }
    return { line, bands }
  }, [p.market])
  const colors = REGIME_COLORS[3]
  const years = [2018, 2020, 2022, 2024, 2026].map((yr) => ({ yr, i: p.market.times.findIndex((t) => new Date(t).getUTCFullYear() >= yr) })).filter((d) => d.i > 0)
  return (
    <div class="attract-timeline" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {geometry.bands.map((b) => (
          <rect key={b.a} x={x(b.a)} y={H - 3} width={Math.max(0.5, x(b.b) - x(b.a))} height="3" fill={colors[b.k]} />
        ))}
        <path d={`${geometry.line}L${W},${H}L0,${H}Z`} fill="rgba(158,119,237,0.16)" />
        <path d={geometry.line} fill="none" stroke="rgba(206,207,210,0.55)" stroke-width="1" vector-effect="non-scaling-stroke" />
        <path d={`M0,${H}L${x(p.at)},${H}`} stroke="var(--accent)" stroke-width="3" vector-effect="non-scaling-stroke" />
        <line x1={x(p.at)} x2={x(p.at)} y1="0" y2={H} stroke="#f7f7f7" stroke-width="1.5" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="years">
        {years.map((d) => (
          <span key={d.yr} style={{ left: `${(x(d.i) / W) * 100}%` }}>
            {d.yr}
          </span>
        ))}
      </div>
    </div>
  )
}
