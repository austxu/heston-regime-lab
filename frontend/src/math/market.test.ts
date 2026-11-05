/**
 * Real-market models: parity with models/fourier.py, bates.py, double_heston.py and svi.py
 * (fixtures from scripts/make_parity_fixtures.py), and the browser LM fit of the baked SPX
 * snapshot against the offline scipy optimum (frontend/src/data/spx.json).
 */
import { describe, expect, it } from 'vitest'
import spx from '../data/spx.json'
import fx from './__fixtures__/market.json'
import { density, densityKernel, densityNodes, ivOtm, lewisKernel, otmPrice, sliceNodes } from './fourier'
import { calibrateMarketSteps, fitStats, modelIvs, moments, modelDensity } from './market'
import { MODELS, type ModelId } from './models'
import { sviDensity, sviG, sviW } from './svi'

const ids = Object.keys(fx.models) as ModelId[]
const worst = { phi: 0, price: 0, iv: 0, dens: 0 }

describe('market quadrature', () => {
  it('matches the Python composite Gauss-Legendre panels', () => {
    const q = sliceNodes(fx.nodes.atm, fx.nodes.tau)
    expect(q.nodes.length).toBe(fx.nodes.nodes.length)
    fx.nodes.nodes.forEach((x, i) => expect(Math.abs(q.nodes[i] - x)).toBeLessThan(1e-11 * Math.max(1, x)))
    fx.nodes.weights.forEach((x, i) => expect(Math.abs(q.weights[i] - x)).toBeLessThan(1e-11 * Math.max(1, x)))
  })
})

describe.each(ids)('%s', (id) => {
  const m = fx.models[id]
  it('characteristic function matches Python', () => {
    const out = new Float64Array(2)
    for (const s of m.slices) {
      const cf = MODELS[id].cf(m.params, s.tau)
      fx.u.forEach(([re, im], i) => {
        cf(re, im, out)
        const [pr, pi] = s.phi[i]
        const err = Math.hypot(out[0] - pr, out[1] - pi) / Math.max(1e-3, Math.hypot(pr, pi))
        worst.phi = Math.max(worst.phi, err)
        expect(err).toBeLessThan(1e-11)
      })
    }
  })
  it('Lewis prices, implied vols and densities match Python', () => {
    for (const s of m.slices) {
      const q = sliceNodes(s.atm, s.tau)
      const cf = MODELS[id].cf(m.params, s.tau)
      const lk = lewisKernel(cf, q)
      const dk = densityKernel(cf, densityNodes(s.atm, s.tau))
      s.k.forEach((k, i) => {
        const p = otmPrice(lk, k)
        worst.price = Math.max(worst.price, Math.abs(p - s.otm[i]))
        expect(Math.abs(p - s.otm[i])).toBeLessThan(1e-12)
        const ref = s.iv[i]
        if (ref === null) return
        const iv = ivOtm(p, k, s.tau)
        worst.iv = Math.max(worst.iv, Math.abs(iv - ref))
        expect(Math.abs(iv - ref)).toBeLessThan(1e-9)
      })
      s.x.forEach((x, i) => {
        const err = Math.abs(density(dk, x) - s.density[i]) / Math.max(1, Math.abs(s.density[i]))
        worst.dens = Math.max(worst.dens, err)
        expect(err).toBeLessThan(1e-11)
      })
    }
  })
  it('is a martingale with a unit-mass density', () => {
    const tau = 0.5
    const out = new Float64Array(2)
    MODELS[id].cf(m.params, tau)(0, -1, out)
    expect(Math.abs(out[0] - 1)).toBeLessThan(1e-12)
    expect(Math.abs(out[1])).toBeLessThan(1e-12)
    // [-12a, 6a] with a = 0.2 sqrt(tau): the fitted models put a few tenths of a percent
    // of mass in the far left tail beyond it.
    const a = 0.2 * Math.sqrt(tau)
    const xs = Array.from({ length: 2001 }, (_, i) => -12 * a + (18 * a * i) / 2000)
    const q = modelDensity(id, m.params, tau, 0.2, xs)
    const mo = moments(xs, q)
    expect(mo.mass).toBeGreaterThan(0.99)
    expect(mo.mass).toBeLessThan(1 + 1e-6)
    expect(Math.min(...q)).toBeGreaterThan(-1e-6)
  })
})

describe('SVI', () => {
  it('w, g and density match Python', () => {
    const p = fx.svi.params
    fx.svi.k.forEach((k, i) => {
      expect(Math.abs(sviW(k, p) - fx.svi.w[i])).toBeLessThan(1e-14)
      expect(Math.abs(sviG(k, p) - fx.svi.g[i])).toBeLessThan(1e-12)
      expect(Math.abs(sviDensity(k, p) - fx.svi.density[i])).toBeLessThan(1e-12)
    })
  })
})

describe('calibration to the real SPX snapshot', () => {
  const slices = spx.slices
  it.each(ids)('%s: browser LM reaches the scipy optimum from the same start', (id) => {
    const py = spx.fits[id]
    const steps = calibrateMarketSteps(id, slices, py.start)
    let s = steps.next()
    while (!s.done) s = steps.next()
    const r = s.value
    // Same objective, different optimiser (trust-region reflective vs LM): equal or better.
    expect(r.rmse).toBeLessThan(py.rmse * (1 + 2e-3))
    const st = fitStats(modelIvs(id, r.params, slices), slices)
    expect(Math.abs(st.rmse - r.rmse)).toBeLessThan(1e-9)
    console.log(
      `${id}: browser rmse ${(r.rmse * 100).toFixed(4)} vp (python ${(py.rmse * 100).toFixed(4)}), inside ${(r.inside * 100).toFixed(1)}%, ${r.iteration} it, ${r.nfev} fev, ${r.ms.toFixed(0)} ms`,
    )
  }, 120_000)
  it('reports parity numbers', () => {
    console.log(`market parity: phi ${worst.phi.toExponential(1)}, price ${worst.price.toExponential(1)}, iv ${worst.iv.toExponential(1)}, density ${worst.dens.toExponential(1)}`)
  })
})
