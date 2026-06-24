# TODO — Phase 3: React analytics dashboard

A clean, dark, professional React+TS frontend consuming the Phase 2 API. Plotly charts,
React Query data fetching, native WebSocket for live calibration.

## Plan (each step has a verify condition)
- [ ] Surface per-regime bootstrap samples from the API for real density plots
      → verify: GET /api/regime/parameters returns `param_samples`; tests still green
- [ ] Scaffold Vite React-TS in frontend/, install deps (react-query, plotly, tailwind v3)
      → verify: `npm run build` succeeds on the empty scaffold
- [ ] Tailwind dark theme + base layout/nav (4 tabs)
      → verify: app renders nav; tsc clean
- [ ] api/client.ts + TS types mirroring schemas + React Query provider
      → verify: typed client compiles; types match backend fields
- [ ] hooks: useWebSocket (exp-backoff reconnect), useCalibration, useRegime*, useSurface, useComparison, useHealth
      → verify: tsc clean; ws hook reconnects
- [ ] shared: Skeleton, ErrorBoundary, StalenessIndicator, ProvenanceBadge, Card, Tooltip
      → verify: components compile and are reused across views
- [ ] VolSurface view: market vs model 3D surfaces + error heatmap; maturity/strike controls
      → verify: builds; consumes /api/surface shape
- [ ] CalibrationPanel: trigger button, live convergence (loss + param paths), param card, error badge
      → verify: builds; WS messages typed; badge thresholds 3%/5%
- [ ] RegimeDashboard: current badge + posterior bars, SPX history with regime bands, density plots, error-by-regime
      → verify: builds; consumes current/history/parameters
- [ ] ModelComparison: error table (BS/Heston/corrected), moneyness+maturity buckets, key-finding callout
      → verify: builds; consumes /api/comparison
- [ ] Skeletons + error boundaries + staleness indicator wired throughout
      → verify: every data panel has loading + error fallback
- [ ] docker/Dockerfile.frontend + docker-compose frontend service
      → verify: compose config valid
- [ ] tsc --noEmit + vite build green; dev server serves; commit in focused batches
      → verify: `npm run build` exits 0; `tsc --noEmit` clean

## Done when
All four views build and consume the live API, dark-themed, with skeletons, error
boundaries, staleness indicator, and a working WebSocket convergence chart; frontend
dockerised and added to compose.
