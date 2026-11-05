import { useEffect, useMemo, useState } from 'preact/hooks'
import { dateLabel, fixed, num, pct } from '../lib/format'
import { useSize } from '../lib/hooks'
import { REGIME_COLORS, REGIME_NAMES, type MarketData } from '../lib/market'
import { extent, linear, log, niceDomain, ticks, type Scale } from '../lib/scale'
import { PARAM_NAMES, type HestonParams } from '../math/types'
import { GridY, linePath } from '../ui/axes'
import { Segmented } from '../ui/Segmented'
import { request } from '../worker/client'

type Range = '1y' | '3y' | '5y' | 'all'
const RANGE_DAYS: Record<Range, number> = { '1y': 365, '3y': 3 * 365, '5y': 5 * 365, all: Infinity }

interface Model {
  K: number
  states: ArrayLike<number>
  post: ArrayLike<number>[] // K arrays, 0..1
  transmat: number[][]
  logLik: number
  source: 'baked' | 'browser'
  ms?: number
}

interface Stats {
  share: number
  days: number
  vixMean: number
  realizedVol: number
  annReturn: number
  spells: number
  meanSpell: number
  expectedDuration: number
}

function regimeStats(d: MarketData, model: Model): Stats[] {
  const { spx, vix } = d.series
  const out: Stats[] = []
  for (let k = 0; k < model.K; k++) {
    let n = 0
    let vs = 0
    const rets: number[] = []
    let spells = 0
    let run = 0
    let runs = 0
    for (let t = 0; t < spx.length; t++) {
      const inK = model.states[t] === k
      if (inK) {
        n++
        vs += vix[t]
        if (t > 0) rets.push(Math.log(spx[t] / spx[t - 1]))
        run++
      } else if (run) {
        spells++
        runs += run
        run = 0
      }
    }
    if (run) {
      spells++
      runs += run
    }
    const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length)
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1))
    out.push({
      share: n / spx.length,
      days: n,
      vixMean: vs / Math.max(1, n),
      realizedVol: sd * Math.sqrt(252),
      annReturn: mean * 252,
      spells,
      meanSpell: runs / Math.max(1, spells),
      expectedDuration: 1 / Math.max(1e-9, 1 - model.transmat[k][k]),
    })
  }
  return out
}

export function Regimes(props: {
  market: MarketData | null
  error: boolean
  active: boolean
  onPlayground: (p: HestonParams) => void
  onCalibrate: (k: number) => void
}) {
  const d = props.market
  const [range, setRange] = useState<Range>('all')
  const [K, setK] = useState(3)
  const [browserFits, setBrowserFits] = useState<Record<number, Model>>({})
  const [fitting, setFitting] = useState(false)

  const baked: Model | null = useMemo(
    () =>
      d && {
        K: d.hmm.K,
        states: d.series.regime,
        post: d.series.post.map((p) => p.map((v) => v / 1000)),
        transmat: d.hmm.transmat,
        logLik: d.hmm.logLik,
        source: 'baked',
      },
    [d],
  )

  useEffect(() => {
    if (!d || K === 3 || browserFits[K]) return
    setFitting(true)
    request({ type: 'hmm', z: d.features.z, K }, 'hmm').then((r) => {
      setBrowserFits((f) => ({
        ...f,
        [K]: { K, states: r.fit.states, post: r.fit.posteriors, transmat: r.fit.transmat, logLik: r.fit.logLik, source: 'browser', ms: r.ms },
      }))
      setFitting(false)
    })
  }, [K, d])

  const model = K === 3 ? baked : (browserFits[K] ?? null)
  const stats = useMemo(() => (d && model ? regimeStats(d, model) : null), [d, model])

  if (!d || !baked) {
    return <div class="panel loading">{props.error ? 'Could not load the baked market data.' : 'Loading market history…'}</div>
  }
  const shown = model ?? baked
  const colors = REGIME_COLORS[shown.K]
  const names = REGIME_NAMES[shown.K]
  const T = d.times.length
  const last = T - 1
  const curK = shown.states[last]
  const lastDate = new Date(d.times[last])

  return (
    <section class="view v-regimes" aria-labelledby="reg-title">
      <div class="panel area-history">
        <div class="history-toolbar">
          <div>
            <p class="eyebrow">03 / regimes</p>
            <h2 id="reg-title" style={{ margin: '3px 0 0', fontSize: '15px', fontWeight: 600 }}>
              S&amp;P 500 and VIX, shaded by HMM regime
            </h2>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Segmented label="History range" value={range} onChange={setRange} options={(['1y', '3y', '5y', 'all'] as Range[]).map((r) => ({ value: r, label: r }))} />
            <Segmented
              label="Number of HMM states"
              value={K}
              onChange={setK}
              options={[2, 3, 4].map((k) => ({ value: k, label: `K=${k}`, title: k === 3 ? 'hmmlearn, fitted offline' : 'Baum–Welch in your browser' }))}
            />
          </div>
        </div>
        <History d={d} model={shown} range={range} colors={colors} names={names} fitting={fitting && !model} />
      </div>

      <div class="area-side">
        <div class="panel panel-pad regime-card">
          <p class="eyebrow">latest regime · {dateLabel(lastDate)}</p>
          <div class="regime-now">
            <span class="dot" style={{ background: colors[curK], width: '10px', height: '10px' }} />
            {names[curK]}
            <span class="mono" style={{ fontSize: '13px', color: 'var(--muted)', fontWeight: 400 }}>
              VIX {num(d.series.vix[last], 2)}
            </span>
          </div>
          <div class="prob-bars" role="list" aria-label="Posterior regime probabilities for the latest day">
            {names.map((nm, k) => (
              <div class="prob-bar" role="listitem" key={nm}>
                <span>{nm}</span>
                <span class="track">
                  <span style={{ width: `${shown.post[k][last] * 100}%`, background: colors[k] }} />
                </span>
                <span class="num">{pct(shown.post[k][last], 0)}</span>
              </div>
            ))}
          </div>
          <p class="panel-sub" style={{ margin: 0 }}>
            Smoothed posterior P(regime | all data). The shaded history uses the Viterbi path.
          </p>
        </div>

        <div class="panel panel-pad">
          <p class="eyebrow" style={{ marginBottom: '6px' }}>
            transition probabilities · daily
          </p>
          <div class="table-wrap">
            <table class="data">
              <caption class="sr-only">Daily regime transition matrix: rows are today's regime, columns tomorrow's</caption>
              <thead>
                <tr>
                  <th scope="col">from \ to</th>
                  {names.map((n) => (
                    <th scope="col" key={n}>
                      {n}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.transmat.map((row, i) => (
                  <tr key={i}>
                    <td class="lead">
                      <span class="dot" style={{ background: colors[i], marginRight: '6px' }} />
                      {names[i]}
                    </td>
                    {row.map((v, j) => (
                      <td key={j} style={i === j ? { color: 'var(--text)' } : {}}>
                        {v.toFixed(3)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="panel-sub" style={{ marginTop: '8px' }}>
            {shown.source === 'baked'
              ? `hmmlearn GaussianHMM, full covariance, fitted offline (models/hmm.py) · log L = ${num(shown.logLik, 1)}`
              : `Baum–Welch refit in your browser in ${num((shown.ms ?? 0) / 1000, 2)} s · 8 seeded restarts · log L = ${num(shown.logLik, 1)}`}
          </p>
          <p class="panel-sub" style={{ marginTop: '4px' }}>
            Features (z-scored): {d.features.cols.join(', ')}.
          </p>
        </div>
      </div>

      <div class="area-tables">
        <div class="panel panel-pad">
          <p class="eyebrow" style={{ marginBottom: '6px' }}>
            per-regime statistics · {d.start.slice(0, 4)}–{d.asOf.slice(0, 4)}
          </p>
          <div class="table-wrap">
            <table class="data">
              <caption class="sr-only">Statistics of each regime</caption>
              <thead>
                <tr>
                  <th scope="col">regime</th>
                  <th scope="col">share</th>
                  <th scope="col">mean vix</th>
                  <th scope="col">realized vol</th>
                  <th scope="col">ann. return</th>
                  <th scope="col">spells</th>
                  <th scope="col">mean spell</th>
                  <th scope="col">exp. duration</th>
                </tr>
              </thead>
              <tbody>
                {stats?.map((s, k) => (
                  <tr key={k}>
                    <td class="lead">
                      <span class="dot" style={{ background: colors[k], marginRight: '6px' }} />
                      {names[k]}
                    </td>
                    <td>{pct(s.share, 1)}</td>
                    <td>{num(s.vixMean, 1)}</td>
                    <td>{pct(s.realizedVol, 1)}</td>
                    <td>{pct(s.annReturn, 1)}</td>
                    <td>{s.spells}</td>
                    <td>{num(s.meanSpell, 0)} d</td>
                    <td>{num(s.expectedDuration, 0)} d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="panel-sub" style={{ marginTop: '8px' }}>
            Realized vol and return: annualised from daily SPX log returns on days in the regime. Expected duration: <span style={{ whiteSpace: 'nowrap' }}>1 / (1 − p<sub>kk</sub>)</span>.
          </p>
        </div>

        <div class="panel panel-pad">
          <p class="eyebrow" style={{ marginBottom: '6px' }}>
            regime-conditional heston parameters · 3-state model
          </p>
          <div class="table-wrap">
            <table class="data">
              <caption class="sr-only">Heston parameters estimated for each regime</caption>
              <thead>
                <tr>
                  <th scope="col">regime</th>
                  {PARAM_NAMES.map((n) => (
                    <th scope="col" key={n}>
                      {{ kappa: 'κ', theta: 'θ', sigma: 'σ', rho: 'ρ', v0: 'v₀' }[n]}
                    </th>
                  ))}
                  <th scope="col">
                    <span class="sr-only">actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.regimes.map((r, k) => (
                  <tr key={r.key}>
                    <td class="lead">
                      <span class="dot" style={{ background: REGIME_COLORS[3][k], marginRight: '6px' }} />
                      {r.name}
                    </td>
                    <td>{num(r.params.kappa, 2)}</td>
                    <td>{num(r.params.theta, 4)}</td>
                    <td>{num(r.params.sigma, 3)}</td>
                    <td>{fixed(r.params.rho, 3)}</td>
                    <td>{num(r.params.v0, 4)}</td>
                    <td style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
                      <button type="button" class="btn small" onClick={() => props.onPlayground(r.params)} aria-label={`Open ${r.name} parameters in the surface playground`}>
                        surface
                      </button>
                      <button type="button" class="btn small" onClick={() => props.onCalibrate(k)} aria-label={`Calibrate to a synthetic ${r.name}-regime surface`}>
                        calibrate
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="panel-sub" style={{ marginTop: '8px' }}>
            Estimated offline from real VIX and VIX3M on each regime's days: κ = {num(d.estimation.kappa, 2)} from the pooled term-structure slope (shared), θ and v₀
            from the two tenors, σ from daily variance changes, ρ from their correlation with SPX returns. A proxy, not a calibration to option quotes.
          </p>
        </div>
      </div>
    </section>
  )
}

function History(p: { d: MarketData; model: Model; range: Range; colors: string[]; names: string[]; fitting: boolean }) {
  const { d, model, colors, names } = p
  const [ref, { width }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const T = d.times.length
  const tEnd = d.times[T - 1]
  const startIdx = useMemo(() => {
    const days = RANGE_DAYS[p.range]
    if (!Number.isFinite(days)) return 0
    const t0 = tEnd - days * 86400000
    let i = 0
    while (i < T && d.times[i] < t0) i++
    return i
  }, [p.range, d])
  const idx0 = startIdx
  const idx1 = T - 1
  const m = { top: 22, right: 54, bottom: 26, left: 12 }
  const H1 = width < 600 ? 170 : 230
  const H2 = width < 600 ? 100 : 128
  const H3 = 34
  const gap = 16
  const total = m.top + H1 + gap + H2 + gap + H3 + m.bottom
  const x = linear([d.times[idx0], tEnd], [m.left, Math.max(m.left + 10, width - m.right)])
  const sl = (a: number[]) => a.slice(idx0, idx1 + 1)
  const times = sl(d.times)
  const spx = sl(d.series.spx)
  const vix = sl(d.series.vix)
  const [slo, shi] = extent(spx)
  const ySpx = log([slo * 0.97, shi * 1.03], [m.top + H1, m.top])
  const spxTicks = logTicksSpx(slo * 0.97, shi * 1.03)
  const vd = niceDomain(0, Math.max(...vix) * 1.05, 4)
  const top2 = m.top + H1 + gap
  const yVix = linear([0, vd[1]], [top2 + H2, top2])
  const vixTicks = ticks(0, vd[1], 3)
  const top3 = top2 + H2 + gap
  const runs = useMemo(() => {
    const out: { k: number; a: number; b: number }[] = []
    let a = idx0
    for (let t = idx0 + 1; t <= idx1 + 1; t++) {
      if (t > idx1 || model.states[t] !== model.states[a]) {
        out.push({ k: model.states[a], a, b: Math.min(t, idx1) })
        a = t
      }
    }
    return out
  }, [model, idx0, idx1])
  const years = yearTicks(d.times[idx0], tEnd, width)
  const postPaths = useMemo(() => {
    const step = Math.max(1, Math.floor(times.length / Math.max(200, width)))
    const cum = new Float64Array(times.length)
    const out: string[] = []
    for (let k = 0; k < model.K; k++) {
      let top = ''
      let bot = ''
      for (let i = 0; i < times.length; i += step) {
        const lo = cum[i]
        const hi = lo + model.post[k][idx0 + i]
        const xx = x(times[i]).toFixed(1)
        top += `${top ? 'L' : 'M'}${xx},${(top3 + H3 * (1 - hi)).toFixed(1)}`
        bot = `L${xx},${(top3 + H3 * (1 - lo)).toFixed(1)}` + bot
      }
      for (let i = 0; i < times.length; i++) cum[i] += model.post[k][idx0 + i]
      out.push(`${top}${bot}Z`)
    }
    return out
  }, [model, idx0, width])

  const onMove = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const tx = x.invert(e.clientX - r.left)
    let lo = idx0
    let hi = idx1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (d.times[mid] < tx) lo = mid
      else hi = mid
    }
    setHover(Math.abs(d.times[lo] - tx) < Math.abs(d.times[hi] - tx) ? lo : hi)
  }
  const h = hover ?? idx1
  const hx = x(d.times[h])
  return (
    <div>
      <div class="history-readout" aria-live="off">
        <span>
          <b>{dateLabel(new Date(d.times[h]))}</b>
        </span>
        <span>
          SPX <b>{num(d.series.spx[h], 2)}</b>
        </span>
        <span>
          VIX <b>{num(d.series.vix[h], 2)}</b>
        </span>
        <span>
          VIX3M <b>{num(d.series.vix3m[h], 2)}</b>
        </span>
        <span>
          3m rate <b>{num(d.series.rate[h], 2)}%</b>
        </span>
        <span>
          <span class="dot" style={{ background: colors[model.states[h]], marginRight: '6px' }} />
          <b>{names[model.states[h]]}</b> · p = {num(model.post[model.states[h]][h], 2)}
        </span>
      </div>
      <div ref={ref} style={{ padding: '0 6px 10px', position: 'relative' }}>
        {p.fitting && (
          <div class="loading" style={{ position: 'absolute', inset: 0, minHeight: 0, background: 'rgba(12,14,18,.6)', zIndex: 2 }}>
            <span>
              <span class="pulse" />
              running Baum–Welch in a worker…
            </span>
          </div>
        )}
        {width > 0 && (
          <svg
            class="chart"
            width={width}
            height={total}
            role="img"
            aria-label={`S&P 500 from ${num(spx[0], 0)} to ${num(spx[spx.length - 1], 0)} and VIX between ${num(Math.min(...vix), 1)} and ${num(Math.max(...vix), 1)} over the selected range, shaded by regime. Latest regime: ${names[model.states[idx1]]}.`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            style={{ touchAction: 'pan-y' }}
          >
            {runs.map((r, i) => (
              <g key={i}>
                <rect x={x(d.times[r.a])} width={Math.max(0.5, x(d.times[r.b]) - x(d.times[r.a]))} y={m.top} height={H1} fill={colors[r.k]} opacity="0.09" />
                <rect x={x(d.times[r.a])} width={Math.max(0.5, x(d.times[r.b]) - x(d.times[r.a]))} y={top2} height={H2} fill={colors[r.k]} opacity="0.09" />
                <rect x={x(d.times[r.a])} width={Math.max(0.5, x(d.times[r.b]) - x(d.times[r.a]))} y={m.top + H1 - 3} height="3" fill={colors[r.k]} opacity="0.85" />
              </g>
            ))}
            <GridY y={ySpx} ticks={spxTicks} x0={m.left} x1={width - m.right} />
            <GridY y={yVix} ticks={vixTicks} x0={m.left} x1={width - m.right} />
            <RightAxis y={ySpx} ticks={spxTicks} x={width - m.right} format={(v) => num(v, 0)} title="SPX · log" />
            <RightAxis y={yVix} ticks={vixTicks} x={width - m.right} format={(v) => `${v}`} title="VIX" />
            <path d={linePath(times, spx, x, ySpx)} fill="none" stroke="var(--text)" stroke-width="1.3" stroke-linejoin="round" />
            <path d={linePath(times, sl(d.series.vix3m), x, yVix)} fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 2" opacity="0.8" />
            <path d={linePath(times, vix, x, yVix)} fill="none" stroke="var(--accent)" stroke-width="1.3" stroke-linejoin="round" />
            {postPaths.map((path, k) => (
              <path key={k} d={path} fill={colors[k]} opacity="0.85" />
            ))}
            <text x={width - m.right + 6} y={top3 + H3 / 2} dominant-baseline="middle" class="axis-title">
              P(k)
            </text>
            {years.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={top3 + H3} y2={top3 + H3 + 4} stroke="var(--border-strong)" />
                <text x={x(t)} y={top3 + H3 + 16} text-anchor="middle">
                  {fmtTick(t, p.range)}
                </text>
              </g>
            ))}
            {hover !== null && (
              <g pointer-events="none">
                <line x1={hx} x2={hx} y1={m.top} y2={top3 + H3} stroke="rgba(247,247,247,0.45)" />
                <circle cx={hx} cy={ySpx(d.series.spx[h])} r="3.5" fill="var(--text)" stroke="var(--panel)" stroke-width="1.5" />
                <circle cx={hx} cy={yVix(d.series.vix[h])} r="3.5" fill="var(--accent)" stroke="var(--panel)" stroke-width="1.5" />
              </g>
            )}
          </svg>
        )}
        <div class="legend" style={{ padding: '0 6px' }}>
          {names.map((n, k) => (
            <span key={n}>
              <span class="dot" style={{ background: colors[k] }} />
              {n}
            </span>
          ))}
          <span style={{ color: 'var(--accent)' }}>
            <i class="swatch" />
            <span style={{ color: 'var(--muted)' }}>VIX</span>
          </span>
          <span>
            <i class="swatch dash" />
            VIX3M
          </span>
        </div>
      </div>
    </div>
  )
}

function RightAxis(p: { y: Scale; ticks: number[]; x: number; format: (v: number) => string; title: string }) {
  return (
    <g>
      {p.ticks.map((t) => (
        <text key={t} x={p.x + 6} y={p.y(t)} dominant-baseline="middle">
          {p.format(t)}
        </text>
      ))}
      <text class="axis-title" x={p.x + 6} y={Math.min(...p.y.range) - 9}>
        {p.title}
      </text>
    </g>
  )
}

function logTicksSpx(lo: number, hi: number): number[] {
  const span = Math.log10(hi / lo)
  const step = span > 0.45 ? 1000 : span > 0.2 ? 500 : 250
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v)
  return out.length > 6 ? out.filter((_, i) => i % 2 === 0) : out
}

function yearTicks(t0: number, t1: number, width: number): number[] {
  const out: number[] = []
  const y0 = new Date(t0).getUTCFullYear()
  const y1 = new Date(t1).getUTCFullYear()
  const spanYears = (t1 - t0) / (365.25 * 86400000)
  if (spanYears < 1.5) {
    for (let y = y0; y <= y1; y++)
      for (let mth = 0; mth < 12; mth += 3) {
        const t = Date.UTC(y, mth, 1)
        if (t >= t0 && t <= t1) out.push(t)
      }
    return out
  }
  const every = Math.max(1, Math.ceil(spanYears / Math.max(2, Math.floor(width / 70))))
  for (let y = y0 + 1; y <= y1; y++) if ((y - y0 - 1) % every === 0) out.push(Date.UTC(y, 0, 1))
  return out
}

function fmtTick(t: number, range: Range) {
  const d = new Date(t)
  if (range === '1y') return `${['Jan', 'Apr', 'Jul', 'Oct'][Math.floor(d.getUTCMonth() / 3)]} ${String(d.getUTCFullYear()).slice(2)}`
  return `${d.getUTCFullYear()}`
}
