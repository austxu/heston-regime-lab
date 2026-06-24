import { Card } from '../ui/Card'
import { QueryState } from '../ui/QueryState'
import { ChartSkeleton, RowsSkeleton } from '../ui/Skeleton'
import { StalenessIndicator } from '../ui/StalenessIndicator'
import { Badge } from '../ui/Badge'
import { useComparison } from '../../hooks/useApiQueries'
import type { BucketError, ComparisonResponse } from '../../api/types'
import { pct } from '../../lib/format'
import { COLORS } from '../../lib/theme'

export function ModelComparisonView() {
  const query = useComparison()
  return (
    <div className="space-y-4">
      <Card
        title="Pricing Model Comparison"
        subtitle="Mean absolute implied-vol error: flat Black-Scholes vs calibrated Heston vs Heston + XGBoost residual correction."
        right={query.data && <StalenessIndicator provenance={query.data.provenance} />}
      >
        <QueryState query={query} skeleton={<RowsSkeleton rows={4} />}>
          {(data) => <Summary data={data} />}
        </QueryState>
      </Card>

      <QueryState query={query} skeleton={<ChartSkeleton height={240} />}>
        {(data) => (
          <>
            <KeyFinding data={data} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card title="Error by Moneyness" subtitle="How each model fits across the strike range.">
                <BucketTable rows={data.by_moneyness} label="strike" kind="moneyness" />
              </Card>
              <Card title="Error by Maturity" subtitle="How each model fits across tenors.">
                <BucketTable rows={data.by_maturity} label="maturity" kind="maturity" />
              </Card>
            </div>
          </>
        )}
      </QueryState>
    </div>
  )
}

function Summary({ data }: { data: ComparisonResponse }) {
  const cards = [
    { name: 'Black-Scholes (flat)', mae: data.mae_bs, color: COLORS.bs, note: 'baseline' },
    {
      name: 'Heston',
      mae: data.mae_heston,
      color: COLORS.model,
      note: `${data.heston_vs_bs_improvement_pct.toFixed(0)}% better than BS`,
    },
    {
      name: 'Heston + residual',
      mae: data.mae_corrected,
      color: COLORS.corrected,
      note: `${data.residual_improvement_pct.toFixed(0)}% better than Heston · ${data.residual_backend}`,
    },
  ]
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {cards.map((c) => (
        <div key={c.name} className="rounded-lg border border-edge bg-panel2 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.color }} />
            <span className="text-xs text-muted">{c.name}</span>
          </div>
          <div className="mt-2 font-mono text-2xl tabular-nums text-ink">{pct(c.mae)}</div>
          <div className="mt-1 text-xs text-muted">{c.note}</div>
        </div>
      ))}
    </div>
  )
}

function KeyFinding({ data }: { data: ComparisonResponse }) {
  const finding = deriveFinding(data)
  return (
    <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-5 py-4">
      <div className="flex items-center gap-2">
        <Badge tone="info">key finding</Badge>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-ink">{finding}</p>
    </div>
  )
}

function BucketTable({
  rows,
  label,
  kind,
}: {
  rows: BucketError[]
  label: string
  kind: 'moneyness' | 'maturity'
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-edge text-left text-xs uppercase tracking-wider text-muted">
            <th className="py-2 pr-3 font-medium">{label}</th>
            <th className="px-2 py-2 text-right font-medium">n</th>
            <th className="px-2 py-2 text-right font-medium" style={{ color: COLORS.bs }}>BS</th>
            <th className="px-2 py-2 text-right font-medium" style={{ color: COLORS.model }}>Heston</th>
            <th className="px-2 py-2 text-right font-medium" style={{ color: COLORS.corrected }}>+resid</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const best = Math.min(r.bs, r.heston, r.corrected)
            return (
              <tr key={i} className="border-b border-edge/50">
                <td className="py-2 pr-3 text-muted">
                  {kind === 'moneyness' ? bucketMoneyness(r.center) : bucketMaturity(r.center)}
                </td>
                <td className="px-2 py-2 text-right font-mono tabular-nums text-muted">{r.n}</td>
                <Cell v={r.bs} best={best} />
                <Cell v={r.heston} best={best} />
                <Cell v={r.corrected} best={best} />
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Cell({ v, best }: { v: number; best: number }) {
  const isBest = Math.abs(v - best) < 1e-9
  return (
    <td
      className={`px-2 py-2 text-right font-mono tabular-nums ${
        isBest ? 'font-semibold text-emerald-300' : 'text-ink'
      }`}
    >
      {pct(v)}
    </td>
  )
}

// -- labels & key-finding logic --------------------------------------------- //

function bucketMoneyness(center: number): string {
  const d = center - 1
  if (Math.abs(d) <= 0.02) return 'ATM'
  if (d < 0) return Math.abs(d) > 0.1 ? 'Deep OTM put' : 'OTM put'
  return d > 0.1 ? 'Deep OTM call' : 'OTM call'
}

function bucketMaturity(centerYears: number): string {
  const m = centerYears * 12
  const tag = centerYears < 0.15 ? 'short' : centerYears < 0.6 ? 'mid' : 'long'
  return `${m < 1 ? '<1' : Math.round(m)}m (${tag})`
}

function deriveFinding(data: ComparisonResponse): string {
  const atm = nearest(data.by_moneyness, 1.0)
  const tails = [...data.by_moneyness].sort(
    (a, b) => Math.abs(b.center - 1) - Math.abs(a.center - 1),
  )
  const tail = tails[0]
  const atmGain = atm && atm.bs > 0 ? ((atm.bs - atm.heston) / atm.bs) * 100 : 0
  const tailGain = tail && tail.bs > 0 ? ((tail.bs - tail.heston) / tail.bs) * 100 : 0

  const head = `Heston cuts at-the-money implied-vol error by ${atmGain.toFixed(0)}% versus flat Black-Scholes`
  const tailPart =
    tailGain <= 0
      ? `, but at the tail strikes (K/S ≈ ${tail?.center.toFixed(2)}) its edge disappears — Black-Scholes is competitive there.`
      : tailGain < atmGain
        ? `, though the advantage narrows to ${tailGain.toFixed(0)}% at the tail strikes (K/S ≈ ${tail?.center.toFixed(2)}).`
        : `, and the advantage holds across the wings.`
  const resid = ` The XGBoost residual model then trims a further ${data.residual_improvement_pct.toFixed(0)}% off Heston's error.`
  return head + tailPart + resid
}

function nearest(rows: BucketError[], target: number): BucketError | undefined {
  if (!rows.length) return undefined
  return rows.reduce((a, b) => (Math.abs(b.center - target) < Math.abs(a.center - target) ? b : a))
}
