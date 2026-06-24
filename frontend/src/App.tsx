import { useState } from 'react'
import type { ComponentType } from 'react'
import { Header } from './components/layout/Header'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { VolSurfaceView } from './components/VolSurface/VolSurfaceView'
import { CalibrationPanelView } from './components/CalibrationPanel/CalibrationPanelView'
import { RegimeDashboardView } from './components/RegimeDashboard/RegimeDashboardView'
import { ModelComparisonView } from './components/ModelComparison/ModelComparisonView'

interface Tab {
  id: string
  label: string
  view: ComponentType
}

const TABS: Tab[] = [
  { id: 'surface', label: 'Vol Surface', view: VolSurfaceView },
  { id: 'calibration', label: 'Live Calibration', view: CalibrationPanelView },
  { id: 'regime', label: 'Regime Dashboard', view: RegimeDashboardView },
  { id: 'comparison', label: 'Model Comparison', view: ModelComparisonView },
]

export default function App() {
  const [active, setActive] = useState(TABS[0].id)
  const ActiveView = TABS.find((t) => t.id === active)?.view ?? TABS[0].view

  return (
    <div className="min-h-full">
      <Header />

      <nav className="border-b border-edge bg-base">
        <div className="mx-auto flex max-w-[1400px] gap-1 px-4 sm:px-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`relative px-3 py-3 text-sm transition-colors ${
                active === t.id ? 'text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {t.label}
              {active === t.id && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
              )}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        <ErrorBoundary label={`the ${active} view`} key={active}>
          <ActiveView />
        </ErrorBoundary>
      </main>
    </div>
  )
}
