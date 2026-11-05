/// <reference lib="webworker" />
/** All numerics run here so sliders, drags and animations on the main thread stay smooth. */
import { fitHmm } from '../math/hmm'
import { calibrateMarketSteps, fitStats, modelDensity, modelIvs, smileCurves, surfaceZ } from '../math/market'
import type { MarketSlice } from '../math/market'
import type { ModelId } from '../math/models'
import { simulate } from '../math/montecarlo'
import { surfaceGrid } from '../math/surface'
import type { MarketFrame, MarketView, Request, Response } from './protocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope
const cancelled = new Set<number>()
const post = (msg: Response, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer)
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

function frame(model: ModelId, p: number[], slices: MarketSlice[], view: MarketView, modelIv?: Float64Array): MarketFrame {
  const { iv, flag } = surfaceZ(model, p, view.taus, view.xs, view.atms)
  return { modelIv: modelIv ?? modelIvs(model, p, slices), surface: iv, flag, smiles: smileCurves(model, p, slices, view.smileKs) }
}
const frameBuffers = (f: MarketFrame) => [f.modelIv.buffer, f.surface.buffer, f.flag.buffer, f.smiles.buffer]

ctx.onmessage = async (ev: MessageEvent<Request>) => {
  const msg = ev.data
  switch (msg.type) {
    case 'cancel':
      cancelled.add(msg.id)
      return
    case 'surface': {
      const t0 = performance.now()
      // Draft quality (while a slider is dragged) uses fewer Fourier nodes and a looser IV tolerance.
      const opts = msg.quality === 'draft' ? { nNodes: 64, xtol: 1e-6 } : { xtol: 1e-8 }
      const { iv, flag } = surfaceGrid(msg.params, msg.market, msg.grid, opts)
      post({ type: 'surface', id: msg.id, iv, flag, ms: performance.now() - t0 }, [iv.buffer, flag.buffer])
      return
    }
    case 'market-eval': {
      const f = frame(msg.model, msg.params, msg.slices, msg.view)
      post({ type: 'market-eval', id: msg.id, ...f, stats: fitStats(f.modelIv, msg.slices) }, frameBuffers(f))
      return
    }
    case 'market-calibrate': {
      const steps = calibrateMarketSteps(msg.model, msg.slices, msg.start)
      for (;;) {
        const s = steps.next()
        if (cancelled.has(msg.id)) {
          cancelled.delete(msg.id)
          return
        }
        if (s.done) {
          post({ type: 'market-done', id: msg.id, result: s.value })
          return
        }
        const it = s.value
        const f = frame(msg.model, it.params, msg.slices, msg.view, Float64Array.from(it.modelIv))
        post({ type: 'market-iter', id: msg.id, iteration: it.iteration, loss: it.loss, params: it.params, nfev: it.nfev, ...f }, frameBuffers(f))
        await tick()
      }
    }
    case 'surface-batch': {
      const surfaces = msg.params.map((p) => surfaceZ(msg.model, p, msg.view.taus, msg.view.xs, msg.view.atms).iv)
      post({ type: 'surface-batch', id: msg.id, surfaces }, surfaces.map((a) => a.buffer))
      return
    }
    case 'densities': {
      const t0 = performance.now()
      const q = msg.fits.map((f) => msg.slices.map((s, i) => modelDensity(f.model, f.params, s.tau, s.atmVol, msg.xs[i])))
      post({ type: 'densities', id: msg.id, q, ms: performance.now() - t0 }, q.flat().map((a) => a.buffer))
      return
    }
    case 'paths': {
      post({ type: 'paths', id: msg.id, result: simulate(msg.req) })
      return
    }
    case 'hmm': {
      const t0 = performance.now()
      const X = msg.z.map((c) => Float64Array.from(c))
      post({ type: 'hmm', id: msg.id, fit: fitHmm(X, msg.K), ms: performance.now() - t0 })
      return
    }
  }
}
