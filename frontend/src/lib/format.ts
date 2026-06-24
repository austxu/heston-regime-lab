// Small formatting helpers shared across views.

export const pct = (x: number, digits = 2): string => `${(x * 100).toFixed(digits)}%`

export const fixed = (x: number, digits = 4): string =>
  Number.isFinite(x) ? x.toFixed(digits) : '—'

export const num = (x: number, digits = 2): string =>
  Number.isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—'

/** Relative "time ago" for staleness display. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'unknown'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'unknown'
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}
