/**
 * Forward-normalised Fourier pricing and risk-neutral densities (port of models/fourier.py).
 *
 * A model is its characteristic function phi(u) = E[exp(i u x_T)] of the forward log-return
 * x_T = ln(F_T / F_0). Calls per unit forward come from the Lewis (2001) single integral
 *   C(k) = 1 - (e^{k/2} / pi) int_0^inf Re[e^{-iuk} phi(u - i/2)] / (u^2 + 1/4) du
 * and the density of x_T from q(x) = (1 / pi) int_0^inf Re[e^{-iux} phi(u)] du.
 */
import { impliedVol } from './blackScholes'
import { legendreGauss } from './gaussLegendre'

/** Writes phi(uRe + i uIm) as [re, im] into out. */
export type CharFn = (uRe: number, uIm: number, out: Float64Array) => void

export interface Quad {
  nodes: Float64Array
  weights: Float64Array
}

const quadCache = new Map<string, Quad>()

function panels(key: string, edges: number[], counts: number[]): Quad {
  const hit = quadCache.get(key)
  if (hit) return hit
  const n = counts.reduce((s, v) => s + v, 0)
  const nodes = new Float64Array(n)
  const weights = new Float64Array(n)
  let o = 0
  counts.forEach((m, p) => {
    const { x, w } = legendreGauss(m)
    const lo = edges[p]
    const hi = edges[p + 1]
    for (let i = 0; i < m; i++) {
      nodes[o] = lo + 0.5 * (hi - lo) * (x[i] + 1)
      weights[o++] = 0.5 * (hi - lo) * w[i]
    }
  })
  const q = { nodes, weights }
  if (quadCache.size > 256) quadCache.clear()
  quadCache.set(key, q)
  return q
}

/**
 * Pricing rule: Gauss-Legendre panels on [0, 2], [2, 12/a], [12/a, 60/a] (24, 96, 64 nodes)
 * with a = vol_atm sqrt(tau) of the market slice. The first panel resolves the Lewis kernel
 * near u = 0, the last the slow exponential decay of phi at large vol-of-vol.
 */
export function sliceNodes(atmVol: number, tau: number): Quad {
  const a = atmVol * Math.sqrt(tau)
  return panels(`p:${atmVol}:${tau}`, [0, 2, 12 / a, 60 / a], [24, 96, 64])
}

/** Density rule: [0, 2] then 14 equal panels of 48 nodes up to 60/a, for |x| up to ~8a. */
export function densityNodes(atmVol: number, tau: number): Quad {
  const a = atmVol * Math.sqrt(tau)
  const edges = [0, ...Array.from({ length: 15 }, (_, i) => 2 + ((60 / a - 2) * i) / 14)]
  return panels(`d:${atmVol}:${tau}`, edges, [24, ...new Array<number>(14).fill(48)])
}

/** Strike-independent part of an integral, pre-multiplied by the weights. */
export interface Kernel {
  nodes: Float64Array
  re: Float64Array
  im: Float64Array
}

const tmp = new Float64Array(2)

/** Lewis kernel: w Re/Im phi(u - i/2) / (u^2 + 1/4). */
export function lewisKernel(cf: CharFn, q: Quad): Kernel {
  const n = q.nodes.length
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let j = 0; j < n; j++) {
    const u = q.nodes[j]
    cf(u, -0.5, tmp)
    const s = q.weights[j] / (u * u + 0.25)
    re[j] = s * tmp[0]
    im[j] = s * tmp[1]
  }
  return { nodes: q.nodes, re, im }
}

/** Density kernel: w Re/Im phi(u). */
export function densityKernel(cf: CharFn, q: Quad): Kernel {
  const n = q.nodes.length
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let j = 0; j < n; j++) {
    cf(q.nodes[j], 0, tmp)
    re[j] = q.weights[j] * tmp[0]
    im[j] = q.weights[j] * tmp[1]
  }
  return { nodes: q.nodes, re, im }
}

/** sum_j Re[e^{-i u_j x} (re_j + i im_j)] */
function fourierSum(kern: Kernel, x: number): number {
  const { nodes, re, im } = kern
  let s = 0
  for (let j = 0; j < nodes.length; j++) {
    const ph = nodes[j] * x
    s += Math.cos(ph) * re[j] + Math.sin(ph) * im[j]
  }
  return s
}

/** Undiscounted OTM price per unit forward at log-moneyness k: put below the forward, else call. */
export function otmPrice(kern: Kernel, k: number): number {
  const call = 1 - (Math.exp(0.5 * k) * fourierSum(kern, k)) / Math.PI
  return k < 0 ? call - 1 + Math.exp(k) : call
}

/** Risk-neutral density of x_T at x. */
export function density(kern: Kernel, x: number): number {
  return fourierSum(kern, x) / Math.PI
}

/** Black implied vol of an OTM price per unit forward (NaN when not bracketed). */
export function ivOtm(price: number, k: number, tau: number, xtol = 1e-12): number {
  return impliedVol(price, 1, Math.exp(k), 0, 0, tau, k < 0 ? 'put' : 'call', 1e-4, 5, xtol)
}
