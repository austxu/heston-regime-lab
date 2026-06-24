# heston-regime-lab — Project Overview

## 1. Purpose & Goals
A stochastic-volatility research lab. Calibrate the Heston model to SPX options, detect
market regimes with an HMM, and study how Heston parameters and calibration error vary
across regimes — exposed as a live API.

**Current status: Phase 4 — deployed (CI/CD + hardening).** All four phases are complete:
math core, FastAPI backend, React dashboard, and now deployment config (Railway), GitHub
Actions CI/CD, and production hardening. The actual Railway deploy is the user's step
(needs their account/token); everything is wired so it auto-deploys on green main.

Phases:
- Phase 1 ✅ Math core (char. fn, Gil-Pelaez/Gauss-Legendre, BS+IV, calibration, round-trip).
- Phase 2 ✅ Data layer, vol features, 3-state HMM, XGBoost residual correction,
  Kruskal-Wallis/regime-conditional analysis, FastAPI/Redis/WebSocket API, Docker.
- Phase 3 ✅ React dashboard: Vol Surface, Live Calibration (WS), Regime Dashboard, Model
  Comparison; skeletons, error boundaries, staleness indicator; dockerised behind nginx.
- Phase 4 ✅ GitHub Actions CI (pytest + tsc + image build) and CD (Railway), Railway
  config, production hardening (rate limit, gzip, request timeout, JSON logging, Sentry),
  diagnostic charts, final README. See DEPLOY.md.

## 2. Tech Stack
- Python 3.14 locally (Docker image uses 3.12-slim). numpy, scipy, pandas.
- Models/data: hmmlearn (GaussianHMM), xgboost (needs OpenMP: `brew install libomp`;
  sklearn GradientBoosting fallback), scikit-learn.
- Live data: yfinance (SPX/VIX), fredapi (risk-free); all with synthetic fallback.
- API: FastAPI, uvicorn, pydantic v2, redis (in-memory fallback), websockets.
- Frontend: React 19 + TypeScript (Vite), Tailwind v3, Plotly (`plotly.js-dist-min` via
  react-plotly.js factory), @tanstack/react-query. Node 24 / npm 11.
- pyyaml config, pytest. Virtualenv at `.venv` (`--system-site-packages`).

## 3. Architecture / Codebase Map
```
models/heston.py          Heston char. function + Gil-Pelaez pricing (Gauss-Legendre)
models/black_scholes.py   Black-Scholes pricing + implied-vol inversion (Brent)
models/hmm.py             GaussianHMM(3) regime model, vol-ordered labels, NumPy EM fallback
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
frontend/src/api/         typed client.ts + types.ts mirroring the Pydantic schemas
frontend/src/hooks/       useWebSocket (backoff), useCalibration, useRegime, useApiQueries
frontend/src/components/  VolSurface, CalibrationPanel, RegimeDashboard, ModelComparison, ui/
frontend/src/lib/         theme, dataMode (live/synthetic context), kde, format, params
api/ratelimit.py          per-IP rate limiter (cache-backed) for /api/calibration/run
api/logging_config.py     JSON log formatter + configure_logging()
visualization/plots.py    diagnostic charts -> docs/assets/*.png (README figures)
.github/workflows/        ci.yml (pytest + tsc + image build), deploy.yml (Railway, on green CI)
railway.json + frontend/railway.json   Railway config-as-code; DEPLOY.md = full guide
docker/                   Dockerfile.api, Dockerfile.frontend (nginx), nginx.conf
docker-compose.yml        frontend (:3000) + api (:8000) + redis (:6379)
configs/base.yaml         all hyperparameters (market, quadrature, calibration, data,
                          hmm, residual_model, api)
tests/test_synthetic.py   Phase 1 math-core suite
tests/test_phase2_api.py  Phase 2: data/HMM/cache/endpoints (offline, deterministic)
```
Data flow (API): request -> route -> service (cache.get_or_compute) ->
fetchers.get_market_snapshot (live|stale-cache|synthetic) -> filter liquid ->
calibrate / fit HMM / compare -> Pydantic response with provenance.
Data flow (frontend): React Query / WebSocket hook -> typed client (`/api`, `/ws` proxied
to the backend) -> Plotly views; a global live/synthetic toggle keys every query.

## 4. Build / Run / Test
- Activate env: `source .venv/bin/activate` (or use `.venv/bin/python`).
- Tests: `.venv/bin/python -m pytest tests/ -q`
- Round-trip demo: `.venv/bin/python -m calibration.validators`
- API offline: `HRL_OFFLINE=1 .venv/bin/uvicorn api.main:app --reload` -> http://localhost:8000/docs
- Frontend dev: `cd frontend && npm install && npm run dev` -> http://localhost:5173
  (proxies /api + /ws to :8000). Build/typecheck: `npm run build`.
- Full stack: `docker compose up --build` (frontend :3000, api :8000, redis :6379)
- Regenerate README charts: `.venv/bin/python -m visualization.plots` -> docs/assets/
- Deploy: GitHub Actions auto-deploys to Railway on green main (needs RAILWAY_TOKEN secret);
  see DEPLOY.md. CI mirrors local: `pytest tests/ -q` + `cd frontend && npm run typecheck`.

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
  (coarser quadrature/grid/maxiter) and is background-computed + long-cached.
- The synthetic surface adds a small non-Heston wing bump (`smile_perturb`) so offline
  calibration error is realistic (~0.1%) and residual correction has structure to fix.
- Heavy compute runs in `run_in_threadpool`; the WS runs calibrate in a worker thread and
  bridges per-iteration progress to the event loop via a thread-safe queue.
- **Frontend:** `verbatimModuleSyntax` is on — use `import type` for type-only imports.
  Plotly is imported only via `src/components/Plot.tsx` (factory bound to dist-min); never
  import `react-plotly.js` directly (its default expects the full `plotly.js`). The bundle
  is large (~1.5 MB gzip) because Plotly is monolithic — acceptable for this tool.
- `/api/regime/parameters` returns 202 while computing; the frontend surfaces that as
  `AnalysisPendingError` and polls via React Query `refetchInterval` (rendered as "computing").
- Three additive, non-breaking fields were added to `RegimeParametersResponse` for the
  dashboard: `param_samples`, `static_mae_by_regime`, `regime_mae_by_regime`.
- **Hardening:** `/api/calibration/run` is rate-limited (1/min/IP, cache-backed, config
  `api.rate_limit`); gzip via GZipMiddleware; live fetches have a `data.request_timeout`
  (thread + future timeout) that falls back to cache/synthetic; JSON request logging with
  X-Request-ID; Sentry inits only if `SENTRY_DSN` set; prod CORS from `CORS_ORIGINS` env.
- **CI/CD:** ci.yml runs on push/PR; deploy.yml triggers via `workflow_run` only after CI
  succeeds on main/master and no-ops without `RAILWAY_TOKEN`. Default branch here is
  `master`; workflows trigger on both main and master.
- Rate-limit tests use a fresh app per test (function-scoped client) so buckets are clean;
  only `/api/calibration/run` is limited, so other endpoints' tests are unaffected.
