import { useEffect, useRef, useState } from 'preact/hooks'

export function useReducedMotion(): boolean {
  const q = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  const [reduced, setReduced] = useState(!!q?.matches)
  useEffect(() => {
    if (!q) return
    const on = () => setReduced(q.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return reduced
}

/** Width/height of an element, tracked with a ResizeObserver. */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect
      setSize((s) => (Math.abs(s.width - width) < 0.5 && Math.abs(s.height - height) < 0.5 ? s : { width, height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

export const flags = (() => {
  const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
  const on = (k: string) => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false'
  return { embed: on('embed'), autoplay: on('autoplay') }
})()

/** Run fn after `ms` of quiet; the latest call wins. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
