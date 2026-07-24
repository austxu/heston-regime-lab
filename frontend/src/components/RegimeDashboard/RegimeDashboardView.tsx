import { useState } from 'react'
import { Card } from '../ui/Card'
import { QueryState } from '../ui/QueryState'
import { ChartSkeleton, RowsSkeleton } from '../ui/Skeleton'
import { StalenessIndicator } from '../ui/StalenessIndicator'
import { CurrentRegimeCard } from './CurrentRegimeCard'
import { RegimeHistoryChart } from './RegimeHistoryChart'
import { ParamDensities } from './ParamDensities'
import { ErrorByRegime } from './ErrorByRegime'
import { useRegimeCurrent, useRegimeHistory, useRegimeParameters } from '../../hooks/useRegime'

export function RegimeDashboardView() {
  const [analysisRequested, setAnalysisRequested] = useState(false)
  const current = useRegimeCurrent()
  const history = useRegimeHistory(5)
  const params = useRegimeParameters(analysisRequested)

  return (
    <div className="space-y-4">
      <Card
        title="Current Regime"
        right={current.data && <StalenessIndicator provenance={current.data.provenance} refreshing={current.isFetching} />}
      >
        <QueryState query={current} skeleton={<RowsSkeleton rows={3} />}>
          {(data) => <CurrentRegimeCard data={data} />}
        </QueryState>
      </Card>

      <Card
        title="SPX Price with Regime Overlay"
        subtitle="20y history; background bands show the HMM-decoded regime."
        right={history.data && <StalenessIndicator provenance={history.data.provenance} refreshing={history.isFetching} />}
      >
        <QueryState query={history} skeleton={<ChartSkeleton height={380} />}>
          {(data) => <RegimeHistoryChart data={data} />}
        </QueryState>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card
          title="Heston Parameter Distributions by Regime"
          subtitle="Bootstrapped calibrations; Kruskal-Wallis tests whether each parameter differs across regimes."
          right={params.data && <StalenessIndicator provenance={params.data.provenance} />}
        >
          {analysisRequested ? (
            <QueryState
              query={params}
              skeleton={<ChartSkeleton height={300} />}
              pendingMessage="Running per-regime calibrations (Kruskal-Wallis)… this takes ~1 min the first time."
            >
              {(data) => <ParamDensities data={data} />}
            </QueryState>
          ) : (
            <AnalysisPrompt onRun={() => setAnalysisRequested(true)} />
          )}
        </Card>

        <Card
          title="Calibration Error by Regime"
          subtitle="Static (one global fit) vs regime-conditional calibration."
          right={params.data && <StalenessIndicator provenance={params.data.provenance} />}
        >
          {analysisRequested ? (
            <QueryState
              query={params}
              skeleton={<ChartSkeleton height={300} />}
              pendingMessage="Computing static vs regime-conditional accuracy…"
              showBackgroundError={false}
            >
              {(data) => <ErrorByRegime data={data} />}
            </QueryState>
          ) : (
            <DeferredAnalysisNotice />
          )}
        </Card>
      </div>
    </div>
  )
}

function AnalysisPrompt({ onRun }: { onRun: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-edge bg-panel2 px-5 py-8 text-center">
      <p className="text-sm text-ink">Run the deeper, compute-intensive regime study on demand.</p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">
        It performs bootstrapped Heston calibrations and is cached after the first run, but can
        take about a minute and use significant CPU while it runs.
      </p>
      <button
        type="button"
        onClick={onRun}
        className="mt-4 rounded-lg bg-sky-500/90 px-4 py-2 text-sm font-medium text-base transition-colors hover:bg-sky-400"
      >
        Run regime analysis
      </button>
    </div>
  )
}

function DeferredAnalysisNotice() {
  return (
    <div className="rounded-lg border border-dashed border-edge bg-panel2 px-5 py-8 text-center text-sm text-muted">
      Results appear here when the regime analysis is run.
    </div>
  )
}
