import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { fixed, num, pct, pctTickFormat, sci, tenor } from '../lib/format'
import { flags, useReducedMotion, useSize } from '../lib/hooks'
import { REGIME_COLORS, type MarketData, type RegimeInfo } from '../lib/market'
import { extent, linear, log, logTicks, niceDomain, ticks } from '../lib/scale'
import { flatVolFit } from '../math/calibrate'
import { strikeAt, xOfStrike, type Grid, type Quotes } from '../math/surface'
import { INITIAL_GUESS, PARAM_NAMES, type HestonParams, type ParamName } from '../math/types'
import type { SurfaceData, SurfacePoint } from '../render/surface3d'
import { AxisBottom, AxisLeft, GridY, linePath } from '../ui/axes'
import { Segmented } from '../ui/Segmented'
import { Surface3D } from '../ui/Surface3D'
import { request, send } from '../worker/client'
import type { CalibDoneMsg, CalibIterMsg } from '../worker/protocol'

interface Frame {
  iteration: number
  loss: number
  rmse: number
  params: HestonParams
  nfev: number
  modelIv: Float64Array
  surface: SurfaceData
  smiles: Float64Array
}

const SYM: Record<ParamName, string> = { kappa: 'κ', theta: 'θ', sigma: 'σ', rho: 'ρ', v0: 'v₀' }
const DEC: Record<ParamName, number> = { kappa: 2, theta: 4, sigma: 3, rho: 3, v0: 4 }
const STEP_MS = 420
const SMILE_N = 41

const xTicksK = (lo: number, hi: number) => ticks(lo, hi, 4)
const xTickK = (x: number) => fixed(x, 1)
const xReadoutK = (x: number) => `ln(K/F)/√T = ${fixed(x, 3)}`

function buildSetup(r: RegimeInfo) {
  const q = r.quotes
  const quotes: Quotes = { spot: q.spot, rate: q.rate, div: 0, strike: q.strike, maturity: q.maturity, iv: q.iv }
  const xs = q.strike.map((k, i) => xOfStrike('k', k, q.maturity[i], quotes))
  const [xlo, xhi] = extent(xs)
  const pad = (xhi - xlo) * 0.04
  const taus = [...new Set(q.maturity)].sort((a, b) => a - b)
  const a = Math.sqrt(taus[0])
  const b = Math.sqrt(taus[taus.length - 1])
  const surfGrid: Grid = {
    kind: 'k',
    x: Array.from({ length: 29 }, (_, j) => xlo - pad + ((xhi - xlo + 2 * pad) * j) / 28),
    tau: Array.from({ length: 20 }, (_, i) => (a + ((b - a) * i) / 19) ** 2),
  }
  const smileGrid: Grid = {
    kind: 'k',
    x: Array.from({ length: SMILE_N }, (_, j) => xlo - pad + ((xhi - xlo + 2 * pad) * j) / (SMILE_N - 1)),
    tau: taus,
  }
  return { quotes, xs, surfGrid, smileGrid, taus, flat: flatVolFit(q.iv) }
}

export function Calibration(props: {
  market: MarketData | null
  error: boolean
  initialRegime: number | null
  active: boolean
  onUseParams: (p: HestonParams) => void
}) {
  const { market } = props
  const reduced = useReducedMotion()
  const latestRegime = market ? market.series.regime[market.series.regime.length - 1] : 1
  const [k, setK] = useState<number>(props.initialRegime ?? 1)
  const touched = useRef(props.initialRegime !== null)
  useEffect(() => {
    if (props.initialRegime !== null) setK(props.initialRegime)
  }, [props.initialRegime])
  useEffect(() => {
    if (market && !touched.current) setK(latestRegime)
  }, [market])

  const regime = market?.regimes[k]
  const setup = useMemo(() => (regime ? buildSetup(regime) : null), [regime])
  const [frames, setFrames] = useState<Frame[]>([])
  const [shown, setShown] = useState(0)
  const [done, setDone] = useState<CalibDoneMsg['result'] | null>(null)
  const [running, setRunning] = useState(false)
  const [start, setStart] = useState<Frame | null>(null)
  const handle = useRef<{ cancel: () => void } | null>(null)

  // The starting point: the model at the configured initial guess (configs/base.yaml).
  useEffect(() => {
    if (!setup) return
    handle.current?.cancel()
    setFrames([])
    setDone(null)
    setRunning(false)
    setShown(0)
    let live = true
    Promise.all([
      request({ type: 'surface', params: INITIAL_GUESS, market: setup.quotes, grid: setup.surfGrid, quality: 'fine' }, 'surface'),
      request({ type: 'surface', params: INITIAL_GUESS, market: setup.quotes, grid: setup.smileGrid, quality: 'fine' }, 'surface'),
    ]).then(([s, sm]) => {
      if (!live) return
      setStart({
        iteration: 0,
        loss: Number.NaN,
        rmse: Number.NaN,
        params: INITIAL_GUESS,
        nfev: 0,
        modelIv: new Float64Array(0),
        surface: { grid: setup.surfGrid, iv: s.iv, flag: s.flag },
        smiles: sm.iv,
      })
    })
    return () => {
      live = false
    }
  }, [setup])

  useEffect(() => () => handle.current?.cancel(), [])

  const calibrate = () => {
    if (!setup) return
    handle.current?.cancel()
    setFrames([])
    setDone(null)
    setShown(0)
    setRunning(true)
    const m = setup.quotes.iv.length
    const h = send({ type: 'calibrate', quotes: setup.quotes, grids: [setup.surfGrid, setup.smileGrid] }, (msg) => {
      if (msg.type === 'calib-iter') {
        const it = msg as CalibIterMsg
        setFrames((f) => [
          ...f,
          {
            iteration: it.iteration,
            loss: it.loss,
            rmse: Math.sqrt(it.loss / m),
            params: it.params,
            nfev: it.nfev,
            modelIv: it.modelIv,
            surface: { grid: setup.surfGrid, iv: it.surfaces[0], flag: it.flags[0] },
            smiles: it.surfaces[1],
          },
        ])
      } else if (msg.type === 'calib-done') {
        setDone(msg.result)
        h.dispose()
      }
    })
    handle.current = h
  }

  // Replay: step through streamed iterations at a readable pace (instant if reduced motion).
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

  const frame: Frame | null = frames[shown] ?? start
  const replaying = running || (frames.length > 0 && shown < frames.length - 1)

  const points: SurfacePoint[] = useMemo(() => {
    if (!setup) return []
    return setup.quotes.iv.map((iv, i) => ({
      x: setup.xs[i],
      tau: setup.quotes.maturity[i],
      iv,
      model: frame && frame.modelIv.length ? frame.modelIv[i] : undefined,
    }))
  }, [setup, frame])

  if (!market) {
    return <div class="panel loading">{props.error ? 'Could not load the baked market data.' : 'Loading regime surfaces…'}</div>
  }
  const colors = REGIME_COLORS[3]
  const py = regime!.python
  const final = done
  const summary = frame
    ? `Synthetic ${regime!.name}-regime option surface with ${setup!.quotes.iv.length} quotes. ${frame.iteration === 0 && !frames.length ? 'Model shown at the initial guess.' : `Iteration ${frame.iteration}: RMSE ${num(frame.rmse * 100, 3)} vol points.`}`
    : 'Loading.'

  return (
    <section class="view v-calib" aria-labelledby="cal-title">
      <div class="panel area-surface">
        <div class="panel-head">
          <div>
            <p class="eyebrow">02 / calibration</p>
            <h2 id="cal-title">Fit Heston to a {regime!.name}-regime surface</h2>
            <p class="panel-sub">
              <span style={{ color: 'var(--ember)' }}>●</span> {setup!.quotes.iv.length} synthetic quotes from the regime's parameters + N(0, {num(regime!.quotes.noiseIv * 100, 2)} vp) noise ·{' '}
              <span style={{ color: 'var(--accent)' }}>■</span> model
            </p>
          </div>
          <div class="readouts">
            <div class="readout">
              <span class="eyebrow">iteration</span>
              <b>{frame ? frame.iteration : '—'}</b>
            </div>
            <div class="readout">
              <span class="eyebrow">rmse</span>
              <b>{frame && Number.isFinite(frame.rmse) ? `${num(frame.rmse * 100, 3)} vp` : '—'}</b>
            </div>
            <div class="readout">
              <span class="eyebrow">feval</span>
              <b>{frame ? frame.nfev : '—'}</b>
            </div>
          </div>
        </div>
        <Surface3D
          data={frame?.surface ?? null}
          points={points}
          xLabel="ln(K/F) / √T"
          xTick={xTickK}
          xTicks={xTicksK}
          xReadout={xReadoutK}
          label={summary}
          hint="dots: market quotes · stems: residuals"
        />
        <p class="sr-only" aria-live="polite">
          {replaying ? '' : summary}
        </p>
      </div>

      <div class="area-side">
        <div class="panel panel-pad" style={{ display: 'grid', gap: '12px' }}>
          <div>
            <p class="eyebrow">regime</p>
            <div style={{ marginTop: '6px' }}>
              <Segmented
                label="Regime surface"
                value={k}
                onChange={(v) => {
                  touched.current = true
                  setK(v)
                }}
                options={market.regimes.map((r, i) => ({
                  value: i,
                  label: (
                    <>
                      <span class="dot" style={{ background: colors[i] }} />
                      {r.name}
                      {i === latestRegime && <span class="sr-only"> (current regime)</span>}
                    </>
                  ),
                  title: `mean VIX ${num(r.stats.vixMean, 1)}`,
                }))}
              />
            </div>
          </div>
          <p class="panel-sub" style={{ margin: 0 }}>
            Typical of {pct(regime!.share, 0)} of days since {market.start.slice(0, 4)}: mean VIX {num(regime!.stats.vixMean, 1)}.{' '}
            {k === latestRegime ? 'This is the regime the HMM assigns to the latest day.' : ''}
          </p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" class="btn primary" onClick={calibrate} disabled={!setup || replaying}>
              {replaying ? 'Calibrating…' : frames.length ? 'Calibrate again' : 'Calibrate'}
            </button>
            {final && !replaying && (
              <button type="button" class="btn" onClick={() => props.onUseParams(final.params)}>
                Open fit in playground
              </button>
            )}
          </div>
          <div class="status-line" aria-live="polite">
            <span>
              {replaying && <span class="pulse" />}
              {replaying
                ? `Levenberg–Marquardt · iteration ${frame?.iteration ?? 0}`
                : final
                  ? `converged: ${final.iteration} it · ${final.nfev} fev · ${final.ms.toFixed(0)} ms compute`
                  : 'start: initial guess from configs/base.yaml'}
            </span>
          </div>
        </div>

        <LossChart frames={frames.slice(0, shown + 1)} total={frames.length} pyRmse={py.rmseIv} flat={setup!.flat.rmseIv} />

        <div class="panel panel-pad">
          <p class="eyebrow" style={{ marginBottom: '8px' }}>
            parameter paths · dashed: generating value
          </p>
          <div class="param-traj">
            {PARAM_NAMES.map((n) => (
              <ParamSpark key={n} name={n} frames={frames.slice(0, shown + 1)} truth={regime!.params[n]} start={INITIAL_GUESS[n]} py={py.params[n]} />
            ))}
          </div>
        </div>

        <FitTable regime={regime!} final={replaying ? null : final} flat={setup!.flat} n={setup!.quotes.iv.length} />
      </div>

      <div class="panel area-smiles">
        <div class="panel-head">
          <div>
            <p class="eyebrow">smile slices</p>
            <h3>Quotes vs model, per maturity</h3>
          </div>
          <div class="legend">
            <span style={{ color: 'var(--ember)' }}>● market (synthetic)</span>
            <span style={{ color: 'var(--accent)' }}>
              <i class="swatch" />
              <span style={{ color: 'var(--muted)' }}>Heston</span>
            </span>
            <span style={{ color: 'var(--muted)' }}>
              <i class="swatch dash" />
              flat BS
            </span>
          </div>
        </div>
        <div class="smile-grid">
          {setup!.taus.map((tau, ti) => (
            <MiniSmile key={tau} tau={tau} ti={ti} setup={setup!} frame={frame} />
          ))}
        </div>
      </div>
    </section>
  )
}

function LossChart(p: { frames: Frame[]; total: number; pyRmse: number; flat: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const H = 168
  const m = { top: 24, right: 12, bottom: 34, left: 46 }
  const n = Math.max(8, p.total - 1)
  const x = linear([0, n], [m.left, Math.max(m.left + 10, width - m.right)])
  const vals = [...p.frames.map((f) => f.rmse * 100), p.pyRmse * 100, p.flat * 100]
  const [lo, hi] = extent(vals)
  const yd: [number, number] = [10 ** Math.floor(Math.log10(lo * 0.8)), 10 ** Math.ceil(Math.log10(hi * 1.2))]
  const y = log(yd, [H - m.bottom, m.top])
  const yt = logTicks(yd[0], yd[1], 4)
  const xt = ticks(0, n, 4).filter((t) => Number.isInteger(t))
  const fmt = (v: number) => (v >= 1 ? `${v}` : v >= 0.01 ? `${v}` : sci(v, 0))
  const refs = [
    { v: p.flat * 100, label: 'flat BS', color: 'var(--muted)', dash: '2 3' },
    { v: p.pyRmse * 100, label: 'python optimum', color: 'var(--lime)', dash: '5 3' },
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
          <svg class="chart" width={width} height={H} role="img" aria-label={p.frames.length ? `RMSE fell from ${num(p.frames[0].rmse * 100, 2)} to ${num(p.frames[p.frames.length - 1].rmse * 100, 3)} vol points.` : 'No calibration run yet.'}>
            <GridY y={y} ticks={yt} x0={m.left} x1={width - m.right} />
            <AxisLeft y={y} ticks={yt} x={m.left} format={fmt} />
            <AxisBottom x={x} ticks={xt} y={H - m.bottom} format={(v) => `${v}`} title="iteration" />
            {refs.map((r) => (
              <g key={r.label}>
                <line x1={m.left} x2={width - m.right} y1={y(r.v)} y2={y(r.v)} stroke={r.color} stroke-dasharray={r.dash} />
                <text x={width - m.right - 2} y={y(r.v) + (r.label === 'flat BS' ? -5 : 13)} text-anchor="end" style={{ fill: r.color }}>
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
              <text x={(m.left + width - m.right) / 2} y={H / 2 - 6} text-anchor="middle">
                press calibrate
              </text>
            )}
          </svg>
        )}
      </div>
    </div>
  )
}

function ParamSpark(p: { name: ParamName; frames: Frame[]; truth: number; start: number; py: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const H = 46
  const vals = [p.truth, p.start, ...p.frames.map((f) => f.params[p.name])]
  const [lo, hi] = extent(vals)
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 0.01
  const n = Math.max(6, p.frames.length - 1)
  const x = linear([0, n], [2, Math.max(4, width - 4)])
  const y = linear([lo - pad, hi + pad], [H - 3, 3])
  const cur = p.frames.length ? p.frames[p.frames.length - 1].params[p.name] : p.start
  return (
    <figure>
      <figcaption>
        <span>{SYM[p.name]}</span>
        <b>{fixed(cur, DEC[p.name])}</b>
      </figcaption>
      <div ref={ref}>
        {width > 0 && (
          <svg class="chart" width={width} height={H} aria-hidden="true">
            <rect x="0" y="0" width={width} height={H} rx="6" fill="var(--bg)" />
            <line x1={2} x2={width - 2} y1={y(p.truth)} y2={y(p.truth)} stroke="var(--muted)" stroke-dasharray="3 3" />
            {p.frames.length > 0 && (
              <path d={linePath(p.frames.map((f) => f.iteration), p.frames.map((f) => f.params[p.name]), x, y)} fill="none" stroke="var(--accent)" stroke-width="1.6" />
            )}
            <circle cx={x(p.frames.length ? p.frames[p.frames.length - 1].iteration : 0)} cy={y(cur)} r="2.5" fill="var(--accent)" />
          </svg>
        )}
      </div>
    </figure>
  )
}

function FitTable(p: { regime: RegimeInfo; final: CalibDoneMsg['result'] | null; flat: { sigma: number; rmseIv: number }; n: number }) {
  const py = p.regime.python
  const f = p.final
  return (
    <div class="panel panel-pad">
      <p class="eyebrow" style={{ marginBottom: '6px' }}>
        fit · browser vs python, same {p.n} quotes
      </p>
      <div class="table-wrap">
        <table class="data">
          <caption class="sr-only">Calibrated parameters and fit quality: generating values, browser Levenberg–Marquardt, Python L-BFGS-B</caption>
          <thead>
            <tr>
              <th scope="col">param</th>
              <th scope="col">generating</th>
              <th scope="col">browser</th>
              <th scope="col">python</th>
            </tr>
          </thead>
          <tbody>
            {PARAM_NAMES.map((n) => (
              <tr key={n}>
                <td class="lead">{SYM[n]}</td>
                <td>{fixed(p.regime.params[n], DEC[n])}</td>
                <td>{f ? fixed(f.params[n], DEC[n]) : '—'}</td>
                <td>{fixed(py.params[n], DEC[n])}</td>
              </tr>
            ))}
            <tr>
              <td class="lead">rmse, vp</td>
              <td>—</td>
              <td class={f && f.rmseIv <= py.rmseIv + 1e-7 ? 'best' : ''}>{f ? num(f.rmseIv * 100, 4) : '—'}</td>
              <td>{num(py.rmseIv * 100, 4)}</td>
            </tr>
            <tr>
              <td class="lead">evals · time</td>
              <td>—</td>
              <td>{f ? `${f.nfev} · ${f.ms.toFixed(0)} ms` : '—'}</td>
              <td>
                {py.nfev} · {num(py.seconds, 1)} s
              </td>
            </tr>
            <tr>
              <td class="lead">flat BS</td>
              <td colSpan={3} class="wrap">
                One vol for every quote, σ̂ = {pct(p.flat.sigma, 2)}: rmse {num(p.flat.rmseIv * 100, 3)} vp
                {f ? `, ${num(p.flat.rmseIv / f.rmseIv, 1)}× the Heston error.` : '.'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="panel-sub" style={{ marginTop: '8px' }}>
        Python: scipy L-BFGS-B on the identical quotes, run offline when the data was baked. Browser: bounded Levenberg–Marquardt on the same
        objective and box, replayed here at {STEP_MS} ms per iteration. Quote noise is {num(p.regime.quotes.noiseIv * 100, 2)} vp, so no model
        can fit much below that.
      </p>
    </div>
  )
}

function MiniSmile(p: { tau: number; ti: number; setup: ReturnType<typeof buildSetup>; frame: Frame | null }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const { setup, tau, ti, frame } = p
  const H = flags.embed ? 92 : 112
  const m = { top: 8, right: 6, bottom: 20, left: 30 }
  const idx = setup.quotes.maturity.flatMap((t, i) => (t === tau ? [i] : []))
  const toM = (x: number) => strikeAt({ kind: 'k' }, x, tau, setup.quotes) / setup.quotes.spot
  const mx = setup.smileGrid.x.map(toM)
  const qm = idx.map((i) => setup.quotes.strike[i] / setup.quotes.spot)
  const qv = idx.map((i) => setup.quotes.iv[i])
  const line = frame ? frame.smiles.subarray(ti * SMILE_N, (ti + 1) * SMILE_N) : null
  const xd = extent(qm)
  const padX = (xd[1] - xd[0]) * 0.08
  const x = linear([xd[0] - padX, xd[1] + padX], [m.left, Math.max(m.left + 10, width - m.right)])
  const inRange = (v: number) => v >= xd[0] - padX && v <= xd[1] + padX
  const lineVals = line ? Array.from(line).filter((_, j) => inRange(mx[j])) : []
  const yv = extent([...qv, ...lineVals, setup.flat.sigma])
  const yd = niceDomain(yv[0], yv[1], 3)
  const y = linear(yd, [H - m.bottom, m.top])
  const yt = ticks(yd[0], yd[1], 3)
  const xt0 = ticks(xd[0], xd[1], 3)
  // Keep tick labels at least ~38px apart.
  const xt = xt0.length > 2 && (width - m.left - m.right) / (xt0.length - 1) < 38 ? xt0.filter((_, i) => i % 2 === 0) : xt0
  const clipId = `clip-${ti}`
  return (
    <figure>
      <figcaption>
        <span>{tenor(tau)}</span>
        <span>{idx.length} quotes</span>
      </figcaption>
      <div ref={ref}>
        {width > 0 && (
          <svg class="chart" width={width} height={H} role="img" aria-label={`${tenor(tau)} smile: quotes from ${pct(Math.min(...qv))} to ${pct(Math.max(...qv))}.`}>
            <defs>
              <clipPath id={clipId}>
                <rect x={m.left} y={m.top - 4} width={Math.max(0, width - m.left - m.right)} height={H - m.top - m.bottom + 8} />
              </clipPath>
            </defs>
            <GridY y={y} ticks={yt} x0={m.left} x1={width - m.right} />
            <AxisLeft y={y} ticks={yt} x={m.left} format={pctTickFormat(yt, '')} />
            <AxisBottom x={x} ticks={xt} y={H - m.bottom} format={(v) => `${Math.round(v * 100)}%`} />
            <g clip-path={`url(#${clipId})`}>
              <line x1={m.left} x2={width - m.right} y1={y(setup.flat.sigma)} y2={y(setup.flat.sigma)} stroke="var(--muted)" stroke-dasharray="4 3" />
              {line && <path d={linePath(mx, line, x, y)} fill="none" stroke="var(--accent)" stroke-width="1.75" />}
            </g>
            {qm.map((v, i) => (
              <circle key={i} cx={x(v)} cy={y(qv[i])} r="2.8" fill="var(--ember)" stroke="var(--panel)" stroke-width="1" />
            ))}
          </svg>
        )}
      </div>
    </figure>
  )
}
