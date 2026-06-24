# TODO — Phase 2: Production FastAPI backend

Serve the Heston/HMM research as a live API. Phase 1 (math core) is done; the data
layer, HMM, and residual correction the API depends on were still stubs, so this phase
**also builds those missing backend pieces** (confirmed with the user), then layers a
FastAPI + Redis + WebSocket + Docker service on top.

Data strategy (confirmed): **live yfinance/FRED when reachable, deterministic synthetic
fallback otherwise**, so the API runs end-to-end in an offline sandbox.

## Plan (each step has a verify condition)
- [ ] Deps installed (fastapi, redis, hmmlearn, xgboost, …); requirements + config updated
      → verify: all import; `configs/base.yaml` has an `api:` section
- [ ] `data/fetchers.py`: live SPX options/price/VIX + FRED rate; synthetic fallback; liquidity filter
      → verify: returns a clean chain offline; filters illiquid rows; reports source/as_of
- [ ] `data/features.py`: realized vol 5/21/63d, VIX level, VIX slope, return skew, volume ratio
      → verify: feature frame has expected columns, no NaNs after warmup
- [ ] `models/hmm.py`: GaussianHMM(3), vol-ordered state labels, posteriors
      → verify: 3 states; labels ordered low/elevated/crisis by realized vol
- [ ] `analysis/pricing_comparison.py`: XGBoost residual correction; Heston-vs-flat-BS errors
      → verify: residual correction lowers mean|IV err|; falls back to sklearn if xgboost missing
- [ ] `analysis/regime_analysis.py`: Kruskal-Wallis across regimes; regime-conditional calibration
      → verify: returns per-parameter H/p; regime-conditional error <= static
- [ ] `calibrate(..., callback=)` hook emitting (iter, loss, params) for streaming
      → verify: callback fires each L-BFGS-B iteration; result unchanged when callback=None
- [ ] `api/cache/redis_client.py`: redis + in-memory fallback, TTL, serve-stale-on-error, session keys
      → verify: works with redis down (in-memory); stale served on producer error
- [ ] `api/models/schemas.py`: Pydantic v2 response model per endpoint
      → verify: every route returns a typed model; OpenAPI renders cleanly
- [ ] `api/services/`: orchestration (calibration/surface/regime/comparison)
      → verify: each callable independent of HTTP; cached results reused
- [ ] `api/routes/` + `/health` + BackgroundTasks for long calibration
      → verify: GET endpoints 200 offline; background calibration job schedulable
- [ ] `api/websocket/calibration_stream.py` + `api/main.py` (CORS, lifespan, OpenAPI)
      → verify: WS streams iteration/loss/params; reconnect-safe; app boots
- [ ] `docker/Dockerfile.api` + `docker-compose.yml` (api + redis)
      → verify: compose config valid; image builds conceptually
- [ ] Tests + manual run of every endpoint
      → verify: `pytest -q` green; live server answers /health + all routes
- [ ] README Phase 2 section; focused commits

## Done when
Every spec'd endpoint (calibration/run, surface, regime/current, regime/history,
comparison, /ws/calibration, /health) returns typed, cached, real computed data in
offline mode, with live data flipping on when network is present.
