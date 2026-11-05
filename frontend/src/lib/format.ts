/** Consistent number formatting for every readout and axis. */
export const pct = (v: number, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—')
export const volPts = (v: number, d = 2) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}` : '—')
export const num = (v: number, d = 2) =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'
export const signed = (v: number, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}` : '—')
export const minus = (s: string) => s.replace(/^-/, '−')
export const fixed = (v: number, d = 3) => (Number.isFinite(v) ? minus(v.toFixed(d)) : '—')
export const sci = (v: number, d = 2) => {
  if (!Number.isFinite(v) || v === 0) return Number.isFinite(v) ? '0' : '—'
  const e = Math.floor(Math.log10(Math.abs(v)))
  const m = v / 10 ** e
  return `${minus(m.toFixed(d))}e${e < 0 ? '−' : ''}${Math.abs(e)}`
}
export const tenor = (tau: number) => {
  const months = tau * 12
  if (Math.abs(months - Math.round(months)) < 0.05 && months < 12) return `${Math.round(months)}m`
  if (tau >= 1 && Math.abs(tau - Math.round(tau)) < 0.02) return `${Math.round(tau)}y`
  return months < 12 ? `${months.toFixed(1)}m` : `${tau.toFixed(1)}y`
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const dateLabel = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
export const monthLabel = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
export const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/** A percent formatter with just enough decimals to keep every tick label distinct. */
export const pctTickFormat = (ticks: number[], suffix = '%') => {
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) * 100 : 1
  const d = Math.max(0, Math.min(3, Math.ceil(-Math.log10(step) + 1e-9)))
  return (v: number) => `${(v * 100).toFixed(d)}${suffix}`
}
