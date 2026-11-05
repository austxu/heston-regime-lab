/**
 * Parity with the Python research code. Fixtures are produced by
 * `scripts/make_parity_fixtures.py` from models/heston.py, models/black_scholes.py and
 * calibration/*.py; regenerate them whenever the Python math changes.
 */
import { describe, expect, it } from 'vitest'
import fx from './__fixtures__/parity.json'
import { bsPrice, bsVega, impliedVol, type OptionType } from './blackScholes'
import { calibrate } from './calibrate'
import { gaussLegendreNodes } from './gaussLegendre'
import { charFn, hestonPrice } from './heston'
import { hestonImpliedVols } from './surface'
import { PARAM_NAMES, type HestonParams } from './types'

const { spot, rate, div } = fx.market
const params = fx.params as Record<string, HestonParams>
const stats = { price: 0, iv: 0, phi: 0 }

describe('Gauss-Legendre quadrature', () => {
  it('matches numpy.polynomial.legendre.leggauss mapped onto (0, U)', () => {
    const { nodes, weights } = gaussLegendreNodes(fx.config.nNodes, fx.config.upperLimit)
    fx.gl.nodes.forEach((x, i) => expect(Math.abs(nodes[i] - x)).toBeLessThan(1e-12))
    fx.gl.weights.forEach((x, i) => expect(Math.abs(weights[i] - x)).toBeLessThan(1e-12))
  })
})

describe('Heston characteristic function (little Heston trap)', () => {
  it('matches Python at real and shifted (u - i) arguments', () => {
    const out = new Float64Array(2)
    for (const row of fx.charfn) {
      row.u.forEach(([re, im], i) => {
        charFn(re, im, params[row.set], spot, rate, div, row.tau, out)
        const [pr, pi] = row.phi[i]
        const err = Math.hypot(out[0] - pr, out[1] - pi) / Math.max(1, Math.hypot(pr, pi))
        stats.phi = Math.max(stats.phi, err)
        expect(err).toBeLessThan(1e-12)
      })
    }
  })
  it('is a martingale: phi(-i) = forward', () => {
    const out = new Float64Array(2)
    for (const p of Object.values(params)) {
      charFn(0, -1, p, spot, rate, div, 2, out)
      expect(out[0]).toBeCloseTo(spot * Math.exp((rate - div) * 2), 10)
      expect(Math.abs(out[1])).toBeLessThan(1e-10)
    }
  })
})

describe('Gil-Pelaez pricing', () => {
  it('matches heston_price to ~1e-11 (far below the ~1e-8 truncation floor)', () => {
    for (const row of fx.prices) {
      fx.strikes.forEach((k, i) => {
        for (const type of ['call', 'put'] as const) {
          const ref = row[type][i]
          const got = hestonPrice(params[row.set], spot, k, rate, div, row.tau, type)
          const err = Math.abs(got - ref)
          stats.price = Math.max(stats.price, err)
          expect(err).toBeLessThan(1e-11 + 1e-11 * ref)
        }
      })
    }
  })
  it('matches heston_implied_vols (OTM-leg inversion) to 1e-9 vol wherever the OTM price exceeds 1e-4', () => {
    for (const row of fx.prices) {
      const q = { spot, rate, div, strike: fx.strikes, maturity: fx.strikes.map(() => row.tau) }
      const iv = hestonImpliedVols(params[row.set], q)
      row.iv.forEach((ref, i) => {
        const otm = fx.strikes[i] >= spot * Math.exp((rate - div) * row.tau) ? row.call[i] : row.put[i]
        if (ref === null || otm < 1e-4) return
        const err = Math.abs(iv[i] - ref)
        stats.iv = Math.max(stats.iv, err)
        expect(err).toBeLessThan(1e-9)
      })
    }
  })
})

describe('Black-Scholes', () => {
  it('prices, vegas and implied vols match models/black_scholes.py', () => {
    for (const r of fx.bs) {
      const type = r.type as OptionType
      expect(Math.abs(bsPrice(spot, r.k, rate, div, r.tau, r.sigma, type) - r.price)).toBeLessThan(1e-12 + 1e-12 * r.price)
      expect(Math.abs(bsVega(spot, r.k, rate, div, r.tau, r.sigma) - r.vega)).toBeLessThan(1e-11 + 1e-11 * r.vega)
      const iv = impliedVol(r.price, spot, r.k, rate, div, r.tau, type)
      if (r.iv === null) expect(Number.isNaN(iv)).toBe(true)
      else expect(Math.abs(iv - r.iv)).toBeLessThan(1e-9)
    }
  })
})

describe('calibration round trip (mirrors calibration/validators.py)', () => {
  const rt = fx.roundTrip
  const result = calibrate({ spot: rt.spot, rate: rt.rate, div: rt.div, strike: rt.strike, maturity: rt.maturity, iv: rt.iv })
  it('recovers the ground-truth parameters within 1%', () => {
    for (const n of PARAM_NAMES) {
      const rel = Math.abs(result.params[n] - rt.truth[n]) / Math.abs(rt.truth[n])
      expect(rel, n).toBeLessThan(0.01)
    }
    expect(result.rmseIv).toBeLessThan(1e-5)
  })
  it('reaches a loss no worse than the Python L-BFGS-B optimum', () => {
    expect(result.loss).toBeLessThanOrEqual(rt.python.loss * 1.0001 + 1e-14)
    console.info(
      `[parity] max |dphi|=${stats.phi.toExponential(1)} max |dprice|=${stats.price.toExponential(1)} ` +
        `max |dIV|=${stats.iv.toExponential(1)} | round trip: TS LM loss=${result.loss.toExponential(2)} ` +
        `(${result.iteration} it, ${result.nfev} fev, ${result.ms.toFixed(0)} ms) vs Python L-BFGS-B ` +
        `loss=${rt.python.loss.toExponential(2)} (${rt.python.nit} it, ${rt.python.nfev} fev, ${rt.python.seconds}s)`,
    )
  })
})
