import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { fixed, num, pct, pctTickFormat, sci } from '../lib/format'
import { flags, useReducedMotion, useSize } from '../lib/hooks'
import { extent, linear, log, logTicks, niceDomain, ticks } from '../lib/scale'
import { atmAt, daysLabel, expiryLabel, MODEL_COLORS, MODEL_IDS, type SpxData, type SpxSlice } from '../lib/spx'
import type { FitStats, MarketSlice } from '../math/market'
import { MODELS, type ModelId } from '../math/models'
import { sviVol } from '../math/svi'
import type { HestonParams } from '../math/types'
import type { SurfaceData, SurfacePoint } from '../render/surface3d'
import { AxisBottom, AxisLeft, GridY, linePath } from '../ui/axes'
import { Segmented } from '../ui/Segmented'
import { Surface3D } from '../ui/Surface3D'
import { request, send } from '../worker/client'
import type { MarketDoneMsg, MarketFrame, MarketView } from '../worker/protocol'

interface Frame extends MarketFrame {
  iteration: number
  loss: number
  rmse: number
  params: number[]
  nfev: number
}

const STEP_MS = 380
const SMILE_N = 41
const DECIMALS: Record<string, number> = { kappa: 2, theta: 4, sigma: 2, rho: 3, v0: 4, lam: 3, mu_j: 3, sigma_j: 3 }
const decimalsOf = (name: string) => DECIMALS[name.replace(/[12]$/, '')] ?? 3

export const xTicksK = (lo: number, hi: number) => ticks(lo, hi, 4)
export const xTickK = (x: number) => fixed(x, 1)
export const xReadoutK = (x: number) => `ln(K/F)/√T = ${fixed(x, 3)}`
export const TAU_TICKS = [1 / 12, 0.25, 0.5, 1, 2]

export function buildSetup(spx: SpxData) {
  const slices: SpxSlice[] = spx.slices
  const qx = slices.flatMap((s) => s.k.map((k) => k / Math.sqrt(s.tau)))
  const qt = slices.flatMap((s) => s.k.map(() => s.tau))
  const [xlo, xhi] = extent(qx)
  const pad = (xhi - xlo) * 0.04
  const a = Math.sqrt(slices[0].tau)
  const b = Math.sqrt(slices[slices.length - 1].tau)
  const taus = Array.from({ length: 24 }, (_, i) => (a + ((b - a) * i) / 23) ** 2)
  const xs = Array.from({ length: 31 }, (_, j) => xlo - pad + ((xhi - xlo + 2 * pad) * j) / 30)
  const smileKs = slices.map((s) => {
    const [lo, hi] = extent(s.k)
    const p = (hi - lo) * 0.08
    return Array.from({ length: SMILE_N }, (_, j) => lo - p + ((hi - lo + 2 * p) * j) / (SMILE_N - 1))
  })
  const view: MarketView = { taus, xs, atms: taus.map((t) => atmAt(slices, t)), smileKs }
  // Black-Scholes baseline: one vol per expiry (its ATM vol), i.e. a term structure without smile.
  const bsIv = slices.flatMap((s) => s.k.map(() => s.atmVol))
  const n = bsIv.length
  const iv = slices.flatMap((s) => s.iv)
  const bsRmse = Math.sqrt(bsIv.reduce((t, v, i) => t + (v - iv[i]) ** 2, 0) / n)
  const sviIv = slices.map((s) => s.k.map((k) => sviVol(k, s.tau, s.svi)))
  return { slices, qx, qt, view, grid: { kind: 'k' as const, x: xs, tau: taus }, bsRmse, sviIv, n }
}
type Setup = ReturnType<typeof buildSetup>

export const startOf = (spx: SpxData, id: ModelId) => spx.fits[id].start
const pyParams = (spx: SpxData, id: ModelId) => MODELS[id].names.map((n) => spx.fits[id].params[n])

export function Market(props: { spx: SpxData | null; error: boolean; active: boolean; onUseParams: (p: HestonParams) => void }) {
  const { spx } = props
  const reduced = useReducedMotion()
  const [model, setModel] = useState<ModelId>('heston')
  const setup = useMemo(() => (spx ? buildSetup(spx) : null), [spx])
  const [base, setBase] = useState<(Frame & { stats: FitStats }) | null>(null)
  const [frames, setFrames] = useState<Frame[]>([])
  const [shown, setShown] = useState(0)
  const [done, setDone] = useState<MarketDoneMsg['result'] | null>(null)
  const [running, setRunning] = useState(false)
  const handle = useRef<{ cancel: () => void } | null>(null)

  // The offline scipy optimum for the selected model, shown until the browser fit is run.
  useEffect(() => {
    if (!spx || !setup) return
    handle.current?.cancel()
    setBase(null)
    setFrames([])
    setDone(null)
    setRunning(false)
    setShown(0)
    let live = true
    const params = pyParams(spx, model)
    request({ type: 'market-eval', model, params, slices: setup.slices, view: setup.view }, 'market-eval').then((m) => {
      if (!live) return
      setBase({ ...m, iteration: -1, loss: m.stats.rmse ** 2 * setup.n, rmse: m.stats.rmse, params, nfev: 0, stats: m.stats })
    })
    return () => {
      live = false
    }
  }, [setup, model])

  useEffect(() => () => handle.current?.cancel(), [])

  const calibrate = () => {
    if (!spx || !setup) return
    handle.current?.cancel()
    setFrames([])
    setDone(null)
    setShown(0)
    setRunning(true)
    const h = send({ type: 'market-calibrate', model, start: startOf(spx, model), slices: setup.slices, view: setup.view }, (msg) => {
      if (msg.type === 'market-iter') {
        setFrames((f) => [...f, { ...msg, rmse: Math.sqrt(msg.loss / setup.n) }])
      } else if (msg.type === 'market-done') {
        setDone(msg.result)
        h.dispose()
      }
    })
    handle.current = h
  }

  // Replay streamed iterations at a readable pace (instantly with reduced motion).
  useEffect(() => {
    if (!frames.length) return
    if (reduced || !props.active) {
      setShown(frames.length - 1)
      return
    }
    if (shown >= frames.length - 1) return
    const t = setTimeout(() => setShown((s) => Math.min(frames.length - 1, s + 1)), shown === 0 ? 250 : STEP_MS)
    return () => clearTimeout(t)
  }, [frames.length, shown, reduced, props.active])
  useEffect(() => {
    if (done && shown >= frames.length - 1) setRunning(false)
  }, [done, shown, frames.length])

  const frame: Frame | null = frames[shown] ?? base
  const replaying = running || (frames.length > 0 && shown < frames.length - 1)
  const stats = useMemo(() => (frame && setup ? sliceStats(frame.modelIv, setup.slices) : null), [frame, setup])

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

  if (!spx || !setup) {
    return <div class="panel loading">{props.error ? 'Could not load the SPX option snapshot.' : 'Loading the SPX option snapshot…'}</div>
  }
  const spec = MODELS[model]
  const py = spx.fits[model]
  const asOf = new Date(spx.asOf)
  const summary = frame
    ? `${spec.label} fitted to ${setup.n} real SPX implied vols on ${setup.slices.length} expiries. ${frame.iteration < 0 ? 'Showing the offline scipy optimum' : `Iteration ${frame.iteration}`}: RMSE ${num(frame.rmse * 100, 3)} vol points.`
    : 'Loading.'

  return (
    <section class="view v-market" aria-labelledby="mkt-title">
      <div class="panel area-surface">
        <div class="panel-head">
          <div>
            <p class="eyebrow">02 / market</p>
            <h2 id="mkt-title">{spec.label} on today's real SPX surface</h2>
            <p class="panel-sub">
              <span style={{ color: 'var(--ember)' }}>●</span> {setup.n} mid implied vols, {setup.slices.length} expiries, {expiryLabel(spx.slices[0].expiry)} to{' '}
              {expiryLabel(spx.slices[spx.slices.length - 1].expiry, true)} · Cboe delayed quotes, {asOf.toISOString().slice(0, 10)} close ·{' '}
              <span style={{ color: MODEL_COLORS[model] }}>■</span> model
            </p>
          </div>
          <div class="readouts">
            <div class="readout">
              <span class="eyebrow">rmse</span>
              <b>{frame ? `${num(frame.rmse * 100, 2)} vp` : '—'}</b>
            </div>
            <div class="readout">
              <span class="eyebrow">inside bid–ask</span>
              <b>{stats ? pct(stats.inside, 0) : '—'}</b>
            </div>
            <div class="readout">
              <span class="eyebrow">{frame && frame.iteration >= 0 ? 'iteration' : 'params'}</span>
              <b>{frame ? (frame.iteration >= 0 ? frame.iteration : spec.names.length) : '—'}</b>
            </div>
          </div>
        </div>
        <Surface3D
          data={surface}
          points={points}
          xLabel="ln(K/F) / √T"
          xTick={xTickK}
          xTicks={xTicksK}
          xReadout={xReadoutK}
          tauScale="sqrt"
          tauTicks={TAU_TICKS}
          label={summary}
          hint="dots: real quotes · stems: model error"
        />
        <p class="sr-only" aria-live="polite">
          {replaying ? '' : summary}
        </p>
      </div>

      <div class="area-side">
        <div class="panel panel-pad" style={{ display: 'grid', gap: '12px' }}>
          <div>
            <p class="eyebrow">model</p>
            <div style={{ marginTop: '6px' }}>
              <Segmented
                label="Model"
                value={model}
                onChange={(v) => setModel(v)}
                options={MODEL_IDS.map((id) => ({
                  value: id,
                  label: (
                    <>
                      <span class="dot" style={{ background: MODEL_COLORS[id] }} />
                      {MODELS[id].label}
                    </>
                  ),
                  title: `${MODELS[id].names.length} parameters`,
                }))}
              />
            </div>
          </div>
          <p class="panel-sub" style={{ margin: 0 }}>
            {MODEL_NOTES[model]}
          </p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" class="btn primary" onClick={calibrate} disabled={replaying}>
              {replaying ? 'Calibrating…' : frames.length ? 'Calibrate again' : 'Calibrate in browser'}
            </button>
            {model === 'heston' && frame && !replaying && (
              <button type="button" class="btn" onClick={() => props.onUseParams({ kappa: frame.params[0], theta: frame.params[1], sigma: frame.params[2], rho: frame.params[3], v0: frame.params[4] })}>
                Open in playground
              </button>
            )}
          </div>
          <div class="status-line" aria-live="polite">
            <span>
              {replaying && <span class="pulse" />}
              {replaying
                ? `Levenberg–Marquardt · iteration ${frame?.iteration ?? 0}`
                : done
                  ? `browser: ${done.iteration} it · ${done.nfev} fev · ${done.ms.toFixed(0)} ms`
                  : `showing offline scipy fit (${py.nfev} fev, ${num(py.seconds, 0)} s)`}
            </span>
          </div>
        </div>

        <LossChart frames={frames.slice(0, shown + 1)} total={frames.length} pyRmse={py.rmse} svi={spx.fits.svi.rmse} bs={setup.bsRmse} />

        <ParamPanel model={model} frames={frames.slice(0, shown + 1)} frame={frame} spx={spx} />
        <ErrorByExpiry spx={spx} selected={model} />
        <ResidualMap spx={spx} setup={setup} frame={frame} model={model} />
      </div>

      <div class="panel area-smiles">
        <div class="panel-head">
          <div>
            <p class="eyebrow">smile slices</p>
            <h3>Bid–ask quotes vs model, per expiry</h3>
          </div>
          <div class="legend">
            <span style={{ color: 'var(--ember)' }}>┃ bid–ask · ● mid</span>
            <span style={{ color: MODEL_COLORS[model] }}>
              <i class="swatch" />
              <span style={{ color: 'var(--muted)' }}>{spec.label}</span>
            </span>
            <span style={{ color: 'var(--muted)' }}>
              <i class="swatch dash" />
              SVI
            </span>
          </div>
        </div>
        <div class="smile-grid">
          {spx.slices.map((s, si) => (
            <MiniSmile key={s.expiry} si={si} spx={spx} setup={setup} frame={frame} color={MODEL_COLORS[model]} rmse={stats?.slice[si]} />
          ))}
        </div>
      </div>

      <CompareTable spx={spx} setup={setup} selected={model} browser={done && !replaying ? done : null} />
    </section>
  )
}

const MODEL_NOTES: Record<ModelId, string> = {
  heston: 'One variance factor: 5 parameters for the whole surface. Its skew decays with maturity at a single speed κ, so it cannot be steep at one week and still right at two years.',
  bates: 'Heston plus Merton lognormal jumps (λ, μⱼ, σⱼ): jumps add short-dated skew that a diffusion cannot. Warm-started from the Heston optimum.',
  double: 'Two independent Heston variance factors (10 parameters): a fast one for the short-dated skew and a slow one for the long end (Christoffersen, Heston & Jacobs 2009).',
}

function sliceStats(modelIv: ArrayLike<number>, slices: MarketSlice[]) {
  let o = 0
  let inside = 0
  let n = 0
  const slice = slices.map((s) => {
    let sq = 0
    s.k.forEach((_, i) => {
      const m = modelIv[o++]
      sq += (Number.isFinite(m) ? m - s.iv[i] : 0.1) ** 2
      if (m >= s.ivBid[i] && m <= s.ivAsk[i]) inside++
      n++
    })
    return Math.sqrt(sq / s.k.length)
  })
  return { slice, inside: inside / n }
}

function LossChart(p: { frames: Frame[]; total: number; pyRmse: number; svi: number; bs: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const H = 168
  const m = { top: 24, right: 12, bottom: 34, left: 46 }
  const n = Math.max(8, p.total - 1)
  const x = linear([0, n], [m.left, Math.max(m.left + 10, width - m.right)])
  const vals = [...p.frames.map((f) => f.rmse * 100), p.pyRmse * 100, p.svi * 100, p.bs * 100]
  const [lo, hi] = extent(vals)
  const yd: [number, number] = [10 ** Math.floor(Math.log10(lo * 0.8)), 10 ** Math.ceil(Math.log10(hi * 1.2))]
  const y = log(yd, [H - m.bottom, m.top])
  const yt = logTicks(yd[0], yd[1], 4)
  const xt = ticks(0, n, 4).filter((t) => Number.isInteger(t))
  const fmt = (v: number) => (v >= 0.01 ? `${v}` : sci(v, 0))
  const refs = [
    { v: p.bs * 100, label: 'BS term structure', color: 'var(--faint)', dash: '2 3', above: true },
    { v: p.pyRmse * 100, label: 'scipy optimum', color: 'var(--lime)', dash: '5 3', above: true },
    { v: p.svi * 100, label: 'SVI per expiry', color: 'var(--ember)', dash: '2 3', above: false },
  ]
  return (
    <div class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">convergence</p>
          <h3>RMSE, vol points (log)</h3>
        </div>
      </div>
      <div ref={ref} style={{ padding: '0 6px 4px' }}>
        {width > 0 && (
          <svg
            class="chart"
            width={width}
            height={H}
            role="img"
            aria-label={p.frames.length ? `RMSE fell from ${num(p.frames[0].rmse * 100, 2)} to ${num(p.frames[p.frames.length - 1].rmse * 100, 3)} vol points.` : 'No browser calibration run yet.'}
          >
            <GridY y={y} ticks={yt} x0={m.left} x1={width - m.right} />
            <AxisLeft y={y} ticks={yt} x={m.left} format={fmt} />
            <AxisBottom x={x} ticks={xt} y={H - m.bottom} format={(v) => `${v}`} title="iteration" />
            {refs.map((r) => (
              <g key={r.label}>
                <line x1={m.left} x2={width - m.right} y1={y(r.v)} y2={y(r.v)} stroke={r.color} stroke-dasharray={r.dash} />
                <text x={width - m.right - 2} y={y(r.v) + (r.above ? -5 : 13)} text-anchor="end" style={{ fill: r.color }}>
                  {r.label} {num(r.v, 2)}
                </text>
              </g>
            ))}
            {p.frames.length > 0 && (
              <>
                <path d={linePath(p.frames.map((f) => f.iteration), p.frames.map((f) => f.rmse * 100), x, y)} fill="none" stroke="var(--accent)" stroke-width="2" />
                {p.frames.map((f) => (
                  <circle key={f.iteration} cx={x(f.iteration)} cy={y(f.rmse * 100)} r="2.6" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.5" />
                ))}
              </>
            )}
            {!p.frames.length && (
              <text x={(m.left + width - m.right) / 2} y={y(Math.sqrt(p.bs * p.pyRmse) * 100) + 4} text-anchor="middle">
                press calibrate to fit in the browser
              </text>
            )}
          </svg>
        )}
      </div>
    </div>
  )
}

function ParamPanel(p: { model: ModelId; frames: Frame[]; frame: Frame | null; spx: SpxData }) {
  const spec = MODELS[p.model]
  const py = pyParams(p.spx, p.model)
  const cur = p.frame && p.frame.params.length === py.length ? p.frame.params : py
  const fellers = p.model === 'double' ? [0, 5] : [0]
  return (
    <div class="panel panel-pad">
      <p class="eyebrow" style={{ marginBottom: '8px' }}>
        parameters · {p.frames.length ? 'path from the start point' : 'offline optimum'}
      </p>
      <div class={`param-traj n${spec.names.length}`}>
        {spec.names.map((n, i) => (
          <ParamSpark key={n} label={spec.symbols[i]} decimals={decimalsOf(n)} values={p.frames.map((f) => f.params[i])} current={cur[i]} target={py[i]} bounds={spec.bounds[i]} />
        ))}
      </div>
      <p class="panel-sub" style={{ marginTop: '8px' }}>
        {fellers.map((o) => {
          const lhs = 2 * cur[o] * cur[o + 1]
          const rhs = cur[o + 2] ** 2
          return (
            <span key={o} style={{ display: 'block' }}>
              Feller{p.model === 'double' ? ` (factor ${o ? 2 : 1})` : ''}: 2κθ = {num(lhs, 3)} vs σ² = {num(rhs, 2)},{' '}
              <span class={lhs > rhs ? 'ok' : 'bad'}>{lhs > rhs ? 'satisfied' : 'violated'}</span>
            </span>
          )
        })}
        Dashed: the scipy optimum. Parameters that end on a bound are marked; fits to real short-dated smiles push vol of vol far past textbook values.
      </p>
    </div>
  )
}

function ParamSpark(p: { label: string; decimals: number; values: number[]; current: number; target: number; bounds: [number, number] }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const H = 40
  const [lo, hi] = extent([p.target, p.current, ...p.values])
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 0.01
  const n = Math.max(6, p.values.length - 1)
  const x = linear([0, n], [2, Math.max(4, width - 4)])
  const y = linear([lo - pad, hi + pad], [H - 3, 3])
  const span = p.bounds[1] - p.bounds[0]
  const atBound = Math.min(Math.abs(p.current - p.bounds[0]), Math.abs(p.current - p.bounds[1])) < 1e-4 * span
  return (
    <figure>
      <figcaption>
        <span>{p.label}</span>
        <b class={atBound ? 'bad' : ''} title={atBound ? 'at a bound of the calibration box' : undefined}>
          {fixed(p.current, p.decimals)}
          {atBound ? '*' : ''}
        </b>
      </figcaption>
      <div ref={ref}>
        {width > 0 && (
          <svg class="chart" width={width} height={H} aria-hidden="true">
            <rect x="0" y="0" width={width} height={H} rx="6" fill="var(--bg)" />
            <line x1={2} x2={width - 2} y1={y(p.target)} y2={y(p.target)} stroke="var(--lime)" stroke-opacity="0.6" stroke-dasharray="3 3" />
            {p.values.length > 0 && <path d={linePath(p.values.map((_, i) => i), p.values, x, y)} fill="none" stroke="var(--accent)" stroke-width="1.6" />}
            <circle cx={x(p.values.length ? p.values.length - 1 : n)} cy={y(p.current)} r="2.5" fill="var(--accent)" />
          </svg>
        )}
      </div>
    </figure>
  )
}

function MiniSmile(p: { si: number; spx: SpxData; setup: Setup; frame: Frame | null; color: string; rmse?: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const { spx, setup, frame, si } = p
  const s = spx.slices[si]
  const H = flags.embed ? 96 : 118
  const m = { top: 8, right: 6, bottom: 20, left: 32 }
  const ks = setup.view.smileKs[si]
  const mx = ks.map((k) => Math.exp(k))
  const qm = s.k.map((k) => Math.exp(k))
  const line = frame ? frame.smiles.subarray(si * SMILE_N, (si + 1) * SMILE_N) : null
  const svi = ks.map((k) => sviVol(k, s.tau, s.svi))
  const x = linear([mx[0], mx[mx.length - 1]], [m.left, Math.max(m.left + 10, width - m.right)])
  const yv = extent([...s.ivBid, ...s.ivAsk, ...(line ? Array.from(line) : [])])
  const yd = niceDomain(Math.max(0, yv[0]), yv[1], 3)
  const y = linear(yd, [H - m.bottom, m.top])
  const yt = ticks(yd[0], yd[1], 3)
  const xt0 = ticks(mx[0], mx[mx.length - 1], 3)
  const xt = xt0.length > 2 && (width - m.left - m.right) / (xt0.length - 1) < 38 ? xt0.filter((_, i) => i % 2 === 0) : xt0
  const clipId = `mclip-${si}`
  return (
    <figure>
      <figcaption>
        <span>
          {expiryLabel(s.expiry)} · {daysLabel(s.tau)}
        </span>
        <span title="RMSE of the model on this expiry">{p.rmse !== undefined ? `${num(p.rmse * 100, 2)} vp` : ''}</span>
      </figcaption>
      <div ref={ref}>
        {width > 0 && (
          <svg class="chart" width={width} height={H} role="img" aria-label={`${expiryLabel(s.expiry, true)} smile: mid vols from ${pct(Math.min(...s.iv))} to ${pct(Math.max(...s.iv))}.`}>
            <defs>
              <clipPath id={clipId}>
                <rect x={m.left} y={m.top - 4} width={Math.max(0, width - m.left - m.right)} height={H - m.top - m.bottom + 8} />
              </clipPath>
            </defs>
            <GridY y={y} ticks={yt} x0={m.left} x1={width - m.right} />
            <AxisLeft y={y} ticks={yt} x={m.left} format={pctTickFormat(yt, '')} />
            <AxisBottom x={x} ticks={xt} y={H - m.bottom} format={(v) => `${Math.round(v * 100)}`} />
            <g clip-path={`url(#${clipId})`}>
              <path d={linePath(mx, svi, x, y)} fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" />
              {line && <path d={linePath(mx, line, x, y)} fill="none" stroke={p.color} stroke-width="1.75" />}
            </g>
            {qm.map((v, i) => (
              <g key={i}>
                <line x1={x(v)} x2={x(v)} y1={y(s.ivBid[i])} y2={y(s.ivAsk[i])} stroke="var(--ember)" stroke-width="2" stroke-opacity="0.55" />
                <circle cx={x(v)} cy={y(s.iv[i])} r="1.9" fill="var(--ember)" />
              </g>
            ))}
          </svg>
        )}
      </div>
    </figure>
  )
}

/** Per-expiry RMSE of each model's offline fit against the bid-ask half-width. */
function ErrorByExpiry(p: { spx: SpxData; selected: ModelId }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const H = 200
  const m = { top: 14, right: 12, bottom: 38, left: 38 }
  const taus = p.spx.slices.map((s) => s.tau)
  const half = p.spx.slices.map((s) => median(s.ivAsk.map((a, i) => (a - s.ivBid[i]) / 2)))
  const series: { id: ModelId | 'svi'; label: string; v: number[] }[] = [
    ...MODEL_IDS.map((id) => ({ id, label: MODELS[id].label, v: p.spx.fits[id].sliceRmse })),
    { id: 'svi', label: 'SVI', v: p.spx.fits.svi.sliceRmse },
  ]
  const x = log([taus[0] * 0.85, taus[taus.length - 1] * 1.15], [m.left, Math.max(m.left + 10, width - m.right)])
  const ymax = Math.max(...series.flatMap((s) => s.v)) * 100
  const yd = niceDomain(0, ymax, 4)
  const y = linear(yd, [H - m.bottom, m.top])
  const yt = ticks(yd[0], yd[1], 4)
  const xt = [7 / 365, 1 / 12, 0.25, 0.5, 1, 2].filter((t) => t >= taus[0] * 0.85 && t <= taus[taus.length - 1] * 1.15)
  const tl = (t: number) => (t < 1 / 12 - 1e-6 ? '1w' : t < 1 ? `${Math.round(t * 12)}m` : `${t}y`)
  const band = `M${taus.map((t, i) => `${x(t).toFixed(1)},${y(half[i] * 100).toFixed(1)}`).join('L')}L${x(taus[taus.length - 1]).toFixed(1)},${y(0)}L${x(taus[0]).toFixed(1)},${y(0)}Z`
  return (
    <div class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">fit error by expiry</p>
          <h3>Where each model misses</h3>
        </div>
        <div class="legend">
          {series.map((s) => (
            <span key={s.id} style={{ color: MODEL_COLORS[s.id] }}>
              <i class={`swatch${s.id === 'svi' ? ' dash' : ''}`} />
              <span style={{ color: 'var(--muted)' }}>{s.label}</span>
            </span>
          ))}
          <span style={{ color: 'var(--muted)' }}>▒ half bid–ask</span>
        </div>
      </div>
      <div ref={ref} style={{ padding: '0 6px 6px' }}>
        {width > 0 && (
          <svg
            class="chart"
            width={width}
            height={H}
            role="img"
            aria-label={`RMSE by expiry. One-week expiry: ${series.map((s) => `${s.label} ${num(s.v[0] * 100, 2)}`).join(', ')} vol points. Longest expiry: ${series.map((s) => `${s.label} ${num(s.v[s.v.length - 1] * 100, 2)}`).join(', ')}.`}
          >
            <GridY y={y} ticks={yt} x0={m.left} x1={width - m.right} />
            <AxisLeft y={y} ticks={yt} x={m.left} format={(v) => `${v}`} title="vp" />
            <AxisBottom x={x} ticks={xt} y={H - m.bottom} format={tl} title="expiry (log scale)" />
            <path d={band} fill="rgba(206,207,210,0.08)" stroke="rgba(206,207,210,0.25)" stroke-width="1" />
            {series.map((s) => {
              const sel = s.id === p.selected
              return (
                <g key={s.id}>
                  <path
                    d={linePath(taus, s.v.map((v) => v * 100), x, y)}
                    fill="none"
                    stroke={MODEL_COLORS[s.id]}
                    stroke-width={sel ? 2.4 : 1.4}
                    stroke-opacity={sel || s.id === 'svi' ? 1 : 0.6}
                    stroke-dasharray={s.id === 'svi' ? '4 3' : undefined}
                  />
                  {sel && taus.map((t, i) => <circle key={t} cx={x(t)} cy={y(s.v[i] * 100)} r="2.6" fill={MODEL_COLORS[s.id]} />)}
                </g>
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}

/** Residuals in units of the half bid-ask spread: expiries x strikes (ordered by moneyness). */
function ResidualMap(p: { spx: SpxData; setup: Setup; frame: Frame | null; model: ModelId }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const slices = p.spx.slices
  const cols = Math.max(...slices.map((s) => s.k.length))
  const m = { top: 8, right: 10, bottom: 30, left: 62 }
  const cell = Math.max(8, Math.min(26, (width - m.left - m.right) / cols))
  const rowH = Math.max(12, Math.min(18, cell * 0.8))
  const H = m.top + rowH * slices.length + m.bottom
  const W = m.left + cell * cols
  const offsets = slices.map((_, i) => slices.slice(0, i).reduce((t, s) => t + s.k.length, 0))
  const rows = slices.map((s, si) =>
    s.k.map((_, i) => {
      const mv = p.frame ? p.frame.modelIv[offsets[si] + i] : Number.NaN
      const halfSpread = Math.max(1e-4, (s.ivAsk[i] - s.ivBid[i]) / 2)
      return { r: (mv - s.iv[i]) / halfSpread, d: mv - s.iv[i], K: s.strike[i], iv: s.iv[i] }
    }),
  )
  const color = (r: number) => {
    if (!Number.isFinite(r)) return 'var(--raised)'
    const a = Math.min(1, Math.abs(r) / 6)
    if (Math.abs(r) <= 1) return 'rgba(126,231,135,0.22)'
    return r > 0 ? `rgba(240,136,123,${0.2 + 0.8 * a})` : `rgba(83,177,253,${0.2 + 0.8 * a})`
  }
  return (
    <div class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">residual map · {MODELS[p.model].label}</p>
          <h3>Model − mid, in half-spreads</h3>
        </div>
        <div class="legend">
          <span style={{ color: '#53b1fd' }}>■ too low</span>
          <span style={{ color: 'var(--lime)' }}>■ inside bid–ask</span>
          <span style={{ color: 'var(--ember)' }}>■ too high</span>
        </div>
      </div>
      <div ref={ref} style={{ padding: '0 12px 10px', overflowX: 'auto' }}>
        {width > 0 && (
          <svg class="chart" width={Math.max(W + m.right, 10)} height={H} role="img" aria-label={`Residual heat map for ${MODELS[p.model].label}: rows are expiries, columns strikes from deep puts to calls.`}>
            {rows.map((row, ri) => (
              <g key={ri}>
                <text x={m.left - 6} y={m.top + ri * rowH + rowH / 2} text-anchor="end" dominant-baseline="middle">
                  {expiryLabel(slices[ri].expiry, slices[ri].tau > 0.9)}
                </text>
                {row.map((c, ci) => (
                  <rect key={ci} x={m.left + ci * cell + 0.5} y={m.top + ri * rowH + 0.5} width={cell - 1} height={rowH - 1} rx="2" fill={color(c.r)}>
                    <title>{`${slices[ri].expiry} K=${c.K}: mid ${pct(c.iv, 2)}, model ${c.d >= 0 ? '+' : '−'}${num(Math.abs(c.d) * 100, 2)} vp (${num(c.r, 1)} half-spreads)`}</title>
                  </rect>
                ))}
              </g>
            ))}
            <text x={m.left} y={H - 10} text-anchor="start">
              ← OTM puts
            </text>
            <text x={m.left + cell * cols * 0.62} y={H - 10} text-anchor="middle">
              ATM
            </text>
            <text x={W} y={H - 10} text-anchor="end">
              OTM calls →
            </text>
          </svg>
        )}
      </div>
    </div>
  )
}

function CompareTable(p: { spx: SpxData; setup: Setup; selected: ModelId; browser: MarketDoneMsg['result'] | null }) {
  const taus = p.spx.slices.map((s) => s.tau)
  const short = taus.map((t) => t <= 1 / 12 + 1e-9)
  const long = taus.map((t) => t >= 1)
  const pooled = (v: number[], mask: boolean[]) => {
    const sel = v.filter((_, i) => mask[i])
    return Math.sqrt(sel.reduce((s, x) => s + x * x, 0) / sel.length)
  }
  const sviCount = p.spx.slices.length * 5
  const rows = [
    ...MODEL_IDS.map((id) => ({ id, label: MODELS[id].label, n: MODELS[id].names.length, f: p.spx.fits[id] as FitStats })),
    { id: 'svi' as const, label: 'SVI, per expiry', n: sviCount, f: p.spx.fits.svi as FitStats },
  ]
  const short1 = rows.map((r) => pooled(r.f.sliceRmse, short))
  const { fits, bounds } = p.spx
  const lam = fits.bates.params.lam
  const lamAtBound = lam > bounds.bates[5][1] * 0.999
  const ratio = fits.heston.rmse / fits.double.rmse
  const jumpGain = 1 - fits.bates.rmse / fits.heston.rmse
  return (
    <div class="panel area-table">
      <div class="panel-head">
        <div>
          <p class="eyebrow">model comparison · same {p.setup.n} quotes</p>
          <h3>Fit quality and what it costs</h3>
        </div>
      </div>
      <div class="table-wrap" style={{ padding: '4px 12px 0' }}>
        <table class="data">
          <caption class="sr-only">Fit statistics of each model on the SPX snapshot</caption>
          <thead>
            <tr>
              <th scope="col">model</th>
              <th scope="col">params</th>
              <th scope="col">rmse, vp</th>
              <th scope="col">inside bid–ask</th>
              <th scope="col">worst, vp</th>
              <th scope="col">≤ 1 month</th>
              <th scope="col">≥ 1 year</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="lead">Black–Scholes, ATM vol per expiry</td>
              <td>{p.spx.slices.length}</td>
              <td>{num(p.setup.bsRmse * 100, 2)}</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
            </tr>
            {rows.map((r, i) => (
              <tr key={r.id} class={r.id === p.selected ? 'sel' : ''}>
                <td class="lead">
                  <span class="dot" style={{ background: MODEL_COLORS[r.id] }} /> {r.label}
                </td>
                <td>{r.n}</td>
                <td class={r.id === 'double' ? 'best' : ''}>{num(r.f.rmse * 100, 2)}</td>
                <td>{pct(r.f.inside, 0)}</td>
                <td>{num(r.f.maxAbs * 100, 2)}</td>
                <td>{num(short1[i] * 100, 2)}</td>
                <td>{num(pooled(r.f.sliceRmse, long) * 100, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="panel-sub" style={{ padding: '10px 16px 14px', margin: 0 }}>
        Offline scipy fits (trust-region least squares, best of 2–3 starts) of the same objective the browser minimises: squared mid-IV
        error, equally weighted. {p.browser ? `Your browser fit: ${num(p.browser.rmse * 100, 3)} vp in ${p.browser.ms.toFixed(0)} ms. ` : ''}On this
        snapshot a second variance factor cuts Heston's error {num(ratio, 1)}×, while Merton jumps cut it by {pct(jumpGain, 0)}
        {lamAtBound ? ` and the jump fit degenerates to frequent small jumps (λ = ${num(lam, 0)}/yr, at its bound; mean jump ${pct(fits.bates.params.mu_j, 1)})` : ''}. SVI fits
        each expiry separately with {sviCount} parameters and no dynamics, so it is a smoothing benchmark, not a model of the index;
        {fits.svi.calendarViolations ? ` its slices cross in ${fits.svi.calendarViolations} places on the checked grid (calendar arbitrage).` : ' its slices do not cross on the checked grid (no calendar arbitrage).'}
      </p>
    </div>
  )
}

function median(v: number[]) {
  const s = [...v].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
