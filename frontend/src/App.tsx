import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, LazyExoticComponent, ComponentType } from 'react'
import { Header } from './components/layout/Header'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { ChartSkeleton } from './components/ui/Skeleton'

type TabId = 'surface' | 'calibration' | 'regime' | 'comparison'

interface Tab {
  id: TabId
  label: string
  description: string
  view: LazyExoticComponent<ComponentType>
  preload: () => void
}

const TABS: readonly Tab[] = [
  {
    id: 'surface',
    label: 'Vol Surface',
    description: 'Compare market and calibrated Heston implied-volatility surfaces.',
    view: lazy(async () => ({
      default: (await import('./components/VolSurface/VolSurfaceView')).VolSurfaceView,
    })),
    preload: () => void import('./components/VolSurface/VolSurfaceView'),
  },
  {
    id: 'calibration',
    label: 'Live Calibration',
    description: 'Watch a Heston calibration converge in real time.',
    view: lazy(async () => ({
      default: (await import('./components/CalibrationPanel/CalibrationPanelView'))
        .CalibrationPanelView,
    })),
    preload: () => void import('./components/CalibrationPanel/CalibrationPanelView'),
  },
  {
    id: 'regime',
    label: 'Regime Dashboard',
    description: 'Explore current and historical market-volatility regimes.',
    view: lazy(async () => ({
      default: (await import('./components/RegimeDashboard/RegimeDashboardView'))
        .RegimeDashboardView,
    })),
    preload: () => void import('./components/RegimeDashboard/RegimeDashboardView'),
  },
  {
    id: 'comparison',
    label: 'Model Comparison',
    description: 'Compare pricing error across Black-Scholes, Heston, and residual models.',
    view: lazy(async () => ({
      default: (await import('./components/ModelComparison/ModelComparisonView'))
        .ModelComparisonView,
    })),
    preload: () => void import('./components/ModelComparison/ModelComparisonView'),
  },
]

const DEFAULT_TAB: TabId = 'surface'

export default function App() {
  const [active, setActive] = useState<TabId>(readTabFromHash)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const activeTab = TABS.find((tab) => tab.id === active) ?? TABS[0]
  const ActiveView = activeTab.view

  const syncFromLocation = useCallback(() => setActive(readTabFromHash()), [])

  useEffect(() => {
    const validHash = TABS.some((tab) => `#${tab.id}` === window.location.hash)
    if (!validHash) window.history.replaceState(null, '', `#${DEFAULT_TAB}`)
    window.addEventListener('hashchange', syncFromLocation)
    window.addEventListener('popstate', syncFromLocation)
    return () => {
      window.removeEventListener('hashchange', syncFromLocation)
      window.removeEventListener('popstate', syncFromLocation)
    }
  }, [syncFromLocation])

  useEffect(() => {
    document.title = `${activeTab.label} · heston·regime·lab`
  }, [activeTab.label])

  const selectTab = useCallback((tab: Tab) => {
    setActive(tab.id)
    if (window.location.hash !== `#${tab.id}`) {
      window.history.pushState(null, '', `#${tab.id}`)
    }
  }, [])

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % TABS.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + TABS.length) % TABS.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = TABS.length - 1
    }
    if (nextIndex == null) return

    event.preventDefault()
    const nextTab = TABS[nextIndex]
    selectTab(nextTab)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <div className="min-h-full">
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById(`panel-${active}`)?.focus()
        }}
        className="fixed left-3 top-3 z-50 -translate-y-20 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-base shadow-xl transition-transform focus:translate-y-0"
      >
        Skip to dashboard
      </a>

      <Header />

      <nav className="border-b border-edge bg-base" aria-label="Dashboard views">
        <div className="scrollbar-none mx-auto max-w-[1400px] overflow-x-auto px-4 sm:px-6">
          <div
            role="tablist"
            aria-label="Analytics views"
            className="flex min-w-max gap-1"
          >
            {TABS.map((tab, index) => {
              const selected = active === tab.id
              return (
                <button
                  key={tab.id}
                  ref={(element) => {
                    tabRefs.current[index] = element
                  }}
                  id={`tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  title={tab.description}
                  onClick={() => selectTab(tab)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  onPointerEnter={tab.preload}
                  onFocus={tab.preload}
                  className={`relative whitespace-nowrap px-3 py-3 text-sm transition-colors ${
                    selected ? 'text-ink' : 'text-muted hover:text-ink'
                  }`}
                >
                  {tab.label}
                  {selected && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent"
                    />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </nav>

      <main id="main-content" className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 sm:py-6">
        <div
          id={`panel-${active}`}
          role="tabpanel"
          aria-labelledby={`tab-${active}`}
          tabIndex={0}
          className="outline-none"
        >
          <ErrorBoundary label={`the ${activeTab.label} view`} key={active}>
            <Suspense fallback={<ChartSkeleton height={420} label={`Loading ${activeTab.label}`} />}>
              <ActiveView />
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  )
}

function readTabFromHash(): TabId {
  const candidate = window.location.hash.slice(1)
  return TABS.some((tab) => tab.id === candidate) ? (candidate as TabId) : DEFAULT_TAB
}
