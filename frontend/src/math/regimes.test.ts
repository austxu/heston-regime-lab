/**
 * Browser LM vs Python L-BFGS-B on the identical noisy regime surfaces baked into
 * src/data/market.json by scripts/bake_market_data.py.
 */
import { describe, expect, it } from 'vitest'
import market from '../data/market.json'
import { calibrate } from './calibrate'
import { PARAM_NAMES } from './types'

describe.each(market.regimes.map((r) => [r.name, r] as const))('regime %s', (_name, regime) => {
  const q = regime.quotes
  const res = calibrate({ spot: q.spot, rate: q.rate, div: 0, strike: q.strike, maturity: q.maturity, iv: q.iv })
  const py = regime.python

  it('matches or beats the Python optimum on the same quotes', () => {
    expect(res.loss).toBeLessThanOrEqual(py.loss * 1.001)
    const rmseDiff = Math.abs(res.rmseIv - py.rmseIv)
    expect(rmseDiff).toBeLessThan(1e-4) // 0.01 vol points
  })

  it('lands on the same parameters as Python', () => {
    for (const n of PARAM_NAMES) {
      const rel = Math.abs(res.params[n] - py.params[n]) / Math.max(Math.abs(py.params[n]), 1e-3)
      expect(rel, n).toBeLessThan(0.02)
    }
    console.info(
      `[regime ${regime.name}] TS loss=${res.loss.toExponential(4)} rmse=${(res.rmseIv * 100).toFixed(4)}vp ` +
        `(${res.iteration} it, ${res.nfev} fev, ${res.ms.toFixed(0)} ms) | Python loss=${py.loss.toExponential(4)} ` +
        `rmse=${(py.rmseIv * 100).toFixed(4)}vp (${py.nit} it, ${py.nfev} fev, ${py.seconds}s) | max rel param diff=` +
        Math.max(...PARAM_NAMES.map((n) => Math.abs(res.params[n] - py.params[n]) / Math.abs(py.params[n]))).toExponential(1),
    )
  })
})
