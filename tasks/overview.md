# heston-regime-lab — Project Overview

## 1. Purpose & Goals
A stochastic-volatility research lab. Calibrate the Heston model to SPX options, detect
market regimes with an HMM, and study how Heston parameters and calibration error vary
across regimes — exposed as a live API.

**Current status: Phase 2 — production FastAPI backend.** The Phase 1 math core
(Heston/Gil-Pelaez pricing, BS, L-BFGS-B calibration) is validated on synthetic data.
Phase 2 added the data layer, HMM regimes, residual correction, and a FastAPI + Redis +
WebSocket service that serves all of it live, with a deterministic synthetic fallback so
the whole stack runs offline.

Phases:
- Phase 1 ✅ Math core (char. fn, Gil-Pelaez/Gauss-Legendre, BS+IV, calibration, round-trip).
- Phase 2 ✅ Data layer, vol features, 3-state HMM, XGBoost residual correction,
  Kruskal-Wallis/regime-conditional analysis, FastAPI/Redis/WebSocket API, Docker.
- Phase 3 (next): diagnostic plots / dashboard frontend.
- Phase 4: deeper regime study and recalibration.

## 2. Tech Stack
- Python 3.14 locally (Docker image uses 3.12-slim). numpy, scipy, pandas.
- Models/data: hmmlearn (GaussianHMM), xgboost (needs OpenMP: `brew install libomp`;
  sklearn GradientBoosting fallback), scikit-learn.
- Live data: yfinance (SPX/VIX), fredapi (risk-free); all with synthetic fallback.
- API: FastAPI, uvicorn, pydantic v2, redis (in-memory fallback), websockets.
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
docker/Dockerfile.api, docker-compose.yml   api + redis
configs/base.yaml         all hyperparameters (market, quadrature, calibration, data,
                          hmm, residual_model, api)
tests/test_synthetic.py   Phase 1 math-core suite
tests/test_phase2_api.py  Phase 2: data/HMM/cache/endpoints (offline, deterministic)
```
Data flow (API): request -> route -> service (cache.get_or_compute) ->
fetchers.get_market_snapshot (live|stale-cache|synthetic) -> filter liquid ->
calibrate / fit HMM / compare -> Pydantic response with provenance.

## 4. Build / Run / Test
- Activate env: `source .venv/bin/activate` (or use `.venv/bin/python`).
- Tests: `.venv/bin/python -m pytest tests/ -q`
- Round-trip demo: `.venv/bin/python -m calibration.validators`
- API offline: `HRL_OFFLINE=1 .venv/bin/uvicorn api.main:app --reload` -> http://localhost:8000/docs
- Full stack: `docker compose up --build` (api :8000, redis :6379)

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
