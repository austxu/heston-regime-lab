import Plot from '../Plot'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { ParameterCard } from './ParameterCard'
import { useCalibration } from '../../hooks/useCalibration'
import type { CalibrationStep } from '../../hooks/useCalibration'
import { PARAM_NAMES } from '../../api/types'
import type { ParamName } from '../../api/types'
import { PARAM_META } from '../../lib/params'
import { COLORS, PLOT_CONFIG, baseLayout } from '../../lib/theme'
import type { WsStatus } from '../../hooks/useWebSocket'

export function CalibrationPanelView() {
  const cal = useCalibration()
  const latest = cal.steps.length ? cal.steps[cal.steps.length - 1].params : null
  const displayParams = cal.finalParams ?? latest
  const displayError = cal.finalError

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card
          title="Live Heston Calibration"
          subtitle="Streams L-BFGS-B convergence over WebSocket as the optimiser runs."
          right={
            <span role="status" aria-live="polite">
              <WsStatusBadge status={cal.wsStatus} retries={cal.retries} running={cal.running} />
            </span>
          }
        >
          <div className="mb-4 flex items-center gap-3">
            <button
              type="button"
              onClick={cal.start}
              disabled={cal.running}
              className="rounded-lg bg-sky-500/90 px-4 py-2 text-sm font-medium text-base
                         transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cal.running ? 'Calibrating…' : 'Run Calibration'}
            </button>
            {cal.running && (
              <button
                type="button"
                onClick={cal.stop}
                className="rounded-lg border border-edge px-3 py-2 text-sm text-muted hover:text-ink"
              >
                Stop
              </button>
            )}
            <span className="text-xs text-muted">
              {cal.steps.length > 0 && `iteration ${cal.steps[cal.steps.length - 1].iteration}`}
              {cal.done && ' · converged'}
            </span>
          </div>

          {cal.errorMsg && (
            <div role="alert" className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {cal.errorMsg}
            </div>
          )}

          {cal.steps.length === 0 && !cal.running ? (
            <EmptyState />
          ) : (
            <LossChart steps={cal.steps} />
          )}
        </Card>

        <Card title="Parameter Trajectories" subtitle="Each parameter's path as the optimiser converges.">
          {cal.steps.length === 0 ? (
            <p className="text-sm text-muted">Trajectories appear here once a run starts.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {PARAM_NAMES.map((name) => (
                <ParamSparkline key={name} name={name} steps={cal.steps} />
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="Result">
          <ParameterCard params={displayParams} meanError={displayError} live={cal.running} />
        </Card>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex h-[300px] flex-col items-center justify-center rounded-lg border border-dashed border-edge text-center">
      <p className="text-sm text-muted">No calibration yet.</p>
      <p className="mt-1 text-xs text-muted/70">
        Press <span className="text-ink">Run Calibration</span> to stream live convergence.
      </p>
    </div>
  )
}

function WsStatusBadge({ status, retries, running }: { status: WsStatus; retries: number; running: boolean }) {
  if (status === 'retrying') {
    return <Badge tone="warn">reconnecting… (attempt {retries})</Badge>
  }
  if (running) return <Badge tone="info">streaming</Badge>
  if (status === 'closed') return <Badge tone="neutral">idle</Badge>
  if (status === 'error') return <Badge tone="bad">connection error</Badge>
  return <Badge tone="neutral">{status}</Badge>
}

function LossChart({ steps }: { steps: CalibrationStep[] }) {
  return (
    <Plot
      ariaLabel="Calibration objective loss by optimizer iteration"
      data={[
        {
          type: 'scatter',
          mode: 'lines+markers',
          x: steps.map((s) => s.iteration),
          y: steps.map((s) => Math.max(s.loss, 1e-16)),
          line: { color: COLORS.accent, width: 2 },
          marker: { size: 4, color: COLORS.accent },
          hovertemplate: 'iter %{x}<br>loss %{y:.3e}<extra></extra>',
        },
      ]}
      layout={baseLayout({
        height: 320,
        showlegend: false,
        xaxis: { title: { text: 'Iteration' }, gridcolor: COLORS.edge },
        yaxis: { title: { text: 'Objective (Σ IV resid²)' }, type: 'log', gridcolor: COLORS.edge },
      })}
      config={PLOT_CONFIG}
      style={{ width: '100%', height: 320 }}
      useResizeHandler
    />
  )
}

function ParamSparkline({ name, steps }: { name: ParamName; steps: CalibrationStep[] }) {
  const meta = PARAM_META[name]
  const xs = steps.map((s) => s.iteration)
  const ys = steps.map((s) => s.params[name])
  const last = ys[ys.length - 1]
  return (
    <div className="rounded-lg border border-edge bg-panel2 p-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-ink">{meta.symbol}</span>
        <span className="font-mono tabular-nums text-muted">{last?.toFixed(meta.digits)}</span>
      </div>
      <Plot
        ariaLabel={`${meta.name} trajectory by optimizer iteration`}
        data={[
          {
            type: 'scatter',
            mode: 'lines',
            x: xs,
            y: ys,
            line: { color: COLORS.model, width: 1.5 },
            hovertemplate: `iter %{x}<br>${meta.symbol} %{y:.4f}<extra></extra>`,
          },
        ]}
        layout={baseLayout({
          height: 70,
          showlegend: false,
          margin: { l: 0, r: 0, t: 4, b: 0 },
          xaxis: { visible: false },
          yaxis: { visible: false },
        })}
        config={PLOT_CONFIG}
        style={{ width: '100%', height: 70 }}
        useResizeHandler
      />
    </div>
  )
}
