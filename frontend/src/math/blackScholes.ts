/** Black-Scholes-Merton pricing and implied-vol inversion (port of models/black_scholes.py). */
import { brentq } from './brent'
import { normCdf, normPdf } from './normal'

export type OptionType = 'call' | 'put'

export function bsPrice(
  spot: number,
  strike: number,
  rate: number,
  div: number,
  tau: number,
  sigma: number,
  type: OptionType = 'call',
): number {
  if (tau <= 0) return type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0)
  if (sigma === 0) {
    const fwd = spot * Math.exp((rate - div) * tau)
    const intrinsic = type === 'call' ? Math.max(fwd - strike, 0) : Math.max(strike - fwd, 0)
    return Math.exp(-rate * tau) * intrinsic
  }
  const sqrtT = Math.sqrt(tau)
  const d1 = (Math.log(spot / strike) + (rate - div + 0.5 * sigma * sigma) * tau) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  const discS = spot * Math.exp(-div * tau)
  const discK = strike * Math.exp(-rate * tau)
  if (type === 'call') return discS * normCdf(d1) - discK * normCdf(d2)
  return discK * normCdf(-d2) - discS * normCdf(-d1)
}

export function bsVega(
  spot: number,
  strike: number,
  rate: number,
  div: number,
  tau: number,
  sigma: number,
): number {
  if (tau === 0 || sigma === 0) return 0
  const sqrtT = Math.sqrt(tau)
  const d1 = (Math.log(spot / strike) + (rate - div + 0.5 * sigma * sigma) * tau) / (sigma * sqrtT)
  return spot * Math.exp(-div * tau) * normPdf(d1) * sqrtT
}

/**
 * Invert a price to its Black-Scholes implied vol with Brent on [lower, upper].
 * Returns NaN when the price is not bracketed (below intrinsic / above the cap).
 */
export function impliedVol(
  price: number,
  spot: number,
  strike: number,
  rate: number,
  div: number,
  tau: number,
  type: OptionType = 'call',
  lower = 1e-4,
  upper = 5,
  xtol = 1e-10,
): number {
  if (!Number.isFinite(price) || price <= 0 || tau <= 0) return Number.NaN
  const f = (s: number) => bsPrice(spot, strike, rate, div, tau, s, type) - price
  const fLo = f(lower)
  const fHi = f(upper)
  if (fLo * fHi > 0) return Number.NaN
  return brentq(f, lower, upper, xtol)
}
