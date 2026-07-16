# heston-regime-lab — frontend

React + TypeScript + Vite dashboard for the heston-regime-lab API. Tailwind (dark theme),
lazy trace-scoped Plotly charts, React Query for data, and native WebSocket calibration.

```bash
npm ci
npm run dev        # http://localhost:5173; proxies /api and /ws to the API on :8000
npm run typecheck
npm run lint
npm test
npm run build      # type-check + production build to dist/
```

Use `VITE_API_TARGET` to change the local development proxy target. Set `VITE_API_BASE`
only when the browser must call a cross-origin deployment directly; both HTTP requests and
the calibration WebSocket derive from it. Same-origin deployment remains the preferred path.

Views are deep-linkable at `#surface`, `#calibration`, `#regime`, and `#comparison`.
The expensive bootstrapped regime study runs only when requested from the regime view;
its result is cached and the lighter current/history panels remain immediately usable.
See the repository root README for the full project and deployment instructions.
