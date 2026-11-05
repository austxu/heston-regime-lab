# heston-regime-lab — browser lab

A static, fully client-side Heston lab: Preact + TypeScript + Vite, with all numerics in a
Web Worker. It needs no backend and no WebGL.

```bash
npm ci
npm run dev        # http://localhost:5173
npm test           # vitest: parity with the Python research code + model tests
npm run typecheck
npm run lint
npm run build      # type-check + production build to dist/ (deploy dist/ as static files)
```

| Path | Contents |
|---|---|
| `src/math/` | TS port of `models/heston.py`, `models/black_scholes.py`, calibration (bounded LM), surfaces, QE Monte Carlo, Baum–Welch HMM |
| `src/math/__fixtures__/parity.json` | reference values from `scripts/make_parity_fixtures.py` |
| `src/data/market.json` | baked FRED history + HMM regimes + regime parameters (`scripts/bake_market_data.py`) |
| `src/worker/` | the lab worker and a latest-wins client |
| `src/render/` | canvas-2D 3D surface renderer, OKLab colormap |
| `src/views/` | Surface, Calibration, Regimes, Paths, Model |
| `public/_headers` | Cloudflare Pages headers (CSP, caching) |

URL flags: `?embed=1` hides page chrome for iframes. `?embed=1&autoplay=1` shows an attract
loop that runs until the first interaction. Tabs are deep-linkable at `#surface`,
`#calibration`, `#regimes`, `#paths` and `#model`.
