/** Thin promise/stream wrapper around the lab worker, with latest-wins scheduling. */
import type { Request, Response } from './protocol'

type Listener = (msg: Response) => void
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

let worker: Worker | null = null
let nextId = 1
const listeners = new Map<number, Listener>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./lab.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<Response>) => listeners.get(ev.data.id)?.(ev.data)
  }
  return worker
}

/** Send a request; `onMessage` receives every response for it until `dispose` is called. */
export function send(req: DistributiveOmit<Exclude<Request, { type: 'cancel' }>, 'id'>, onMessage: Listener) {
  const id = nextId++
  listeners.set(id, onMessage)
  getWorker().postMessage({ ...req, id } as Request)
  return {
    id,
    dispose: () => listeners.delete(id),
    cancel: () => {
      listeners.delete(id)
      getWorker().postMessage({ type: 'cancel', id } satisfies Request)
    },
  }
}

/** One-shot request as a promise. */
export function request<T extends Response['type']>(
  req: DistributiveOmit<Exclude<Request, { type: 'cancel' }>, 'id'>,
  type: T,
): Promise<Extract<Response, { type: T }>> {
  return new Promise((resolve) => {
    const h = send(req, (msg) => {
      if (msg.type === type) {
        h.dispose()
        resolve(msg as Extract<Response, { type: T }>)
      }
    })
  })
}

/**
 * Latest-wins channel: while a request is in flight, newer requests replace each other in a
 * single pending slot, so dragging a slider never builds a queue in the worker.
 */
export function latestWins<Q, R>(run: (q: Q) => Promise<R>, onResult: (r: R, q: Q) => void) {
  let busy = false
  let pending: Q | null = null
  const pump = async (q: Q) => {
    busy = true
    try {
      onResult(await run(q), q)
    } finally {
      busy = false
      if (pending !== null) {
        const p = pending
        pending = null
        void pump(p)
      }
    }
  }
  return (q: Q) => {
    if (busy) pending = q
    else void pump(q)
  }
}
