/** Minimal scales and "nice" tick generation for the SVG charts. */
export interface Scale {
  (v: number): number
  domain: [number, number]
  range: [number, number]
  invert: (px: number) => number
}

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0)
  const s = ((v: number) => r0 + (v - d0) * k) as Scale
  s.domain = domain
  s.range = range
  s.invert = (px) => (k === 0 ? d0 : d0 + (px - r0) / k)
  return s
}

export function log(domain: [number, number], range: [number, number]): Scale {
  const inner = linear([Math.log(domain[0]), Math.log(domain[1])], range)
  const s = ((v: number) => inner(Math.log(v))) as Scale
  s.domain = domain
  s.range = range
  s.invert = (px) => Math.exp(inner.invert(px))
  return s
}

export function niceStep(span: number, count: number) {
  const raw = span / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const f = raw / mag
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag
}

export function ticks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo]
  const step = niceStep(hi - lo, count)
  const out: number[] = []
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(12))
  return out
}

export function niceDomain(lo: number, hi: number, count = 5): [number, number] {
  if (!(hi > lo)) return [lo - 1, hi + 1]
  const step = niceStep(hi - lo, count)
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step]
}

/** Ticks for a log axis: 1-2-5 per decade, thinned to roughly `count`. */
export function logTicks(lo: number, hi: number, count = 6): number[] {
  const out: number[] = []
  const e0 = Math.floor(Math.log10(lo))
  const e1 = Math.ceil(Math.log10(hi))
  for (const mult of [[1], [1, 5], [1, 2, 5], [1, 2, 3, 5, 7]]) {
    out.length = 0
    for (let e = e0; e <= e1; e++) for (const m of mult) {
      const v = m * 10 ** e
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v)
    }
    if (out.length >= count - 1) break
  }
  if (out.length > count + 2) {
    const step = Math.ceil(out.length / count)
    return out.filter((_, i) => i % step === 0)
  }
  return out
}

export const extent = (vals: Iterable<number>): [number, number] => {
  let lo = Infinity
  let hi = -Infinity
  for (const v of vals) {
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return [lo, hi]
}
