import { describe, expect, it } from 'vitest'
import market from '../data/market.json'
import { hestonPrice } from './heston'
import { fitHmm } from './hmm'
import { moments, simulate } from './montecarlo'
import type { HestonParams } from './types'

const P: HestonParams = { kappa: 2, theta: 0.04, sigma: 0.5, rho: -0.7, v0: 0.04 }
const M = { spot: 100, rate: 0.03, div: 0 }

describe('Heston QE Monte Carlo', () => {
  const res = simulate({ params: P, market: M, horizon: 1, steps: 100, paths: 20000, seed: 7, samples: 0, quantiles: [0.5] })
  it('is a martingale: E[S_T] = forward within 3 standard errors', () => {
    const fwd = M.spot * Math.exp(M.rate)
    expect(Math.abs(res.meanST - fwd)).toBeLessThan(3 * res.seST + 0.02)
  })
  it('reprices an ATM call against the Fourier price', () => {
    let pay = 0
    let pay2 = 0
    for (const r of res.terminal) {
      const x = Math.max(M.spot * Math.exp(r) - 100, 0)
      pay += x
      pay2 += x * x
    }
    const n = res.terminal.length
    const mc = (Math.exp(-M.rate) * pay) / n
    const se = (Math.exp(-M.rate) * Math.sqrt(pay2 / n - (pay / n) ** 2)) / Math.sqrt(n)
    const ref = hestonPrice(P, M.spot, 100, M.rate, M.div, 1)
    expect(Math.abs(mc - ref)).toBeLessThan(3 * se + 0.03)
  })
  it('produces negative skew for negative rho', () => {
    expect(moments(res.terminal).skew).toBeLessThan(-0.3)
  })
})

describe('browser Baum-Welch HMM', () => {
  const X = market.features.z.map((col) => Float64Array.from(col as number[]))
  it('reproduces the hmmlearn regime path for K = 3', () => {
    const fit = fitHmm(X, 3)
    const ref = market.series.regime
    let agree = 0
    ref.forEach((s, t) => (agree += +(s === fit.states[t])))
    const share = agree / ref.length
    console.info(`[hmm] K=3 agreement with hmmlearn Viterbi path: ${(share * 100).toFixed(1)}%, logL=${fit.logLik.toFixed(1)}`)
    expect(share).toBeGreaterThan(0.99)
  })
  it('fits K = 2 and K = 4 with ordered, sticky states', () => {
    for (const K of [2, 4]) {
      const fit = fitHmm(X, K)
      for (let k = 1; k < K; k++) expect(fit.means[k][0]).toBeGreaterThan(fit.means[k - 1][0] - 1e-9)
      for (let k = 0; k < K; k++) expect(fit.transmat[k][k]).toBeGreaterThan(0.8)
    }
  })
})
