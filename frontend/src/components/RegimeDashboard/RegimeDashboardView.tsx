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
  const current = useRegimeCurrent()
  const history = useRegimeHistory(5)
  const params = useRegimeParameters()

  return (
    <div className="space-y-4">
      <Card
        title="Current Regime"
        right={current.data && <StalenessIndicator provenance={current.data.provenance} />}
      >
        <QueryState query={current} skeleton={<RowsSkeleton rows={3} />}>
          {(data) => <CurrentRegimeCard data={data} />}
        </QueryState>
      </Card>

      <Card
        title="SPX Price with Regime Overlay"
        subtitle="20y history; background bands show the HMM-decoded regime."
        right={history.data && <StalenessIndicator provenance={history.data.provenance} />}
      >
        <QueryState query={history} skeleton={<ChartSkeleton height={380} />}>
          {(data) => <RegimeHistoryChart data={data} />}
        </QueryState>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card
          title="Heston Parameter Distributions by Regime"
          subtitle="Bootstrapped calibrations; Kruskal-Wallis tests whether each parameter differs across regimes."
        >
          <QueryState
            query={params}
            skeleton={<ChartSkeleton height={300} />}
            pendingMessage="Running per-regime calibrations (Kruskal-Wallis)… this takes ~1 min the first time."
          >
            {(data) => <ParamDensities data={data} />}
          </QueryState>
        </Card>

        <Card
          title="Calibration Error by Regime"
          subtitle="Static (one global fit) vs regime-conditional calibration."
        >
          <QueryState
            query={params}
            skeleton={<ChartSkeleton height={300} />}
            pendingMessage="Computing static vs regime-conditional accuracy…"
          >
            {(data) => <ErrorByRegime data={data} />}
          </QueryState>
        </Card>
      </div>
    </div>
  )
}
