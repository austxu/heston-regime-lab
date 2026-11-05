import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { fixed, num, pct, pctTickFormat, signed, tenor } from '../lib/format'
import { flags, useDebounced, useReducedMotion, useSize } from '../lib/hooks'
import type { MarketData } from '../lib/market'
import { extent, linear, niceDomain, ticks } from '../lib/scale'
import { makeGrid, type Grid } from '../math/surface'
import type { HestonParams } from '../math/types'
import type { SurfaceData } from '../render/surface3d'
import { AxisBottom, AxisLeft, GridX, GridY, linePath } from '../ui/axes'
import { Slider } from '../ui/Slider'
import { Surface3D } from '../ui/Surface3D'
import { latestWins, request } from '../worker/client'

export interface PlaygroundState {
  params: HestonParams
  rate: number
}

export const TEXTBOOK: HestonParams = { kappa: 2.0, theta: 0.04, sigma: 0.5, rho: -0.7, v0: 0.04 }

const GRID = makeGrid(33, 24, 0.8, 1.2, 1 / 12, 2, 'm')
const SMILE_T = [1 / 12, 0.25, 0.5, 1, 2]
const SMILE_GRID: Grid = { kind: 'm', x: Array.from({ length: 41 }, (_, j) => 0.8 + j * 0.01), tau: SMILE_T }
const TERM_GRID: Grid = { kind: 'm', x: [1], tau: Array.from({ length: 40 }, (_, i) => (Math.sqrt(1 / 52) + ((Math.sqrt(3) - Math.sqrt(1 / 52)) * i) / 39) ** 2) }
export const MATURITY_COLORS = ['#f0887b', '#f670c7', '#9e77ed', '#7b8ff5', '#53b1fd']

const xTicksM = (lo: number, hi: number) => ticks(lo, hi, 4)
const xTickM = (x: number) => `${Math.round(x * 100)}%`
const xReadoutM = (x: number) => `${(x * 100).toFixed(1)}% of spot`

type Key = keyof HestonParams | 'rate'
const HINTS: Record<Key, (p: HestonParams, r: number) => preact.ComponentChildren> = {
  kappa: (p) => (
    <>
      <b>κ, mean reversion.</b> How fast variance is pulled back to θ: a half-life of {num(Math.log(2) / p.kappa, 2)} years. Higher κ
      flattens the term structure and damps the long-dated smile.
    </>
  ),
  theta: (p) => (
    <>
      <b>θ, long-run variance.</b> Where long-dated ATM vol settles, near √θ = {pct(Math.sqrt(p.theta))}. It lifts the back of the
      surface.
    </>
  ),
  sigma: () => (
    <>
      <b>σ, vol of vol.</b> How violently variance itself moves. It fattens both tails, adding curvature (convexity) to every smile,
      most at short maturities.
    </>
  ),
  rho: (p) => (
    <>
      <b>ρ, spot–vol correlation.</b> {p.rho < -0.05 ? 'Negative ρ: when the index falls, vol rises, so downside strikes get richer. That tilt is the equity skew.' : p.rho > 0.05 ? 'Positive ρ tilts the smile the other way: upside strikes get richer (commodity-style skew).' : 'Near-zero ρ gives a symmetric smile.'}
    </>
  ),
  v0: (p) => (
    <>
      <b>v₀, current variance.</b> Sets the front of the surface: short-dated ATM vol starts near √v₀ = {pct(Math.sqrt(p.v0))}.
    </>
  ),
  rate: () => (
    <>
      <b>r, risk-free rate.</b> Moves the forward. Surfaces here are drawn against K/S, so r shifts each smile sideways a little.
    </>
  ),
}

interface Computed {
  surface: SurfaceData
  smiles: Float64Array
  term: Float64Array
  ms: number
  quality: 'draft' | 'fine'
}

export function Playground(props: {
  state: PlaygroundState
  setState: (s: PlaygroundState) => void
  market: MarketData | null
  attract?: boolean
  onInteract?: () => void
  compact?: boolean
}) {
  const { params, rate } = props.state
  const reduced = useReducedMotion()
  const [res, setRes] = useState<Computed | null>(null)
  const [focus, setFocus] = useState<Key>('rho')

  const run = useMemo(
    () =>
      latestWins(
        async (q: { params: HestonParams; rate: number; quality: 'draft' | 'fine' }) => {
          const market = { spot: 100, rate: q.rate, div: 0 }
          const t0 = performance.now()
          const [s, sm, tm] = await Promise.all([
            request({ type: 'surface', params: q.params, market, grid: GRID, quality: q.quality }, 'surface'),
            request({ type: 'surface', params: q.params, market, grid: SMILE_GRID, quality: q.quality }, 'surface'),
            request({ type: 'surface', params: q.params, market, grid: TERM_GRID, quality: q.quality }, 'surface'),
          ])
          return {
            surface: { grid: GRID, iv: s.iv, flag: s.flag },
            smiles: sm.iv,
            term: tm.iv,
            ms: s.ms + sm.ms + tm.ms,
            wall: performance.now() - t0,
            quality: q.quality,
          }
        },
        (r) => setRes(r),
      ),
    [],
  )

  // Draft immediately on every change; refine once input settles.
  const settled = useDebounced(props.state, 140)
  useEffect(() => run({ params, rate, quality: 'draft' }), [params, rate])
  useEffect(() => run({ params: settled.params, rate: settled.rate, quality: 'fine' }), [settled])

  // Attract mode: gently sweep rho / sigma / v0 until the visitor interacts.
  const base = useRef(params)
  useEffect(() => {
    if (!props.attract || reduced) return
    base.current = props.state.params
    const t0 = performance.now()
    const id = setInterval(() => {
      const t = (performance.now() - t0) / 1000
      props.setState({
        rate,
        params: {
          ...base.current,
          rho: Math.max(-0.95, Math.min(0.3, -0.45 + 0.42 * Math.sin(t * 0.42))),
          sigma: 0.65 + 0.35 * Math.sin(t * 0.27 + 1.3),
          v0: 0.034 + 0.022 * Math.sin(t * 0.19 + 2.1),
        },
      })
    }, 90)
    return () => clearInterval(id)
  }, [props.attract, reduced])

  const set = (k: Key, v: number) => {
    props.onInteract?.()
    if (k === 'rate') props.setState({ params, rate: v })
    else props.setState({ params: { ...params, [k]: v }, rate })
  }

  const atm1y = res ? res.smiles[3 * 41 + 20] : Number.NaN
  const skew3m = res ? res.smiles[1 * 41 + 10] - res.smiles[1 * 41 + 30] : Number.NaN
  const twoKT = 2 * params.kappa * params.theta
  const s2 = params.sigma ** 2
  const fellerOk = twoKT > s2
  const summary = useDebounced(
    res
      ? `Implied volatility surface for strikes 80% to 120% of spot and maturities 1 month to 2 years. At-the-money 1-year implied vol ${pct(atm1y)}; 3-month 90/110 skew ${(skew3m * 100).toFixed(1)} vol points; the surface ranges from ${pct(extent(res.surface.iv)[0])} to ${pct(extent(res.surface.iv)[1])}.`
      : 'Computing the implied volatility surface.',
    400,
  )

  if (props.attract) {
    return (
      <div class="attract">
        <Surface3D
          data={res?.surface ?? null}
          xLabel="strike K/S"
          xTick={xTickM}
          xTicks={xTicksM}
          xReadout={xReadoutM}
          autoRotate={0.16}
          onInteract={props.onInteract}
          label={summary}
          minimal
          pad={{ top: 64, bottom: 46 }}
        />
        <div class="attract-overlay">
          <p class="eyebrow">heston · regime · lab</p>
          <h1>Implied-vol surface, priced live in your browser</h1>
        </div>
        <div class="attract-params" aria-hidden="true">
          <span class="chip">ρ {fixed(params.rho, 2)}</span>
          <span class="chip">σ {fixed(params.sigma, 2)}</span>
          <span class="chip">√v₀ {pct(Math.sqrt(params.v0))}</span>
          <span class="chip">atm 1y {pct(atm1y)}</span>
        </div>
        <div class="attract-cta">drag to explore</div>
      </div>
    )
  }

  const presets: { label: string; params: HestonParams; color?: string }[] = [
    { label: 'textbook', params: TEXTBOOK },
    ...(props.market?.regimes.map((r, i) => ({ label: r.name, params: r.params, color: ['#7ee787', '#53b1fd', '#f0887b'][i] })) ?? []),
  ]

  return (
    <section class="view v-surface" aria-labelledby="pg-title">
      <div class="panel area-surface">
        <div class="panel-head">
          <div>
            <p class="eyebrow">01 / surface</p>
            <h2 id="pg-title">Heston implied-volatility surface</h2>
          </div>
          <div class="readouts">
            <div class="readout">
              <span class="eyebrow">atm 1y</span>
              <b>{pct(atm1y, 2)}</b>
            </div>
            <div class="readout">
              <span class="eyebrow">3m skew 90/110</span>
              <b>{Number.isFinite(skew3m) ? `${signed(skew3m * 100, 2)} vp` : '—'}</b>
            </div>
            <div class="readout">
              <span class="eyebrow">{res?.quality === 'draft' ? 'draft · 64 nodes' : 'priced · 128 nodes'}</span>
              <b>{res ? `${res.ms.toFixed(1)} ms` : '—'}</b>
            </div>
          </div>
        </div>
        <Surface3D
          data={res?.surface ?? null}
          xLabel="strike K/S"
          xTick={xTickM}
          xTicks={xTicksM}
          xReadout={xReadoutM}
          onInteract={props.onInteract}
          label={summary}
          hint="drag to rotate · hover to read"
        />
        <p class="sr-only" aria-live="polite">
          {summary}
        </p>
      </div>

      <div class="panel area-controls">
        <div class="panel-head">
          <div>
            <p class="eyebrow">parameters</p>
            <h2>Shape the surface</h2>
          </div>
          <button type="button" class="btn small ghost" onClick={() => props.setState({ params: TEXTBOOK, rate: props.market?.latestRate ?? rate })}>
            Reset
          </button>
        </div>
        <div class="controls" style={{ padding: '8px 6px 14px' }}>
          <div class="presets" role="group" aria-label="Parameter presets">
            {presets.map((p) => (
              <button type="button" class="btn small" key={p.label} onClick={() => props.setState({ params: p.params, rate })}>
                {p.color && <span class="dot" style={{ background: p.color }} />}
                {p.label}
              </button>
            ))}
          </div>
          <Slider id="p-kappa" sym="κ" label="mean reversion" value={params.kappa} min={0.1} max={10} step={0.05} format={(v) => num(v, 2)} onInput={(v) => set('kappa', v)} onFocus={() => setFocus('kappa')} />
          <Slider id="p-theta" sym="θ" label="long-run variance" value={params.theta} min={0.005} max={0.25} step={0.001} format={(v) => num(v, 3)} aside={`√θ ${pct(Math.sqrt(params.theta))}`} onInput={(v) => set('theta', v)} onFocus={() => setFocus('theta')} />
          <Slider id="p-sigma" sym="σ" label="vol of vol" value={params.sigma} min={0.05} max={1.5} step={0.01} format={(v) => num(v, 2)} onInput={(v) => set('sigma', v)} onFocus={() => setFocus('sigma')} />
          <Slider id="p-rho" sym="ρ" label="spot–vol correlation" value={params.rho} min={-0.95} max={0.5} step={0.01} format={(v) => fixed(v, 2)} onInput={(v) => set('rho', v)} onFocus={() => setFocus('rho')} />
          <Slider id="p-v0" sym="v₀" label="current variance" value={params.v0} min={0.005} max={0.25} step={0.001} format={(v) => num(v, 3)} aside={`√v₀ ${pct(Math.sqrt(params.v0))}`} onInput={(v) => set('v0', v)} onFocus={() => setFocus('v0')} />
          <Slider id="p-rate" sym="r" label="risk-free rate" value={rate} min={0} max={0.08} step={0.0005} format={(v) => pct(v, 2)} onInput={(v) => set('rate', v)} onFocus={() => setFocus('rate')} />
          <div class="feller" role="status">
            <div class="feller-row">
              <span>Feller condition</span>
              <b class={fellerOk ? 'ok' : 'bad'}>{fellerOk ? 'satisfied' : 'violated'}</b>
            </div>
            <div class="feller-bar" aria-hidden="true">
              <span style={{ width: `${(100 * twoKT) / (twoKT + s2)}%`, background: fellerOk ? 'var(--lime)' : 'var(--ember)' }} />
              <i style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: '1px', background: 'var(--muted)' }} />
            </div>
            <div class="feller-row mono" style={{ fontSize: '11.5px', color: 'var(--muted)' }}>
              <span>2κθ = {num(twoKT, 3)}</span>
              <span>{fellerOk ? '>' : '≤'}</span>
              <span>σ² = {num(s2, 3)}</span>
            </div>
            <p class="feller-note">
              {fellerOk ? 'Variance stays strictly positive.' : 'Variance can touch zero. Pricing stays valid, but paths pile up near v = 0.'}
            </p>
          </div>
          <p class="hint" aria-live="polite">
            {HINTS[focus](params, rate)}
          </p>
        </div>
      </div>

      <div class="area-charts">
        <SmileChart res={res} />
        <TermChart res={res} params={params} />
      </div>
    </section>
  )
}

function SmileChart({ res }: { res: Computed | null }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const H = flags.embed ? 150 : 210
  const m = { top: 22, right: 14, bottom: 38, left: 44 }
  const x = linear([0.8, 1.2], [m.left, Math.max(m.left + 10, width - m.right)])
  const ys = res ? extent(res.smiles) : ([0.1, 0.3] as [number, number])
  const yd = niceDomain(ys[0], ys[1], 4)
  const y = linear(yd, [H - m.bottom, m.top])
  const yt = ticks(yd[0], yd[1], 4)
  const xt = [0.8, 0.9, 1, 1.1, 1.2]
  return (
    <figure class="panel" style={{ margin: 0 }}>
      <div class="panel-head">
        <div>
          <p class="eyebrow">smile slices</p>
          <h3>IV across strikes, by maturity</h3>
        </div>
        <div class="legend">
          {SMILE_T.map((t, i) => (
            <span key={t} style={{ color: MATURITY_COLORS[i] }}>
              <i class="swatch" />
              <span style={{ color: 'var(--muted)' }}>{tenor(t)}</span>
            </span>
          ))}
        </div>
      </div>
      <div ref={ref} style={{ padding: '0 6px 6px' }}>
        {width > 0 && (
          <svg class="chart" width={width} height={H} role="img" aria-label={res ? `Smiles: 1-month ATM ${pct(res.smiles[20])}, 2-year ATM ${pct(res.smiles[4 * 41 + 20])}.` : 'Smiles loading'}>
            <GridY y={y} ticks={yt} x0={m.left} x1={width - m.right} />
            <GridX x={x} ticks={xt} y0={m.top} y1={H - m.bottom} />
            <line class="zero" x1={x(1)} x2={x(1)} y1={m.top} y2={H - m.bottom} stroke-dasharray="3 3" />
            <AxisLeft y={y} ticks={yt} x={m.left} format={pctTickFormat(yt)} title="IV" />
            <AxisBottom x={x} ticks={xt} y={H - m.bottom} format={(v) => `${Math.round(v * 100)}%`} title="strike K/S" />
            {res &&
              SMILE_T.map((_, i) => (
                <path
                  key={i}
                  d={linePath(SMILE_GRID.x, res.smiles.subarray(i * 41, (i + 1) * 41), x, y)}
                  fill="none"
                  stroke={MATURITY_COLORS[i]}
                  stroke-width="1.75"
                  stroke-linejoin="round"
                />
              ))}
          </svg>
        )}
      </div>
    </figure>
  )
}

function TermChart({ res, params }: { res: Computed | null; params: HestonParams }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const H = flags.embed ? 150 : 210
  const m = { top: 22, right: 66, bottom: 38, left: 44 }
  const x = linear([0, 3], [m.left, Math.max(m.left + 10, width - m.right)])
  const sv0 = Math.sqrt(params.v0)
  const sth = Math.sqrt(params.theta)
  const vals = res ? [...extent(res.term), sv0, sth] : [0.1, 0.3]
  const yd = niceDomain(Math.min(...vals), Math.max(...vals), 4)
  const y = linear(yd, [H - m.bottom, m.top])
  const yt = ticks(yd[0], yd[1], 4)
  const xt = [0, 0.5, 1, 1.5, 2, 2.5, 3]
  return (
    <figure class="panel" style={{ margin: 0 }}>
      <div class="panel-head">
        <div>
          <p class="eyebrow">term structure</p>
          <h3>ATM vol by maturity (K = S)</h3>
        </div>
        <div class="legend">
          <span style={{ color: 'var(--accent)' }}>
            <i class="swatch" />
            <span style={{ color: 'var(--muted)' }}>model</span>
          </span>
          <span style={{ color: 'var(--muted)' }}>
            <i class="swatch dash" />
            √v₀, √θ
          </span>
        </div>
      </div>
      <div ref={ref} style={{ padding: '0 6px 6px' }}>
        {width > 0 && (
          <svg class="chart" width={width} height={H} role="img" aria-label={res ? `ATM term structure from ${pct(res.term[0])} at 1 week to ${pct(res.term[res.term.length - 1])} at 3 years.` : 'Term structure loading'}>
            <GridY y={y} ticks={yt} x0={m.left} x1={width - m.right} />
            <AxisLeft y={y} ticks={yt} x={m.left} format={pctTickFormat(yt)} title="IV" />
            <AxisBottom x={x} ticks={xt} y={H - m.bottom} format={(v) => (v === 0 ? '0' : `${v}y`)} title="maturity" />
            {(Math.abs(y(sv0) - y(sth)) < 12
              ? [{ v: sv0, label: '√v₀ ≈ √θ' }]
              : [
                  { v: sv0, label: '√v₀' },
                  { v: sth, label: '√θ' },
                ]
            ).map((l) => (
              <g key={l.label}>
                <line x1={m.left} x2={width - m.right} y1={y(l.v)} y2={y(l.v)} stroke="var(--muted)" stroke-dasharray="4 3" stroke-width="1" />
                <text x={width - m.right + 6} y={y(l.v)} dominant-baseline="middle" style={{ fill: 'var(--text-2)' }}>
                  {l.label}
                </text>
              </g>
            ))}
            {res && <path d={linePath(TERM_GRID.tau, res.term, x, y)} fill="none" stroke="var(--accent)" stroke-width="2" />}
          </svg>
        )}
      </div>
    </figure>
  )
}
