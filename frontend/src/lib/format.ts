// Small formatting helpers shared across views.

export const pct = (x: number, digits = 2): string => `${(x * 100).toFixed(digits)}%`

export const fixed = (x: number, digits = 4): string =>
  Number.isFinite(x) ? x.toFixed(digits) : '—'

export const num = (x: number, digits = 2): string =>
  Number.isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—'

/** Format an exchange/market date without shifting date-only ISO values across time zones. */
export function marketDate(iso: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso)
  const parsed = new Date(dateOnly ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    ...(dateOnly ? { timeZone: 'UTC' } : {}),
  }).format(parsed)
}

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
