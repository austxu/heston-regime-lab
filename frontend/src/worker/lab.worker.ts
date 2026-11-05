/// <reference lib="webworker" />
/** All numerics run here so sliders, drags and animations on the main thread stay smooth. */
import { calibrateSteps } from '../math/calibrate'
import { fitHmm } from '../math/hmm'
import { simulate } from '../math/montecarlo'
import { surfaceGrid } from '../math/surface'
import type { Request, Response } from './protocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope
const cancelled = new Set<number>()
const post = (msg: Response, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer)
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

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
    case 'calibrate': {
      const steps = calibrateSteps(msg.quotes, { initial: msg.initial })
      for (;;) {
        const s = steps.next()
        if (cancelled.has(msg.id)) {
          cancelled.delete(msg.id)
          return
        }
        if (s.done) {
          post({ type: 'calib-done', id: msg.id, result: s.value })
          return
        }
        const it = s.value
        const grids = msg.grids.map((g) => surfaceGrid(it.params, msg.quotes, g, { xtol: 1e-8 }))
        const modelIv = Float64Array.from(it.modelIv)
        const surfaces = grids.map((g) => g.iv)
        const flags = grids.map((g) => g.flag)
        post(
          { type: 'calib-iter', id: msg.id, iteration: it.iteration, loss: it.loss, params: it.params, nfev: it.nfev, modelIv, surfaces, flags },
          [...surfaces.map((a) => a.buffer), ...flags.map((a) => a.buffer), modelIv.buffer],
        )
        await tick()
      }
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
