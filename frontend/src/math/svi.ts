/** Raw SVI slice evaluation, butterfly diagnostic g(k) and density (port of models/svi.py). */
export interface Svi {
  a: number
  b: number
  rho: number
  m: number
  s: number
}

/** Total variance w and its first two derivatives at k. */
export function sviDerivs(k: number, p: Svi): [number, number, number] {
  const d = k - p.m
  const r = Math.sqrt(d * d + p.s * p.s)
  return [p.a + p.b * (p.rho * d + r), p.b * (p.rho + d / r), (p.b * p.s * p.s) / (r * r * r)]
}

export const sviW = (k: number, p: Svi) => sviDerivs(k, p)[0]
export const sviVol = (k: number, tau: number, p: Svi) => Math.sqrt(Math.max(sviW(k, p), 0) / tau)

/** Gatheral's g(k): negative values flag butterfly arbitrage. */
export function sviG(k: number, p: Svi): number {
  const [w, w1, w2] = sviDerivs(k, p)
  return (1 - (k * w1) / (2 * w)) ** 2 - 0.25 * w1 * w1 * (1 / w + 0.25) + 0.5 * w2
}

/** Risk-neutral density of x_T = ln(F_T / F_0) implied by the slice. */
export function sviDensity(k: number, p: Svi): number {
  const w = sviW(k, p)
  const sw = Math.sqrt(w)
  const dm = -k / sw - 0.5 * sw
  return (sviG(k, p) / Math.sqrt(2 * Math.PI * w)) * Math.exp(-0.5 * dm * dm)
}
