import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { fixed, num, pct, signed } from '../lib/format'
import { useReducedMotion, useSize } from '../lib/hooks'
import { linear, niceDomain, ticks, type Scale } from '../lib/scale'
import { normCdf } from '../math/normal'
import { hestonPrice } from '../math/heston'
import { moments, type PathResult } from '../math/montecarlo'
import type { HestonParams } from '../math/types'
import { Segmented } from '../ui/Segmented'
import { Slider } from '../ui/Slider'
import { request } from '../worker/client'

const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95]
const PATHS = 3000
const SAMPLES = 28
const HORIZONS = { '3m': 0.25, '1y': 1, '2y': 2 } as const
type Horizon = keyof typeof HORIZONS

export function Paths(props: { params: HestonParams; rate: number; active: boolean }) {
  const reduced = useReducedMotion()
  const [sigma, setSigma] = useState(props.params.sigma)
  const [rho, setRho] = useState(props.params.rho)
  const [horizon, setHorizon] = useState<Horizon>('1y')
  const [seed, setSeed] = useState(11)
  const [res, setRes] = useState<PathResult | null>(null)
  const [progress, setProgress] = useState(1)
  // Follow the playground when its sigma / rho change.
  useEffect(() => {
    setSigma(props.params.sigma)
    setRho(props.params.rho)
  }, [props.params.sigma, props.params.rho])

  const params = useMemo(() => ({ ...props.params, sigma, rho }), [props.params, sigma, rho])
  const T = HORIZONS[horizon]
  const market = { spot: 100, rate: props.rate, div: 0 }
  const reqId = useRef(0)

  useEffect(() => {
    if (!props.active) return
    const id = ++reqId.current
    const t = setTimeout(() => {
      request(
        { type: 'paths', req: { params, market, horizon: T, steps: Math.round(T * 252), paths: PATHS, seed, samples: SAMPLES, quantiles: QUANTILES } },
        'paths',
      ).then((r) => {
        if (id !== reqId.current) return
        setRes(r.result)
        setProgress(reduced ? 1 : 0)
      })
    }, 120)
    return () => clearTimeout(t)
  }, [params, T, seed, props.rate, props.active])

  // Reveal the fan from left to right.
  useEffect(() => {
    if (progress >= 1) return
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 1400)
      setProgress(1 - (1 - p) ** 3)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [res])

  const stats = useMemo(() => {
    if (!res) return null
    const mo = moments(res.terminal)
    const fwd = market.spot * Math.exp(market.rate * T)
    // Lognormal benchmark with the same variance of ln S_T.
    const sBS = mo.std / Math.sqrt(T)
    const crashK = Math.log(0.8)
    let below = 0
    let pay = 0
    for (const r of res.terminal) {
      if (r < crashK) below++
      pay += Math.max(market.spot * Math.exp(r) - market.spot, 0)
    }
    const pCrashBS = normCdf((crashK - (market.rate - 0.5 * sBS * sBS) * T) / (sBS * Math.sqrt(T)))
    const mcCall = (Math.exp(-market.rate * T) * pay) / res.terminal.length
    const fourier = hestonPrice(params, market.spot, market.spot, market.rate, 0, T)
    return { ...mo, fwd, sBS, pCrash: below / res.terminal.length, pCrashBS, mcCall, fourier }
  }, [res])

  const feller = 2 * params.kappa * params.theta > sigma * sigma

  return (
    <section class="view v-paths" aria-labelledby="paths-title">
      <div class="panel area-fan">
        <div class="panel-head">
          <div>
            <p class="eyebrow">04 / paths</p>
            <h2 id="paths-title">Monte Carlo: {PATHS.toLocaleString('en-US')} Heston price paths</h2>
            <p class="panel-sub">Quadratic-exponential scheme (Andersen 2008), daily steps. Bands: 5–95% and 25–75%; right: distribution of S at the horizon.</p>
          </div>
          <div class="readouts">
            <div class="readout">
              <span class="eyebrow">simulated in</span>
              <b>{res ? `${num(res.ms, 0)} ms` : '—'}</b>
            </div>
          </div>
        </div>
        <FanChart res={res} progress={progress} T={T} kind="price" sBS={stats?.sBS ?? 0} rate={props.rate} />
      </div>
      <div class="panel area-vol">
        <div class="panel-head">
          <div>
            <p class="eyebrow">variance process</p>
            <h3>Instantaneous vol √vₜ</h3>
          </div>
          <div class="legend">
            <span>
              <i class="swatch dash" />
              √θ {pct(Math.sqrt(params.theta))}
            </span>
          </div>
        </div>
        <FanChart res={res} progress={progress} T={T} kind="vol" theta={params.theta} sBS={0} rate={props.rate} />
      </div>
      <div class="area-side">
        <div class="panel panel-pad controls">
          <p class="eyebrow" style={{ padding: '0 10px' }}>
            shape the distribution
          </p>
          <Slider id="mc-sigma" sym="σ" label="vol of vol" value={sigma} min={0.05} max={1.5} step={0.01} format={(v) => num(v, 2)} onInput={setSigma} />
          <Slider id="mc-rho" sym="ρ" label="spot–vol correlation" value={rho} min={-0.95} max={0.5} step={0.01} format={(v) => fixed(v, 2)} onInput={setRho} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '4px 10px 0', flexWrap: 'wrap' }}>
            <Segmented label="Horizon" value={horizon} onChange={setHorizon} options={(Object.keys(HORIZONS) as Horizon[]).map((h) => ({ value: h, label: h }))} />
            <button type="button" class="btn small" onClick={() => setSeed((s) => s + 1)}>
              New draw
            </button>
          </div>
          <p class="panel-sub" style={{ padding: '6px 10px 0', margin: 0 }}>
            κ {num(params.kappa, 2)} · θ {num(params.theta, 3)} · v₀ {num(params.v0, 3)} · r {pct(props.rate, 2)} from the surface tab. Feller{' '}
            <span class={feller ? 'ok' : 'bad'}>{feller ? 'satisfied' : 'violated'}</span>.
          </p>
        </div>
        <div class="panel panel-pad">
          <p class="eyebrow" style={{ marginBottom: '10px' }}>
            terminal log-return · <span style={{ textTransform: 'none' }}>ln(S<sub>T</sub> / S<sub>0</sub>)</span>
          </p>
          <div class="stat-grid">
            <div class="stat">
              <span class="eyebrow">skewness</span>
              <b>{stats ? signed(stats.skew, 2) : '—'}</b>
              <small>lognormal: 0 · set by ρ</small>
            </div>
            <div class="stat">
              <span class="eyebrow">excess kurtosis</span>
              <b>{stats ? signed(stats.kurt, 2) : '—'}</b>
              <small>lognormal: 0 · set by σ</small>
            </div>
            <div class="stat">
              <span class="eyebrow">P(drop &gt; 20%)</span>
              <b>{stats ? pct(stats.pCrash, 2) : '—'}</b>
              <small>lognormal, same variance: {stats ? pct(stats.pCrashBS, 2) : '—'}</small>
            </div>
            <div class="stat">
              <span class="eyebrow">steps at v = 0</span>
              <b>{res ? pct(res.zeroVarShare, 2) : '—'}</b>
              <small>{feller ? 'Feller holds' : 'Feller fails: v hits 0'}</small>
            </div>
          </div>
        </div>
        <div class="panel panel-pad">
          <p class="eyebrow" style={{ marginBottom: '6px' }}>
            sanity checks
          </p>
          <dl class="kv">
            <div>
              <dt>Mean of S at horizon</dt>
              <dd>
                {res ? `${num(res.meanST, 2)} ± ${num(2 * res.seST, 2)}` : '—'}
                <small>forward {stats ? num(stats.fwd, 2) : '—'}</small>
              </dd>
            </div>
            <div>
              <dt>ATM call, Monte Carlo</dt>
              <dd>
                {stats ? num(stats.mcCall, 3) : '—'}
                <small>Fourier {stats ? num(stats.fourier, 3) : '—'}</small>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  )
}

function FanChart(p: { res: PathResult | null; progress: number; T: number; kind: 'price' | 'vol'; theta?: number; sBS: number; rate: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>()
  const canvas = useRef<HTMLCanvasElement>(null)
  const H = p.kind === 'price' ? (width < 600 ? 260 : 330) : width < 600 ? 150 : 180
  const histW = p.kind === 'price' ? Math.min(110, width * 0.2) : 0
  const m = { top: p.kind === 'price' ? 30 : 14, right: 46 + histW, bottom: 30, left: 8 }
  const scales = useMemo(() => {
    if (!p.res || !width) return null
    const q = p.kind === 'price' ? p.res.sq : p.res.vq
    const paths = p.kind === 'price' ? p.res.sPaths : p.res.vPaths
    let lo = Infinity
    let hi = -Infinity
    for (const arr of [q[0], q[4]]) for (const v of arr) {
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    for (const path of paths.slice(0, 12)) for (const v of path) hi = Math.max(hi, Math.min(v, hi * 1.25))
    if (p.kind === 'vol') {
      lo = 0
      hi = Math.max(hi, Math.sqrt(p.theta ?? 0) * 1.2)
    }
    const yd = niceDomain(lo, hi, 4)
    const x = linear([0, p.T], [m.left, width - m.right])
    const y = linear(yd, [H - m.bottom, m.top])
    return { x, y, yd }
  }, [p.res, width, p.kind, H])

  useEffect(() => {
    const c = canvas.current
    if (!c || !width || !scales || !p.res) return
    const dpr = Math.min(2.5, window.devicePixelRatio || 1)
    c.width = Math.round(width * dpr)
    c.height = Math.round(H * dpr)
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, H)
    drawFan(ctx, p.res, scales.x, scales.y, p.kind, p.progress, width, H, m, histW, p.theta, p.sBS, p.T, p.rate)
  }, [scales, p.progress, width, H])

  return (
    <div ref={ref} style={{ padding: '6px 6px 8px', position: 'relative' }}>
      {width > 0 && (
        <>
          <canvas
            ref={canvas}
            class="canvas-chart"
            style={{ height: `${H}px` }}
            role="img"
            aria-label={
              p.res
                ? p.kind === 'price'
                  ? `Fan chart of simulated index paths. At the horizon the median is ${num(p.res.sq[2][p.res.sq[2].length - 1], 1)} and the 5–95% band spans ${num(p.res.sq[0][p.res.sq[0].length - 1], 1)} to ${num(p.res.sq[4][p.res.sq[4].length - 1], 1)}.`
                  : `Fan chart of instantaneous volatility; median at the horizon ${pct(p.res.vq[2][p.res.vq[2].length - 1])}.`
                : 'Simulating paths'
            }
          />
          {scales && (
            <svg class="chart" width={width} height={H} style={{ position: 'absolute', left: '6px', top: '6px', pointerEvents: 'none' }} aria-hidden="true">
              <YLabels y={scales.y} ticks={ticks(scales.yd[0], scales.yd[1], 4)} x={width - m.right + 6 + histW} kind={p.kind} />
              {timeTicks(p.T).map((t) => (
                <text key={t} x={scales.x(t)} y={H - m.bottom + 16} text-anchor={t === 0 ? 'start' : 'middle'}>
                  {t === 0 ? 'today' : t < 1 || !Number.isInteger(t) ? `${Math.round(t * 12)}m` : `${t}y`}
                </text>
              ))}
            </svg>
          )}
        </>
      )}
    </div>
  )
}

/** Month-based time ticks: monthly for 3m, quarterly for 1y, half-yearly for 2y. */
function timeTicks(T: number): number[] {
  const step = T <= 0.25 ? 1 / 12 : T <= 1 ? 0.25 : 0.5
  const out: number[] = []
  for (let t = 0; t <= T + 1e-9; t += step) out.push(+t.toFixed(6))
  return out
}

function YLabels(p: { y: Scale; ticks: number[]; x: number; kind: 'price' | 'vol' }) {
  return (
    <g>
      {p.ticks.map((t) => (
        <text key={t} x={p.x} y={p.y(t)} dominant-baseline="middle">
          {p.kind === 'price' ? num(t, 0) : `${Math.round(t * 100)}%`}
        </text>
      ))}
    </g>
  )
}

function drawFan(
  ctx: CanvasRenderingContext2D,
  res: PathResult,
  x: Scale,
  y: Scale,
  kind: 'price' | 'vol',
  progress: number,
  W: number,
  H: number,
  m: { top: number; right: number; bottom: number; left: number },
  histW: number,
  theta: number | undefined,
  sBS: number,
  T: number,
  rate: number,
) {
  const q = kind === 'price' ? res.sq : res.vq
  const paths = kind === 'price' ? res.sPaths : res.vPaths
  const n = res.t.length
  const upto = Math.max(1, Math.round(progress * (n - 1)))
  const x0 = m.left
  const x1 = W - m.right
  // Grid.
  ctx.strokeStyle = 'rgba(206,207,210,0.08)'
  ctx.lineWidth = 1
  for (const t of ticks(y.domain[0], y.domain[1], 4)) {
    ctx.beginPath()
    ctx.moveTo(x0, Math.round(y(t)) + 0.5)
    ctx.lineTo(W - 46, Math.round(y(t)) + 0.5)
    ctx.stroke()
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(x0, m.top - 2, x1 - x0, H - m.top - m.bottom + 4)
  ctx.clip()
  const band = (lo: Float64Array, hi: Float64Array, fill: string) => {
    ctx.beginPath()
    for (let i = 0; i <= upto; i++) ctx.lineTo(x(res.t[i]), y(hi[i]))
    for (let i = upto; i >= 0; i--) ctx.lineTo(x(res.t[i]), y(lo[i]))
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
  }
  band(q[0], q[4], 'rgba(158,119,237,0.13)')
  band(q[1], q[3], 'rgba(158,119,237,0.22)')
  ctx.lineWidth = 0.8
  paths.forEach((path, k) => {
    ctx.strokeStyle = k === 0 ? 'rgba(240,136,123,0.9)' : 'rgba(247,247,247,0.16)'
    ctx.lineWidth = k === 0 ? 1.3 : 0.8
    ctx.beginPath()
    for (let i = 0; i <= upto; i++) {
      const X = x(res.t[i])
      const Y = y(path[i])
      if (i === 0) ctx.moveTo(X, Y)
      else ctx.lineTo(X, Y)
    }
    ctx.stroke()
  })
  ctx.strokeStyle = '#9e77ed'
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let i = 0; i <= upto; i++) ctx.lineTo(x(res.t[i]), y(q[2][i]))
  ctx.stroke()
  if (kind === 'vol' && theta) {
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = 'rgba(148,151,156,0.9)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x0, y(Math.sqrt(theta)))
    ctx.lineTo(x1, y(Math.sqrt(theta)))
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.restore()
  // Axis baseline.
  ctx.strokeStyle = 'rgba(206,207,210,0.22)'
  ctx.beginPath()
  ctx.moveTo(x1 + 0.5, m.top)
  ctx.lineTo(x1 + 0.5, H - m.bottom)
  ctx.stroke()

  if (kind !== 'price' || !histW || progress < 0.98) return
  // Terminal histogram on the same price axis, against a same-variance lognormal.
  const bins = 48
  const [lo, hi] = y.domain
  const counts = new Float64Array(bins)
  for (const r of res.terminal) {
    const s = 100 * Math.exp(r)
    const b = Math.floor(((s - lo) / (hi - lo)) * bins)
    if (b >= 0 && b < bins) counts[b]++
  }
  const binW = (hi - lo) / bins
  const dens = Array.from(counts, (c) => c / (res.terminal.length * binW))
  const lnDens = (s: number) => {
    const mu = Math.log(100) + (rate - 0.5 * sBS * sBS) * T
    const sd = sBS * Math.sqrt(T)
    return Math.exp(-((Math.log(s) - mu) ** 2) / (2 * sd * sd)) / (s * sd * Math.sqrt(2 * Math.PI))
  }
  let maxD = Math.max(...dens)
  for (let i = 0; i <= 80; i++) maxD = Math.max(maxD, lnDens(lo + ((hi - lo) * i) / 80))
  const hx0 = x1 + 6
  const sx = (v: number) => hx0 + (v / maxD) * (histW - 10)
  ctx.fillStyle = 'rgba(158,119,237,0.55)'
  dens.forEach((dv, b) => {
    const yTop = y(lo + (b + 1) * binW)
    const yBot = y(lo + b * binW)
    ctx.fillRect(hx0, yTop + 0.5, sx(dv) - hx0, Math.max(0.5, yBot - yTop - 1))
  })
  ctx.setLineDash([3, 3])
  ctx.strokeStyle = 'rgba(247,247,247,0.7)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i <= 80; i++) {
    const s = lo + ((hi - lo) * i) / 80
    const X = sx(lnDens(s))
    if (i === 0) ctx.moveTo(X, y(s))
    else ctx.lineTo(X, y(s))
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.font = '400 10px "Roboto Mono", monospace'
  ctx.fillStyle = '#94979c'
  ctx.textAlign = 'left'
  ctx.fillText('S at horizon', hx0, 10)
  ctx.fillStyle = 'rgba(247,247,247,0.75)'
  ctx.fillText('┄ lognormal', hx0, 23)
}
