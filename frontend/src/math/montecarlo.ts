/**
 * Heston Monte Carlo with Andersen's (2008) Quadratic-Exponential (QE) variance scheme and
 * the matching central discretisation of ln S. QE samples the non-central chi-square
 * variance transition far more accurately than Euler, so it stays well-behaved (no negative
 * variance) even when the Feller condition fails.
 */
import { Rng } from './rng'
import type { HestonParams, Market } from './types'

export interface PathRequest {
  params: HestonParams
  market: Market
  horizon: number // years
  steps: number
  paths: number
  seed: number
  samples: number // number of individual paths to return for drawing
  quantiles: number[]
}

export interface PathResult {
  t: Float64Array // steps + 1
  /** Quantiles of S_t: quantiles.length rows of (steps + 1). */
  sq: Float64Array[]
  /** Quantiles of sqrt(v_t) (instantaneous vol). */
  vq: Float64Array[]
  /** Sample paths for drawing. */
  sPaths: Float64Array[]
  vPaths: Float64Array[]
  /** Per-step histograms of S_t and sqrt(v_t) (density shading of the fan charts). */
  sHist: Hist
  vHist: Hist
  /** Terminal log-returns ln(S_T / S_0) for every path. */
  terminal: Float64Array
  meanST: number
  seST: number
  zeroVarShare: number
  ms: number
}

/** Row-major counts [step * bins + bin] over [lo, hi], normalised to a density per step. */
export interface Hist {
  lo: number
  hi: number
  bins: number
  data: Float32Array
}

const HIST_BINS = 96

function histograms(X: Float32Array, steps: number, paths: number, lo: number, hi: number): Hist {
  const data = new Float32Array((steps + 1) * HIST_BINS)
  const scale = HIST_BINS / (hi - lo)
  const w = scale / paths // density per unit value: 1 / (paths * binWidth)
  for (let i = 0; i <= steps; i++) {
    const off = i * HIST_BINS
    for (let p = 0; p < paths; p++) {
      const b = Math.floor((X[i * paths + p] - lo) * scale)
      if (b >= 0 && b < HIST_BINS) data[off + b] += w
    }
  }
  return { lo, hi, bins: HIST_BINS, data }
}

export function simulate(req: PathRequest): PathResult {
  const t0 = performance.now()
  const { kappa, theta, sigma, rho, v0 } = req.params
  const { spot, rate, div } = req.market
  const { steps, paths } = req
  const dt = req.horizon / steps
  const rng = new Rng(req.seed)
  const e = Math.exp(-kappa * dt)
  const c1 = (sigma * sigma * e * (1 - e)) / kappa
  const c2 = (theta * sigma * sigma * (1 - e) * (1 - e)) / (2 * kappa)
  const g1 = 0.5
  const g2 = 0.5
  const k0 = (-rho * kappa * theta * dt) / sigma
  const k1 = g1 * dt * ((kappa * rho) / sigma - 0.5) - rho / sigma
  const k2 = g2 * dt * ((kappa * rho) / sigma - 0.5) + rho / sigma
  const k3 = g1 * dt * (1 - rho * rho)
  const k4 = g2 * dt * (1 - rho * rho)
  const drift = (rate - div) * dt
  const psiC = 1.5

  // Store every path's state at every step (column-major by time) to compute quantiles.
  const S = new Float32Array((steps + 1) * paths)
  const V = new Float32Array((steps + 1) * paths)
  const lnS0 = Math.log(spot)
  let zeroHits = 0
  for (let p = 0; p < paths; p++) {
    let x = lnS0
    let v = v0
    S[p] = spot
    V[p] = Math.sqrt(v0)
    for (let i = 1; i <= steps; i++) {
      const m = theta + (v - theta) * e
      const s2 = v * c1 + c2
      const psi = s2 / (m * m)
      let vn: number
      if (psi <= psiC) {
        const inv = 2 / psi
        const b2 = inv - 1 + Math.sqrt(inv) * Math.sqrt(inv - 1)
        const a = m / (1 + b2)
        const z = Math.sqrt(b2) + rng.normal()
        vn = a * z * z
      } else {
        const pz = (psi - 1) / (psi + 1)
        const beta = (1 - pz) / m
        const u = rng.next()
        vn = u <= pz ? 0 : Math.log((1 - pz) / (1 - u)) / beta
      }
      if (vn === 0) zeroHits++
      x += drift + k0 + k1 * v + k2 * vn + Math.sqrt(Math.max(0, k3 * v + k4 * vn)) * rng.normal()
      v = vn
      S[i * paths + p] = Math.exp(x)
      V[i * paths + p] = Math.sqrt(v)
    }
  }

  const t = new Float64Array(steps + 1).map((_, i) => i * dt)
  const sq = req.quantiles.map(() => new Float64Array(steps + 1))
  const vq = req.quantiles.map(() => new Float64Array(steps + 1))
  const col = new Float32Array(paths)
  // Histogram ranges: the 0.2% / 99.8% quantiles over all steps.
  let sLo = Infinity
  let sHi = -Infinity
  let vHi = -Infinity
  for (let i = 0; i <= steps; i++) {
    col.set(S.subarray(i * paths, (i + 1) * paths))
    col.sort()
    req.quantiles.forEach((q, k) => (sq[k][i] = quantileSorted(col, q)))
    sLo = Math.min(sLo, quantileSorted(col, 0.002))
    sHi = Math.max(sHi, quantileSorted(col, 0.998))
    col.set(V.subarray(i * paths, (i + 1) * paths))
    col.sort()
    req.quantiles.forEach((q, k) => (vq[k][i] = quantileSorted(col, q)))
    vHi = Math.max(vHi, quantileSorted(col, 0.998))
  }
  const sHist = histograms(S, steps, paths, sLo, sHi)
  const vHist = histograms(V, steps, paths, 0, vHi)
  const ns = Math.min(req.samples, paths)
  const sPaths: Float64Array[] = []
  const vPaths: Float64Array[] = []
  for (let p = 0; p < ns; p++) {
    const sp = new Float64Array(steps + 1)
    const vp = new Float64Array(steps + 1)
    for (let i = 0; i <= steps; i++) {
      sp[i] = S[i * paths + p]
      vp[i] = V[i * paths + p]
    }
    sPaths.push(sp)
    vPaths.push(vp)
  }
  const terminal = new Float64Array(paths)
  let sum = 0
  let sum2 = 0
  for (let p = 0; p < paths; p++) {
    const st = S[steps * paths + p]
    terminal[p] = Math.log(st / spot)
    sum += st
    sum2 += st * st
  }
  const meanST = sum / paths
  const seST = Math.sqrt(Math.max(0, sum2 / paths - meanST * meanST) / paths)
  return {
    t,
    sq,
    vq,
    sPaths,
    vPaths,
    sHist,
    vHist,
    terminal,
    meanST,
    seST,
    zeroVarShare: zeroHits / (paths * steps),
    ms: performance.now() - t0,
  }
}

function quantileSorted(a: Float32Array, q: number): number {
  const pos = q * (a.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(a.length - 1, lo + 1)
  return a[lo] + (a[hi] - a[lo]) * (pos - lo)
}

/** Sample moments of an array: mean, std, skewness, excess kurtosis. */
export function moments(x: ArrayLike<number>) {
  const n = x.length
  let m = 0
  for (let i = 0; i < n; i++) m += x[i]
  m /= n
  let m2 = 0
  let m3 = 0
  let m4 = 0
  for (let i = 0; i < n; i++) {
    const d = x[i] - m
    const d2 = d * d
    m2 += d2
    m3 += d2 * d
    m4 += d2 * d2
  }
  m2 /= n
  m3 /= n
  m4 /= n
  return { mean: m, std: Math.sqrt(m2), skew: m3 / m2 ** 1.5, kurt: m4 / (m2 * m2) - 3 }
}
