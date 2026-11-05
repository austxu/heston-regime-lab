import { useEffect, useState } from 'preact/hooks'
import { dateLabel } from './lib/format'
import { flags } from './lib/hooks'
import { loadMarket, type MarketData } from './lib/market'
import { loadSpx, type SpxData } from './lib/spx'
import type { HestonParams } from './math/types'
import { Model } from './views/Model'
import { Paths } from './views/Paths'
import { Playground, TEXTBOOK, type PlaygroundState } from './views/Playground'
import { Regimes } from './views/Regimes'

const TABS = [
  { id: 'surface', n: '01', label: 'Surface' },
  { id: 'market', n: '02', label: 'Market' },
  { id: 'density', n: '03', label: 'Density' },
  { id: 'regimes', n: '04', label: 'Regimes' },
  { id: 'paths', n: '05', label: 'Paths' },
  { id: 'model', n: '06', label: 'Model' },
] as const
type TabId = (typeof TABS)[number]['id']

const fromHash = (): TabId => {
  const h = location.hash.replace('#', '')
  // The synthetic-surface calibration tab became the real-market fit.
  if (h === 'calibration') return 'market'
  return (TABS.find((t) => t.id === h)?.id ?? 'surface') as TabId
}

export function App() {
  const [tab, setTab] = useState<TabId>(fromHash)
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([fromHash()]))
  const [market, setMarket] = useState<MarketData | null>(null)
  const [marketError, setMarketError] = useState(false)
  const [spx, setSpx] = useState<SpxData | null>(null)
  const [spxError, setSpxError] = useState(false)
  const [mv, setMv] = useState<typeof import('./views/marketViews') | null>(null)
  const [pg, setPg] = useState<PlaygroundState>({ params: TEXTBOOK, rate: 0.04 })
  const [attract, setAttract] = useState(flags.embed && flags.autoplay)

  useEffect(() => {
    loadMarket()
      .then((m) => {
        setMarket(m)
        setPg((s) => ({ ...s, rate: m.latestRate }))
      })
      .catch(() => setMarketError(true))
  }, [])
  // The option snapshot and its views (one lazy chunk each) drive the Market and Density tabs
  // and the attract loop.
  useEffect(() => {
    loadSpx().then(setSpx).catch(() => setSpxError(true))
    import('./views/marketViews').then(setMv).catch(() => setSpxError(true))
  }, [])

  useEffect(() => {
    const on = () => go(fromHash(), false)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('embed', flags.embed)
  }, [])

  function go(id: TabId, push = true) {
    setTab(id)
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)))
    if (push && location.hash !== `#${id}`) history.replaceState(null, '', `${location.pathname}${location.search}#${id}`)
  }

  const openInPlayground = (params: HestonParams) => {
    setPg((s) => ({ ...s, params }))
    go('surface')
    window.scrollTo({ top: 0 })
  }
  const optionFit = spx ? { asOf: spx.asOf, params: spx.fits.heston.params as unknown as HestonParams } : null

  if (attract) {
    const leave = () => {
      setAttract(false)
      if (!location.hash) go('market')
    }
    return mv ? <mv.Attract spx={spx} onInteract={leave} /> : <div class="attract" />
  }

  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab)
    let n = -1
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = TABS.length - 1
    if (n < 0) return
    e.preventDefault()
    go(TABS[n].id)
    document.getElementById(`tab-${TABS[n].id}`)?.focus()
  }

  return (
    <div class="shell">
      {!flags.embed && (
        <>
          <header class="topbar">
            <a class="brand" href="https://austxu.dev" aria-label="Heston Regime Lab, by Austin Xu">
              <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
                <rect width="32" height="32" rx="8" fill="#22262f" />
                <path d="M5 21.5c3.2-1.2 5-6.8 8-9.6 2.4-2.2 4.6-1.6 6.6.4 2.1 2.1 4 5.1 7.4 6.2" fill="none" stroke="#9e77ed" stroke-width="2.4" stroke-linecap="round" />
                <path d="M5 25.5c3.4-.9 5.6-4.4 8.6-6.1 2.6-1.5 4.8-1 6.9.6 2.1 1.6 3.9 3.4 6.5 3.9" fill="none" stroke="#f0887b" stroke-width="2" stroke-linecap="round" />
              </svg>
              Heston Regime Lab <span>/ austxu.dev</span>
            </a>
            <nav class="topbar-meta" aria-label="External links">
              <span class="hide-sm">{spx ? `options as of ${dateLabel(new Date(spx.asOf))}` : market ? `history through ${dateLabel(new Date(`${market.asOf}T00:00:00Z`))}` : 'loading data…'}</span>
              <a href="https://github.com/austxu/heston-regime-lab" target="_blank" rel="noreferrer">
                source ↗
              </a>
            </nav>
          </header>
          <div class="intro">
            <div>
              <p class="eyebrow">stochastic volatility · research instrument</p>
              <h1>
                Stochastic volatility, <em>fitted live</em> to real SPX options.
              </h1>
            </div>
            <div>
              <p>
                Calibrate Heston, Bates and a two-factor Heston to a real S&amp;P 500 option chain, read the crash risk priced into it, and see how
                regimes in a decade of index and VIX history map to model parameters. Every number is computed on this page by a TypeScript port of
                the Python research code.
              </p>
              <div class="provenance">
                <span class="chip real">
                  <i />
                  real: SPX option quotes (Cboe, delayed)
                </span>
                <span class="chip real">
                  <i />
                  real: SPX, VIX, rates (FRED)
                </span>
                <span class="chip model">
                  <i />
                  fitted: models, SVI, HMM regimes
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      <div class="tabs" role="tablist" aria-label="Lab views" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            class="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => go(t.id)}
          >
            <span class="eyebrow">{t.n}</span>
            {t.label}
          </button>
        ))}
        <span class="tabs-spacer" />
        {flags.embed && market && <span class="asof">{spx ? `options ${spx.asOf.slice(0, 10)} · ` : ''}FRED through {market.asOf}</span>}
      </div>

      {TABS.map((t) =>
        visited.has(t.id) ? (
          <div key={t.id} id={`panel-${t.id}`} role="tabpanel" aria-labelledby={`tab-${t.id}`} hidden={tab !== t.id}>
            {t.id === 'surface' && <Playground state={pg} setState={setPg} market={market} />}
            {t.id === 'market' && (mv ? <mv.Market spx={spx} error={spxError} active={tab === 'market'} onUseParams={openInPlayground} /> : <div class="panel loading">{spxError ? 'Could not load the SPX option snapshot.' : 'Loading the SPX option snapshot…'}</div>)}
            {t.id === 'density' && (mv ? <mv.Density spx={spx} error={spxError} active={tab === 'density'} /> : <div class="panel loading">{spxError ? 'Could not load the SPX option snapshot.' : 'Loading the SPX option snapshot…'}</div>)}
            {t.id === 'regimes' && <Regimes market={market} error={marketError} onPlayground={openInPlayground} optionFit={optionFit} active={tab === 'regimes'} />}
            {t.id === 'paths' && <Paths params={pg.params} rate={pg.rate} active={tab === 'paths'} />}
            {t.id === 'model' && <Model market={market} spx={spx} />}
          </div>
        ) : null,
      )}

      {!flags.embed && (
        <footer class="footer">
          <span>
            Research demonstration, not investment advice. Option data: Cboe delayed quotes{spx ? ` (${spx.asOf.slice(0, 10)})` : ''}, used only as
            derived implied vols. Index, VIX and rate history: FRED.
          </span>
          <span>
            <a href="https://austxu.dev">austxu.dev</a> · <a href="https://github.com/austxu/heston-regime-lab">github</a>
          </span>
        </footer>
      )}
    </div>
  )
}
