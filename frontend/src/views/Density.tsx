import { useEffect, useMemo, useState } from 'preact/hooks'
import { num, pct } from '../lib/format'
import { useSize } from '../lib/hooks'
import { linear, log, niceDomain, ticks } from '../lib/scale'
import { daysLabel, expiryLabel, MODEL_COLORS, MODEL_IDS, type SpxData, type SpxSlice } from '../lib/spx'
import { bsPrice } from '../math/blackScholes'
import { moments, type Moments } from '../math/market'
import { MODELS } from '../math/models'
import { sviDensity } from '../math/svi'
import { AxisBottom, AxisLeft, GridX, GridY, linePath } from '../ui/axes'
import { Segmented } from '../ui/Segmented'
import { request } from '../worker/client'

type SourceId = 'svi' | 'heston' | 'bates' | 'double' | 'lognormal'
const SOURCES: { id: SourceId; label: string }[] = [
  { id: 'svi', label: 'Market (SVI)' },
  { id: 'heston', label: 'Heston' },
  { id: 'bates', label: 'Bates' },
  { id: 'double', label: 'Double Heston' },
  { id: 'lognormal', label: 'Lognormal, ATM vol' },
]
const NX = 321
const TAILS = [-0.2, -0.1, -0.05, 0.05, 0.1]

interface SliceDensities {
  xs: number[]
  q: Record<SourceId, Float64Array>
  mo: Record<SourceId, Moments>
  /** Direct Breeden-Litzenberger estimates from the quotes: (x, density). */
  bl: [number, number][]
}

/** Grid in x = ln(F_T / F_0) from -8 to +4 ATM standard deviations. */
const gridFor = (s: SpxSlice) => {
  const a = s.atmVol * Math.sqrt(s.tau)
  return Array.from({ length: NX }, (_, i) => -8 * a + (12 * a * i) / (NX - 1))
}

/**
 * Butterfly estimates of the density straight from the quotes: undiscounted call prices per
 * unit forward from the mid vols, a three-point second difference in strike on the uneven
 * strike grid, then q_x = K q_K.
 */
function directBL(s: SpxSlice): [number, number][] {
  const K = s.k.map(Math.exp)
  const C = K.map((k, i) => bsPrice(1, k, 0, 0, s.tau, s.iv[i], 'call'))
  const out: [number, number][] = []
  for (let i = 1; i < K.length - 1; i++) {
    const hm = K[i] - K[i - 1]
    const hp = K[i + 1] - K[i]
    const d2 = (2 * ((C[i + 1] - C[i]) / hp - (C[i] - C[i - 1]) / hm)) / (hp + hm)
    out.push([s.k[i], K[i] * d2])
  }
  return out
}

function tailProb(xs: number[], q: ArrayLike<number>, move: number) {
  const cut = Math.log(1 + move)
  const dx = xs[1] - xs[0]
  let p = 0
  for (let i = 0; i < xs.length; i++) {
    const inside = move < 0 ? xs[i] <= cut : xs[i] >= cut
    if (inside) p += Math.max(0, q[i]) * dx * (i === 0 || i === xs.length - 1 ? 0.5 : 1)
  }
  return p
}

export function Density(props: { spx: SpxData | null; error: boolean; active: boolean }) {
  const { spx } = props
  const [si, setSi] = useState(1)
  const [scale, setScale] = useState<'linear' | 'log'>('linear')
  const [model, setModel] = useState<Record<string, Float64Array[]> | null>(null)

  useEffect(() => {
    if (!spx) return
    let live = true
    const xs = spx.slices.map(gridFor)
    const fits = MODEL_IDS.map((id) => ({ model: id, params: MODELS[id].names.map((n) => spx.fits[id].params[n]) }))
    request({ type: 'densities', slices: spx.slices, fits, xs }, 'densities').then((m) => {
      if (live) setModel(Object.fromEntries(MODEL_IDS.map((id, f) => [id, m.q[f]])))
    })
    return () => {
      live = false
    }
  }, [spx])

  const all: SliceDensities[] | null = useMemo(() => {
    if (!spx || !model) return null
    return spx.slices.map((s, i) => {
      const xs = gridFor(s)
      const a = s.atmVol * Math.sqrt(s.tau)
      const q: Record<SourceId, Float64Array> = {
        svi: Float64Array.from(xs, (x) => sviDensity(x, s.svi)),
        heston: model.heston[i],
        bates: model.bates[i],
        double: model.double[i],
        lognormal: Float64Array.from(xs, (x) => Math.exp(-((x + 0.5 * a * a) ** 2) / (2 * a * a)) / (a * Math.sqrt(2 * Math.PI))),
      }
      const mo = Object.fromEntries(SOURCES.map((src) => [src.id, moments(xs, q[src.id])])) as Record<SourceId, Moments>
      return { xs, q, mo, bl: directBL(s) }
    })
  }, [spx, model])

  if (!spx) {
    return <div class="panel loading">{props.error ? 'Could not load the SPX option snapshot.' : 'Loading the SPX option snapshot…'}</div>
  }
  const s = spx.slices[si]
  const d = all?.[si] ?? null
  const fwdLevel = s.forward

  return (
    <section class="view v-density" aria-labelledby="dens-title">
      <div class="panel area-chart">
        <div class="panel-head">
          <div>
            <p class="eyebrow">03 / risk-neutral density</p>
            <h2 id="dens-title">What the options say the S&amp;P will do by {expiryLabel(s.expiry, true)}</h2>
            <p class="panel-sub">
              Density of the index at expiry implied by option prices (Breeden–Litzenberger: q(K) = ∂²C/∂K², undiscounted). Forward{' '}
              {num(fwdLevel, 0)}, {daysLabel(s.tau)} to {s.settle === 'PM' ? 'the close' : 'the opening print'} on {expiryLabel(s.expiry, true)}.
            </p>
          </div>
          <div style={{ display: 'grid', gap: '6px', justifyItems: 'end' }}>
            <Segmented
              label="Density axis"
              value={scale}
              onChange={setScale}
              options={[
                { value: 'linear', label: 'linear' },
                { value: 'log', label: 'log (tails)' },
              ]}
            />
          </div>
        </div>
        <div class="expiry-pick" role="radiogroup" aria-label="Expiry">
          {spx.slices.map((sl, i) => (
            <button key={sl.expiry} type="button" role="radio" aria-checked={i === si} onClick={() => setSi(i)}>
              {expiryLabel(sl.expiry, sl.tau > 0.9)}
              <span>{daysLabel(sl.tau)}</span>
            </button>
          ))}
        </div>
        {d ? <DensityChart d={d} s={s} scale={scale} /> : <div class="loading" style={{ height: '360px' }}>Inverting characteristic functions…</div>}
        <div class="legend" style={{ padding: '0 16px 14px' }}>
          {SOURCES.map((src) => (
            <span key={src.id} style={{ color: MODEL_COLORS[src.id] }}>
              <i class={`swatch${src.id === 'lognormal' ? ' dash' : ''}`} />
              <span style={{ color: 'var(--muted)' }}>{src.label}</span>
            </span>
          ))}
          <span style={{ color: 'var(--ember)' }}>
            ◆ <span style={{ color: 'var(--muted)' }}>butterflies on the quotes</span>
          </span>
        </div>
      </div>

      <div class="area-side">
        <div class="panel panel-pad">
          <p class="eyebrow" style={{ marginBottom: '6px' }}>
            implied probabilities · {expiryLabel(s.expiry, true)}
          </p>
          <div class="table-wrap">
            <table class="data tight">
              <caption class="sr-only">Risk-neutral probability of index moves by expiry, per source</caption>
              <thead>
                <tr>
                  <th scope="col">move</th>
                  {SOURCES.filter((x) => x.id !== 'bates').map((src) => (
                    <th scope="col" key={src.id}>
                      <span class="dot" style={{ background: MODEL_COLORS[src.id] }} /> {src.id === 'svi' ? 'market' : src.id === 'lognormal' ? 'lognorm' : src.id === 'double' ? '2×Heston' : src.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TAILS.map((t) => (
                  <tr key={t}>
                    <td class="lead">{t < 0 ? `≤ −${Math.round(-t * 100)}%` : `≥ +${Math.round(t * 100)}%`}</td>
                    {SOURCES.filter((x) => x.id !== 'bates').map((src) => (
                      <td key={src.id}>{d ? probLabel(tailProb(d.xs, d.q[src.id], t)) : '—'}</td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td class="lead">skewness</td>
                  {SOURCES.filter((x) => x.id !== 'bates').map((src) => (
                    <td key={src.id}>{d ? num(d.mo[src.id].skew, 2) : '—'}</td>
                  ))}
                </tr>
                <tr>
                  <td class="lead">ex. kurtosis</td>
                  {SOURCES.filter((x) => x.id !== 'bates').map((src) => (
                    <td key={src.id}>{d ? num(d.mo[src.id].exKurt, 1) : '—'}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p class="panel-sub" style={{ marginTop: '8px' }}>
            Moves of the index from its forward. These are <b>risk-neutral</b> probabilities: they price in investors' demand for crash
            insurance, so they overstate real-world crash odds. The lognormal column uses the expiry's ATM vol, i.e. Black–Scholes with no
            smile.
          </p>
        </div>
        <div class="panel panel-pad">
          <p class="eyebrow" style={{ marginBottom: '6px' }}>
            how it is computed
          </p>
          <p class="panel-sub" style={{ margin: 0 }}>
            <b>Market</b>: Gatheral's closed-form density of the expiry's SVI fit,{' '}
            <span class="mono">q(k) = g(k) φ(d₋) / √w</span>, fitted with the vertex inside the quotes, wings within Lee's moment bound and{' '}
            {s.svi.minG >= -1e-3 ? 'g ≥ 0 across the plotted range (no butterfly arbitrage)' : `g dipping to ${num(s.svi.minG, 3)} (butterfly arbitrage in the extrapolated wing)`}.
            Dashed where it extrapolates beyond the quoted strikes.{' '}
            <b>Diamonds</b>: second differences of the mid-quote call prices, no smoothing. <b>Models</b>: Fourier inversion of each fitted
            model's characteristic function, <span class="mono">q(x) = (1/π)∫ Re[e^(−iux) φ(u)] du</span>, on 696 Gauss–Legendre nodes.
          </p>
        </div>
      </div>

      <div class="area-moments">
        <MomentChart all={all} spx={spx} pick={(m) => m.skew} title="Implied skewness of the log-return" sub="term structure" si={si} />
        <MomentChart all={all} spx={spx} pick={(m) => m.exKurt} title="Implied excess kurtosis (normal = 0)" sub="term structure · log scale" si={si} logY />
      </div>
    </section>
  )
}

const probLabel = (p: number) => (p < 0.0005 ? '<0.1%' : p < 0.1 ? pct(p, 1) : pct(p, 0))

function DensityChart(p: { d: SliceDensities; s: SpxSlice; scale: 'linear' | 'log' }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const H = 360
  const m = { top: 14, right: 16, bottom: 40, left: 52 }
  const { d, s } = p
  const lo = d.xs[0]
  const hi = d.xs[d.xs.length - 1]
  // Axis in % move of the index: ticks placed at round percentages.
  const x = linear([lo, hi], [m.left, Math.max(m.left + 10, width - m.right)])
  const peak = Math.max(...d.q.svi, ...d.q.double, ...d.q.lognormal)
  const yLin = linear(niceDomain(0, peak * 1.05, 4), [H - m.bottom, m.top])
  const yLog = log([peak * 1e-4, peak * 2], [H - m.bottom, m.top])
  const y = p.scale === 'log' ? yLog : yLin
  const clampLog = (v: number) => (p.scale === 'log' ? Math.max(v, peak * 1e-4) : v)
  const yt = p.scale === 'log' ? [1e-3, 1e-2, 1e-1, 1, 10, 100].filter((t) => t >= peak * 1e-4 && t <= peak * 2) : ticks(yLin.domain[0], yLin.domain[1], 4)
  const span = Math.exp(hi) - Math.exp(lo)
  const step = span > 1 ? 0.2 : span > 0.5 ? 0.1 : span > 0.2 ? 0.05 : 0.02
  const moves: number[] = []
  for (let v = Math.ceil((Math.exp(lo) - 1) / step) * step; v <= Math.exp(hi) - 1 + 1e-9; v += step) moves.push(+v.toFixed(4))
  const xt = moves.map((v) => Math.log(1 + v))
  const fmt = (xv: number) => {
    const mv = Math.exp(xv) - 1
    return Math.abs(mv) < 1e-9 ? '0' : `${mv > 0 ? '+' : '−'}${Math.round(Math.abs(mv) * 100)}%`
  }
  const order: SourceId[] = ['lognormal', 'heston', 'bates', 'double', 'svi']
  const kMin = s.k[0]
  const kMax = s.k[s.k.length - 1]
  return (
    <div ref={ref} style={{ padding: '0 8px' }}>
      {width > 0 && (
        <svg
          class="chart"
          width={width}
          height={H}
          role="img"
          aria-label={`Risk-neutral densities for the ${expiryLabel(s.expiry, true)} expiry. Market skewness ${num(d.mo.svi.skew, 2)}, Heston ${num(d.mo.heston.skew, 2)}, double Heston ${num(d.mo.double.skew, 2)}.`}
        >
          <defs>
            <linearGradient id="dens-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stop-color="#f0887b" stop-opacity="0.28" />
              <stop offset="1" stop-color="#f0887b" stop-opacity="0.02" />
            </linearGradient>
          </defs>
          <rect x={x(kMin)} y={m.top} width={Math.max(0, x(kMax) - x(kMin))} height={H - m.top - m.bottom} fill="rgba(206,207,210,0.035)" />
          <text x={x(kMin) + 4} y={m.top + 10} style={{ fill: 'var(--faint)' }}>
            quoted strikes
          </text>
          <GridY y={y} ticks={yt} x0={m.left} x1={width - m.right} />
          <GridX x={x} ticks={xt} y0={m.top} y1={H - m.bottom} />
          <AxisLeft y={y} ticks={yt} x={m.left} format={(v) => (v >= 1 ? `${v}` : `${v}`)} title="density" />
          <AxisBottom x={x} ticks={xt} y={H - m.bottom} format={fmt} title="index at expiry vs forward" />
          <path
            d={`${linePath(d.xs, Array.from(d.q.svi, clampLog), x, y)}L${x(hi)},${y.range[0]}L${x(lo)},${y.range[0]}Z`}
            fill="url(#dens-fill)"
            stroke="none"
          />
          {order.map((id) =>
            id === 'svi' ? (
              <g key={id}>
                <path d={linePath(d.xs, Array.from(d.q.svi, (v, i) => (d.xs[i] >= kMin && d.xs[i] <= kMax ? clampLog(v) : Number.NaN)), x, y)} fill="none" stroke={MODEL_COLORS.svi} stroke-width="2.4" />
                <path d={linePath(d.xs, Array.from(d.q.svi, (v, i) => (d.xs[i] <= kMin || d.xs[i] >= kMax ? clampLog(v) : Number.NaN)), x, y)} fill="none" stroke={MODEL_COLORS.svi} stroke-width="1.6" stroke-dasharray="2 3" />
              </g>
            ) : (
              <path
                key={id}
                d={linePath(d.xs, Array.from(d.q[id], clampLog), x, y)}
                fill="none"
                stroke={MODEL_COLORS[id]}
                stroke-width={id === 'lognormal' ? 1.2 : 1.6}
                stroke-dasharray={id === 'lognormal' ? '4 3' : undefined}
                stroke-opacity={id === 'bates' ? 0.75 : 1}
              />
            ),
          )}
          {d.bl.map(([bx, by], i) =>
            by > 0 && (p.scale === 'linear' || by > peak * 1e-4) ? (
              <path key={i} d={`M${x(bx)},${y(by) - 3.5}l3.5,3.5l-3.5,3.5l-3.5,-3.5Z`} fill="var(--panel)" stroke="var(--ember)" stroke-width="1.3" />
            ) : null,
          )}
        </svg>
      )}
    </div>
  )
}

function MomentChart(p: { all: SliceDensities[] | null; spx: SpxData; pick: (m: Moments) => number; title: string; sub: string; si: number; logY?: boolean }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const H = 210
  const m = { top: 14, right: 14, bottom: 36, left: 44 }
  const taus = p.spx.slices.map((s) => s.tau)
  const ids: SourceId[] = ['heston', 'bates', 'double', 'svi']
  const vals = p.all ? ids.map((id) => p.all!.map((d) => p.pick(d.mo[id]))) : []
  const x = log([taus[0] * 0.85, taus[taus.length - 1] * 1.15], [m.left, Math.max(m.left + 10, width - m.right)])
  const flat = vals.flat().filter(Number.isFinite)
  const lo = flat.length ? Math.min(...flat) : 0
  const hi = flat.length ? Math.max(...flat) : 1
  const yd = p.logY ? ([Math.max(0.05, lo * 0.8), hi * 1.25] as [number, number]) : niceDomain(Math.min(0, lo), Math.max(0, hi), 4)
  const y = p.logY ? log(yd, [H - m.bottom, m.top]) : linear(yd, [H - m.bottom, m.top])
  const yt = p.logY ? [0.1, 0.2, 0.5, 1, 2, 3, 5, 10, 20, 50, 100].filter((t) => t >= yd[0] && t <= yd[1]) : ticks(yd[0], yd[1], 4)
  const xt = [7 / 365, 1 / 12, 0.25, 0.5, 1, 2].filter((t) => t >= x.domain[0] && t <= x.domain[1])
  const tl = (t: number) => (t < 1 / 12 - 1e-6 ? '1w' : t < 1 ? `${Math.round(t * 12)}m` : `${t}y`)
  return (
    <div class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">{p.sub}</p>
          <h3>{p.title}</h3>
        </div>
      </div>
      <div ref={ref} style={{ padding: '0 6px 6px' }}>
        {width > 0 && (
          <svg class="chart" width={width} height={H} role="img" aria-label={`${p.title} term structure for the market (SVI) and each fitted model.`}>
            <GridY y={y} ticks={yt} x0={m.left} x1={width - m.right} />
            <AxisLeft y={y} ticks={yt} x={m.left} format={(v) => `${v}`} />
            <AxisBottom x={x} ticks={xt} y={H - m.bottom} format={tl} title="expiry (log scale)" />
            <line x1={x(taus[p.si])} x2={x(taus[p.si])} y1={m.top} y2={H - m.bottom} stroke="rgba(206,207,210,0.25)" stroke-dasharray="2 3" />
            {!p.logY && <line x1={m.left} x2={width - m.right} y1={y(0)} y2={y(0)} stroke="rgba(206,207,210,0.3)" />}
            {vals.map((v, i) => (
              <g key={ids[i]}>
                <path
                  d={linePath(taus, v, x, y)}
                  fill="none"
                  stroke={MODEL_COLORS[ids[i]]}
                  stroke-width={ids[i] === 'svi' ? 2.2 : 1.5}
                  stroke-dasharray={ids[i] === 'svi' ? undefined : undefined}
                />
                {ids[i] === 'svi' && v.map((vv, j) => (Number.isFinite(vv) ? <circle key={j} cx={x(taus[j])} cy={y(vv)} r="2.4" fill={MODEL_COLORS.svi} /> : null))}
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  )
}
