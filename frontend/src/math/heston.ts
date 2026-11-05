/**
 * Heston (1993) characteristic function and Gil-Pelaez / Gauss-Legendre pricing.
 * A faithful port of models/heston.py: the "little Heston trap" (g2) formulation of
 * Albrecher et al. (2007), the same (n_nodes, U) truncation, the same strike-vectorised
 * evaluation and the same no-arbitrage clipping.
 */
import { gaussLegendreNodes } from './gaussLegendre'
import { QUAD, type HestonParams } from './types'

/** phi(u) = E[exp(i u ln S_T)] for complex u = (uRe + i uIm). Writes [re, im] into out. */
export function charFn(
  uRe: number,
  uIm: number,
  p: HestonParams,
  spot: number,
  rate: number,
  div: number,
  tau: number,
  out: Float64Array | number[],
): void {
  const { kappa, theta, sigma, rho, v0 } = p
  // iu = i * u
  const iuRe = -uIm
  const iuIm = uRe
  if (tau === 0) {
    const ls = Math.log(spot)
    const m = Math.exp(iuRe * ls)
    out[0] = m * Math.cos(iuIm * ls)
    out[1] = m * Math.sin(iuIm * ls)
    return
  }
  const rs = rho * sigma
  const s2 = sigma * sigma
  // xi = kappa - rho sigma iu
  const xiRe = kappa - rs * iuRe
  const xiIm = -rs * iuIm
  // a = rho sigma iu - kappa ; a^2
  const aRe = rs * iuRe - kappa
  const aIm = rs * iuIm
  // u^2
  const u2Re = uRe * uRe - uIm * uIm
  const u2Im = 2 * uRe * uIm
  // disc = a^2 + sigma^2 (iu + u^2)
  const dRe0 = aRe * aRe - aIm * aIm + s2 * (iuRe + u2Re)
  const dIm0 = 2 * aRe * aIm + s2 * (iuIm + u2Im)
  // d = sqrt(disc), principal branch, in the cancellation-free form (as numpy/C99 csqrt).
  const r = Math.hypot(dRe0, dIm0)
  let dRe: number
  let dIm: number
  if (dRe0 >= 0) {
    dRe = Math.sqrt((r + dRe0) / 2)
    dIm = dRe === 0 ? 0 : dIm0 / (2 * dRe)
  } else {
    const t = Math.sqrt((r - dRe0) / 2)
    dRe = Math.abs(dIm0) / (2 * t)
    dIm = dIm0 < 0 || Object.is(dIm0, -0) ? -t : t
  }
  // xm = xi - d, xp = xi + d
  const xmRe = xiRe - dRe
  const xmIm = xiIm - dIm
  const xpRe = xiRe + dRe
  const xpIm = xiIm + dIm
  // g2 = xm / xp
  const den = xpRe * xpRe + xpIm * xpIm
  const gRe = (xmRe * xpRe + xmIm * xpIm) / den
  const gIm = (xmIm * xpRe - xmRe * xpIm) / den
  // e = exp(-d tau)
  const em = Math.exp(-dRe * tau)
  const eRe = em * Math.cos(-dIm * tau)
  const eIm = em * Math.sin(-dIm * tau)
  // ge = g2 * e
  const geRe = gRe * eRe - gIm * eIm
  const geIm = gRe * eIm + gIm * eRe
  // n1 = 1 - g2 e ; n0 = 1 - g2
  const n1Re = 1 - geRe
  const n1Im = -geIm
  const n0Re = 1 - gRe
  const n0Im = -gIm
  // q = n1 / n0 ; log(q)
  const n0d = n0Re * n0Re + n0Im * n0Im
  const qRe = (n1Re * n0Re + n1Im * n0Im) / n0d
  const qIm = (n1Im * n0Re - n1Re * n0Im) / n0d
  const lqRe = Math.log(Math.hypot(qRe, qIm))
  const lqIm = Math.atan2(qIm, qRe)
  // C = (kappa theta / sigma^2) [ xm tau - 2 log q ]
  const kt = (kappa * theta) / s2
  const cRe = kt * (xmRe * tau - 2 * lqRe)
  const cIm = kt * (xmIm * tau - 2 * lqIm)
  // D = xm / sigma^2 * (1 - e) / n1
  const oeRe = 1 - eRe
  const oeIm = -eIm
  const n1d = n1Re * n1Re + n1Im * n1Im
  const fRe = (oeRe * n1Re + oeIm * n1Im) / n1d
  const fIm = (oeIm * n1Re - oeRe * n1Im) / n1d
  const DRe = (xmRe * fRe - xmIm * fIm) / s2
  const DIm = (xmRe * fIm + xmIm * fRe) / s2
  // drift = iu (ln S + (r - q) tau)
  const lf = Math.log(spot) + (rate - div) * tau
  const eRe2 = cRe + DRe * v0 + iuRe * lf
  const eIm2 = cIm + DIm * v0 + iuIm * lf
  const mag = Math.exp(eRe2)
  out[0] = mag * Math.cos(eIm2)
  out[1] = mag * Math.sin(eIm2)
}

/**
 * Per-maturity Fourier state: the strike-independent part of the Gil-Pelaez integrands,
 * pre-multiplied by the quadrature weights. Price any strike in O(n_nodes) afterwards.
 */
export interface MaturityKernel {
  tau: number
  nodes: Float64Array
  a2: Float64Array // w Im(phi(u)) / u
  b2: Float64Array // w Re(phi(u)) / u
  a1: Float64Array // w Im(phi(u - i)) / (u F)
  b1: Float64Array // w Re(phi(u - i)) / (u F)
  forward: number
}

const tmp = new Float64Array(2)

export function maturityKernel(
  p: HestonParams,
  spot: number,
  rate: number,
  div: number,
  tau: number,
  nNodes: number = QUAD.nNodes,
  upper: number = QUAD.upperLimit,
): MaturityKernel {
  const { nodes, weights } = gaussLegendreNodes(nNodes, upper)
  const n = nodes.length
  const a2 = new Float64Array(n)
  const b2 = new Float64Array(n)
  const a1 = new Float64Array(n)
  const b1 = new Float64Array(n)
  const forward = spot * Math.exp((rate - div) * tau)
  for (let j = 0; j < n; j++) {
    const u = nodes[j]
    const w = weights[j]
    charFn(u, 0, p, spot, rate, div, tau, tmp)
    a2[j] = (w * tmp[1]) / u
    b2[j] = (w * tmp[0]) / u
    charFn(u, -1, p, spot, rate, div, tau, tmp)
    a1[j] = (w * tmp[1]) / (u * forward)
    b1[j] = (w * tmp[0]) / (u * forward)
  }
  return { tau, nodes, a2, b2, a1, b1, forward }
}

/**
 * Heston call price from a maturity kernel (unclipped). Re[e^{-iu lnK} phi / (iu)] equals
 * Im(e^{-iu lnK} phi) / u, so with e^{-iu lnK} = cos - i sin the integrand is
 * (cos * Im phi - sin * Re phi) / u.
 */
export function kernelCall(k: MaturityKernel, spot: number, strike: number, rate: number, div: number) {
  const { nodes, a2, b2, a1, b1, tau } = k
  const lk = Math.log(strike)
  let s2 = 0
  let s1 = 0
  for (let j = 0; j < nodes.length; j++) {
    const ph = nodes[j] * lk
    const c = Math.cos(ph)
    const s = Math.sin(ph)
    s2 += c * a2[j] - s * b2[j]
    s1 += c * a1[j] - s * b1[j]
  }
  const p2 = 0.5 + s2 / Math.PI
  const p1 = 0.5 + s1 / Math.PI
  return spot * Math.exp(-div * tau) * p1 - strike * Math.exp(-rate * tau) * p2
}

/** Clipped European price, mirroring heston_price's no-arbitrage clipping. */
export function hestonPrice(
  p: HestonParams,
  spot: number,
  strike: number,
  rate: number,
  div: number,
  tau: number,
  type: 'call' | 'put' = 'call',
  kernel?: MaturityKernel,
): number {
  if (tau === 0) return type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0)
  const k = kernel ?? maturityKernel(p, spot, rate, div, tau)
  const call = kernelCall(k, spot, strike, rate, div)
  const discS = spot * Math.exp(-div * tau)
  const discK = strike * Math.exp(-rate * tau)
  if (type === 'call') return Math.min(Math.max(call, Math.max(discS - discK, 0)), discS)
  const put = call - discS + discK
  return Math.min(Math.max(put, Math.max(discK - discS, 0)), discK)
}
