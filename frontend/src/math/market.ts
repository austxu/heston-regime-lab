/**
 * Calibration to the real SPX snapshot (port of calibration/market.py): model implied vols
 * per expiry in forward units, fit statistics against bid/ask, a streaming bounded LM fit,
 * and the display helpers (smile curves, surface grid, densities and their moments).
 */
import { densityKernel, density, densityNodes, ivOtm, lewisKernel, otmPrice, sliceNodes, type Kernel } from './fourier'
import { lmSteps } from './lm'
import { MODELS, type ModelId } from './models'

export interface MarketSlice {
  tau: number
  k: number[]
  iv: number[]
  ivBid: number[]
  ivAsk: number[]
  atmVol: number
}

const lewisFor = (model: ModelId, p: ArrayLike<number>, tau: number, atmVol: number): Kernel =>
  lewisKernel(MODELS[model].cf(p, tau), sliceNodes(atmVol, tau))

/** Model implied vols at the quotes, concatenated over slices (NaN where not invertible). */
export function modelIvs(model: ModelId, p: ArrayLike<number>, slices: MarketSlice[], xtol = 1e-12): Float64Array {
  const out = new Float64Array(slices.reduce((s, sl) => s + sl.k.length, 0))
  let o = 0
  for (const s of slices) {
    const kern = lewisFor(model, p, s.tau, s.atmVol)
    for (const k of s.k) out[o++] = ivOtm(otmPrice(kern, k), k, s.tau, xtol)
  }
  return out
}

export interface FitStats {
  rmse: number
  mae: number
  maxAbs: number
  inside: number
  sliceRmse: number[]
}

export function fitStats(iv: ArrayLike<number>, slices: MarketSlice[]): FitStats {
  let sq = 0
  let ab = 0
  let mx = 0
  let inside = 0
  let n = 0
  let o = 0
  const sliceRmse: number[] = []
  for (const s of slices) {
    let ss = 0
    let sn = 0
    s.k.forEach((_, i) => {
      const m = iv[o++]
      const ok = Number.isFinite(m)
      const e = ok ? m - s.iv[i] : 1
      sq += e * e
      ab += Math.abs(e)
      mx = Math.max(mx, Math.abs(e))
      if (ok && m >= s.ivBid[i] && m <= s.ivAsk[i]) inside++
      if (ok) {
        ss += e * e
        sn++
      }
      n++
    })
    sliceRmse.push(Math.sqrt(ss / Math.max(1, sn)))
  }
  return { rmse: Math.sqrt(sq / n), mae: ab / n, maxAbs: mx, inside: inside / n, sliceRmse }
}

export interface MarketIter {
  iteration: number
  loss: number
  params: number[]
  nfev: number
  modelIv: Float64Array
}
export interface MarketResult extends MarketIter, FitStats {
  converged: boolean
  message: string
  ms: number
}

/** Streaming bounded LM fit of `model` to the slices from `start` (parameter space). */
export function* calibrateMarketSteps(
  model: ModelId,
  slices: MarketSlice[],
  start: number[],
  opts: { maxIter?: number } = {},
): Generator<MarketIter, MarketResult> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const { bounds } = MODELS[model]
  const lo = bounds.map((b) => b[0])
  const hi = bounds.map((b) => b[1])
  const target = slices.flatMap((s) => s.iv)
  const toParams = (z: number[]) => z.map((zi, i) => lo[i] + zi * (hi[i] - lo[i]))
  const evalZ = (z: number[]) => {
    const iv = modelIvs(model, toParams(z), slices, 1e-10)
    const r = new Float64Array(iv.length)
    let f = 0
    for (let i = 0; i < iv.length; i++) {
      const d = iv[i] - target[i]
      r[i] = Number.isFinite(d) ? d : 10
      f += r[i] * r[i]
    }
    return { r, f, iv }
  }
  const z0 = start.map((v, i) => Math.min(1 - 1e-6, Math.max(1e-6, (v - lo[i]) / (hi[i] - lo[i]))))
  let iv: Float64Array = new Float64Array(0)
  const steps = lmSteps(evalZ, z0, { maxIter: opts.maxIter ?? 200, onAccept: (e) => (iv = e.iv) })
  let s = steps.next()
  while (!s.done) {
    const st = s.value
    yield { iteration: st.iteration, loss: st.loss, params: toParams(st.z), nfev: st.nfev, modelIv: iv }
    s = steps.next()
  }
  const res = s.value
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return {
    iteration: res.iteration,
    loss: res.loss,
    params: toParams(res.z),
    nfev: res.nfev,
    modelIv: iv,
    ...fitStats(iv, slices),
    converged: res.converged,
    message: res.message,
    ms: t1 - t0,
  }
}

/** Model smiles on per-slice k grids, concatenated (for the smile charts). */
export function smileCurves(model: ModelId, p: ArrayLike<number>, slices: MarketSlice[], ks: number[][]): Float64Array {
  const out = new Float64Array(ks.reduce((s, g) => s + g.length, 0))
  let o = 0
  slices.forEach((s, i) => {
    const kern = lewisFor(model, p, s.tau, s.atmVol)
    for (const k of ks[i]) out[o++] = ivOtm(otmPrice(kern, k), k, s.tau, 1e-9)
  })
  return out
}

/**
 * IV surface on a (tau x x) grid with x = ln(K/F) / sqrt(tau): rows are maturities, and the
 * quadrature at an off-quote maturity uses the ATM vol interpolated between slices (atms).
 */
export function surfaceZ(model: ModelId, p: ArrayLike<number>, taus: number[], xs: number[], atms: number[]) {
  const zs = xs
  const iv = new Float64Array(taus.length * zs.length)
  const flag = new Uint8Array(iv.length)
  taus.forEach((tau, i) => {
    const kern = lewisFor(model, p, tau, atms[i])
    zs.forEach((z, j) => {
      const k = z * Math.sqrt(tau)
      const price = otmPrice(kern, k)
      iv[i * zs.length + j] = price > 1e-9 ? ivOtm(price, k, tau, 1e-8) : Number.NaN
    })
    // Flat-extrapolate wing cells whose price is below the quadrature floor, and flag them.
    const row = i * zs.length
    let first = -1
    let last = -1
    for (let j = 0; j < zs.length; j++) {
      if (!Number.isFinite(iv[row + j])) continue
      if (first < 0) first = j
      last = j
    }
    for (let j = 0; j < zs.length; j++) {
      if (Number.isFinite(iv[row + j])) continue
      iv[row + j] = first < 0 ? 0 : iv[row + (j < first ? first : last)]
      flag[row + j] = 1
    }
  })
  return { iv, flag }
}

/** Model density of x_T on a grid. */
export function modelDensity(model: ModelId, p: ArrayLike<number>, tau: number, atmVol: number, xs: number[]): Float64Array {
  const kern = densityKernel(MODELS[model].cf(p, tau), densityNodes(atmVol, tau))
  return Float64Array.from(xs, (x) => density(kern, x))
}

export interface Moments {
  mass: number
  mean: number
  sd: number
  skew: number
  exKurt: number
}

/** Moments of a density sampled on an even grid (trapezoid rule). */
export function moments(xs: ArrayLike<number>, q: ArrayLike<number>): Moments {
  const n = xs.length
  const dx = (xs[n - 1] - xs[0]) / (n - 1)
  const w = (i: number) => (i === 0 || i === n - 1 ? 0.5 : 1) * dx * Math.max(0, q[i])
  let m0 = 0
  let m1 = 0
  for (let i = 0; i < n; i++) {
    m0 += w(i)
    m1 += w(i) * xs[i]
  }
  const mean = m1 / m0
  let c2 = 0
  let c3 = 0
  let c4 = 0
  for (let i = 0; i < n; i++) {
    const d = xs[i] - mean
    const d2 = d * d
    c2 += w(i) * d2
    c3 += w(i) * d2 * d
    c4 += w(i) * d2 * d2
  }
  c2 /= m0
  c3 /= m0
  c4 /= m0
  return { mass: m0, mean, sd: Math.sqrt(c2), skew: c3 / c2 ** 1.5, exKurt: c4 / (c2 * c2) - 3 }
}
