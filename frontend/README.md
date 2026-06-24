# heston-regime-lab — frontend

React + TypeScript + Vite dashboard for the heston-regime-lab API. Tailwind (dark theme),
Plotly charts, React Query for data, native WebSocket for live calibration.

```bash
npm install
npm run dev      # http://localhost:5173 (proxies /api and /ws to the API on :8000)
npm run build    # type-check (tsc -b) + production build to dist/
```

Point at a non-default backend with `VITE_API_TARGET` (dev proxy) or `VITE_API_BASE`
(cross-origin). Views: **Vol Surface**, **Live Calibration** (WebSocket), **Regime
Dashboard**, **Model Comparison**. See the repository root README for the full project.
