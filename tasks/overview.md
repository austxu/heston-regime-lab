# heston-regime-lab — Project Overview

## 1. Purpose & Goals
A stochastic-volatility research lab. Calibrate the Heston model, detect market regimes
with an HMM, and study how Heston parameters vary across regimes.

**Current status:** the public demo is a **static browser lab** (`frontend/`, live at
heston.austxu.dev). It runs a TypeScript port of the math in a Web Worker and reads data
baked offline: FRED history and a real SPX option snapshot (Cboe delayed quotes, stored as
derived implied vols). Models fitted to the snapshot: Heston, Bates, double Heston, SVI.
The Python package and the FastAPI service are intact, but the lab does not call the API.

## 2. Tech Stack
- Python 3.12 (`.venv` via `uv venv --python 3.12`; system python is 3.14). numpy, scipy,
  pandas, hmmlearn, xgboost, FastAPI (optional service), pytest, Ruff.
- Lab: Preact 10 + TypeScript + Vite 8 (JSX through the oxc transform, `jsxImportSource:
  preact`), vitest, oxlint. Self-hosted Inter / Roboto Mono via @fontsource. No chart or
  WebGL libraries: SVG charts and a canvas-2D 3D renderer. Node 22.

## 3. Architecture / Codebase Map
```
models/heston.py          Heston char. function + Gil-Pelaez pricing (Gauss-Legendre)
models/black_scholes.py   Black-Scholes pricing + implied-vol inversion (Brent)
models/hmm.py             GaussianHMM(3) regime model, vol-ordered labels, NumPy EM fallback
models/fourier.py         forward-normalised Lewis pricing + densities; slice_nodes / density_nodes
models/bates.py, double_heston.py, svi.py   market models (SVI fit is arbitrage-constrained)
calibration/market.py     MODELS registry (names, bounds, cf), scipy least_squares fits
data/cboe.py              Cboe chain parsing, settlement times, parity forwards, filters
calibration/optimizer.py  L-BFGS-B calibration; CalibrationProgress streaming callback
calibration/validators.py synthetic data generation + round-trip validation
data/fetchers.py          live yfinance/FRED + synthetic fallback; liquidity filtering;
                          ChainSnapshot, get_market_snapshot(allow_synthetic=...)
data/features.py          realized vol 5/21/63d, VIX level/slope, return skew, volume ratio
analysis/pricing_comparison.py  flat-BS vs Heston vs XGBoost residual (out-of-fold)
analysis/regime_analysis.py     Kruskal-Wallis + static-vs-regime calibration (_light_config)
api/main.py               FastAPI app: CORS, lifespan, /health, OpenAPI, WS mount
api/deps.py               config/cache/prefer_live dependencies
api/cache/redis_client.py Cache (redis|memory), get_or_compute serve-stale, session_suffix
api/models/schemas.py     Pydantic v2 response models (incl. provenance, WS messages)
api/services/             pipeline + calibration/surface/comparison/regime orchestration
api/routes/               calibration, surface, regime, comparison routers
api/websocket/calibration_stream.py  threaded calibrate -> async queue -> WS frames
frontend/src/math/        TS port: heston (little trap), blackScholes (Cephes ndtr, brentq port),
                          surface (OTM-leg IVs, grids), calibrate (bounded LM), hmm (Baum-Welch),
                          montecarlo (Andersen QE), rng; *.test.ts = parity + model tests
frontend/src/math/__fixtures__/parity.json  Python reference values (make fixtures)
frontend/src/data/market.json  baked FRED SPX/VIX/VIX3M/DGS3MO + HMM regimes + regime params
frontend/src/data/spx.json     baked SPX option snapshot: per-expiry k, bid/mid/ask IV, F, D,
                          SVI params, Python reference fits (params, start, rmse, sliceRmse)
frontend/src/math/__fixtures__/market.json  Python reference values for market.test.ts
frontend/src/math/        + lm (generic bounded LM), fourier, models, market, svi
frontend/src/worker/      lab.worker.ts (all numerics), protocol.ts, client.ts (latest-wins)
frontend/src/render/      surface3d.ts (camera, interaction, labels, canvas-2D fallback),
                          glSurface.ts (WebGL2 layer), colormap.ts (OKLab LUT)
frontend/src/views/       Playground (surface), Market, Density, Regimes, Paths, Model
frontend/src/ui/          Slider, Segmented, Surface3D wrapper, SVG axes
frontend/public/_headers  Cloudflare Pages CSP/caching; og.png + apple-touch-icon.png
scripts/bake_market_data.py      FRED -> features -> HMM -> regime params -> market.json
scripts/bake_spx_options.py      Cboe chain -> derived IVs -> SVI + model fits -> spx.json
scripts/make_parity_fixtures.py  Python reference values for the vitest parity suite
api/ratelimit.py          per-IP rate limiter (cache-backed) for /api/calibration/run
api/logging_config.py     JSON log formatter + configure_logging()
visualization/plots.py    diagnostic charts -> docs/assets/*.png (README figures)
.github/workflows/        ci.yml (lint + tests + builds), deploy.yml (Railway, on green CI)
railway.json + frontend/railway.json   Railway config-as-code; DEPLOY.md = full guide
docker/                   Dockerfile.api, Dockerfile.frontend (nginx), nginx.conf
docker-compose.yml        frontend (:3000) + api (:8000) + redis (:6379)
configs/base.yaml         all hyperparameters (market, quadrature, calibration, data,
                          hmm, residual_model, api)
tests/test_synthetic.py   Phase 1 math-core suite
tests/test_phase2_api.py  Phase 2: data/HMM/cache/endpoints (offline, deterministic)
tests/test_phase4_hardening.py  middleware, rate-limit, logging, and compression contracts
tests/test_regressions.py boundary validation, cache concurrency, proxy/mode/job regressions
```
Data flow (API): request -> route -> service (cache.get_or_compute) ->
fetchers.get_market_snapshot (live|stale-cache|synthetic) -> filter liquid ->
calibrate / fit HMM / compare -> Pydantic response with provenance.
Data flow (lab): `market.json` (lazy chunk) + slider state -> worker requests (surface,
calibrate stream, paths, hmm) -> SVG charts / canvas surface. No network calls at runtime.

## 4. Build / Run / Test
- Bootstrap: `python3.12 -m venv .venv && source .venv/bin/activate && make bootstrap`
- All local checks: `make check`; tests only: `make test`
- Round-trip demo: `.venv/bin/python -m calibration.validators`
- API offline: `HRL_OFFLINE=1 .venv/bin/uvicorn api.main:app --reload` -> http://localhost:8000/docs
- Lab: `cd frontend && npm ci && npm run dev` -> http://localhost:5173. Tests `npm test`,
  typecheck `npm run typecheck`, lint `npm run lint`, build `npm run build` -> `frontend/dist`
  (Cloudflare Pages: root `frontend`, build `npm ci && npm run build`, output `dist`).
- Refresh data / fixtures: `make bake` (network, FRED), `make bake-options` (network, Cboe;
  `INPUT=chain.json` for a saved chain; ~3 min of fits) and `make fixtures` (with `.venv`
  python: `make PYTHON=.venv/bin/python bake`). Fixtures rewrite parity.json's timing field;
  revert it if nothing else changed.
- Deploy the lab: `npx wrangler pages deploy frontend/dist --project-name heston --branch main`
  (after `npm run build`; ask the user first).
- Full stack: `docker compose up --build` (frontend :3000, api :8000, Redis :6379;
  synthetic by default, `HRL_OFFLINE=0` opts into live requests)
- Regenerate README charts: `.venv/bin/python -m visualization.plots` -> docs/assets/
- Deploy: GitHub Actions deploys the exact green commit once `RAILWAY_TOKEN` is configured;
  see DEPLOY.md. Keep native Railway autodeploy disabled when using the workflow.

## 5. Conventions & Gotchas
- Char. function uses the **"little Heston trap"** g2 formulation — do NOT switch to g1.
- Gil-Pelaez integrands have a removable singularity at u=0; integrate over (0, U] with
  Gauss-Legendre nodes that never hit 0.
- All rates/vols continuously-compounded, annualized; time in years.
- **Live + offline fallback everywhere:** fetchers try yfinance/FRED, fall back to a
  deterministic seeded synthetic generator (a 3-regime vol Markov chain) so the HMM finds
  economically meaningful regimes offline. `allow_synthetic=False` makes the live path
  raise so the cache can serve stale on failure.
- **Cache:** session-keyed (rolls over after market close) + TTL + serve-stale-on-error.
  Redis if `REDIS_URL` reachable, else in-process dict. Use `?live=false`/`HRL_OFFLINE=1`
  to force synthetic.
- HMM states are relabeled by realized vol (0=calm … K-1=crisis) for stable API labels.
- `/api/regime/parameters` is heavy (dozens of calibrations) — uses `_light_config`
  (coarser quadrature/grid/maxiter), starts only after an explicit dashboard action, and
  is background-computed + long-cached.
- The synthetic surface adds a small non-Heston wing bump (`smile_perturb`) so offline
  calibration error is realistic (~0.1%) and residual correction has structure to fix.
- Heavy compute runs in `run_in_threadpool`; the WS runs calibrate in a worker thread and
  bridges per-iteration progress to the event loop via a thread-safe queue.
- **Lab:** `verbatimModuleSyntax` + `erasableSyntaxOnly` are on (no TS parameter
  properties/enums; `import type` for types). All heavy math goes through the worker; the
  surface/IV grid flat-extrapolates and flags wing cells whose OTM price is below the
  ~1e-8 quadrature floor (`surfaceGrid`). Calibration grids use x = ln(K/F)/sqrt(T) so the
  delta-like quote grid is rectangular. Embed: `?embed=1`; attract: `?embed=1&autoplay=1` (views/Attract.tsx: live model race on the SPX snapshot, then a FRED history replay where each day's VIX/VIX3M sets v0 and theta with kappa, sigma, rho from today's Heston fit; frames cached after one pass; reduced motion shows the final fit).
  Regime params: kappa pooled from the VIX3M^2-on-VIX^2 slope; theta/v0 per regime from
  the two tenors; sigma/rho from daily dv0 (see bake script). FRED has no volume, so the
  HMM drops `volume_ratio`.
- **Market models:** everything prices in forward units (F = 1, undiscounted, k = ln K/F),
  so per-expiry forwards and discounts drop out. Use `slice_nodes(atm, tau)` (3 GL panels,
  184 nodes) for prices and `density_nodes` (696) for densities: real fits have vol-of-vol
  4–6, where phi decays exponentially, and a single [0, U] rule is either truncated or
  under-resolved. Market bounds are wider than configs/base.yaml (kappa <= 50, sigma <= 8).
  The browser fit starts from the Python best start stored in spx.json.
- **Cboe data terms:** the site permits personal viewing; redistribution needs Cboe's
  approval. Only derived IVs/forwards are committed; raw chains stay out of git.
- `/api/regime/parameters` returns 202 while computing (clients poll). Three additive fields
  remain in `RegimeParametersResponse`: `param_samples`, `static_mae_by_regime`,
  `regime_mae_by_regime` (the old dashboard used them; the lab does not call the API).
- **Hardening:** expensive calibration entry points are admission-controlled (cache-backed
  per-IP HTTP limits plus a bounded WebSocket worker pool and Origin validation); gzip via
  GZipMiddleware/nginx; live fetches have a `data.request_timeout`
  (thread + future timeout) that falls back to cache/synthetic; JSON request logging with
  X-Request-ID; Sentry inits only if `SENTRY_DSN` set; prod CORS from `CORS_ORIGINS` env.
- **CI/CD:** ci.yml runs on push/PR; deploy.yml triggers via `workflow_run` only after CI
  succeeds on main/master and no-ops without `RAILWAY_TOKEN`. Default branch here is
  `master`; workflows trigger on both main and master.
- Rate-limit tests use a fresh app per test (function-scoped client) so buckets are clean;
  only `/api/calibration/run` is limited, so other endpoints' tests are unaffected.
