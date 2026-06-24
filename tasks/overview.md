# heston-regime-lab — Project Overview

## 1. Purpose & Goals
A stochastic-volatility research lab. The end goal (4 phases) is to calibrate the
Heston model to SPX options, detect market regimes with an HMM, and study how Heston
parameters and calibration error vary across regimes.

**Current status: Phase 1 — the mathematical core only.** No application/data layer yet.
Phase 1 must get the pricing + calibration math provably correct on *synthetic* data
before any real market data is touched.

Phases (for context, not yet built):
- Phase 1 (THIS): Heston char. function, Gil-Pelaez/Gauss-Legendre pricing, Black-Scholes
  baseline + implied-vol inversion, L-BFGS-B calibration, synthetic round-trip validation.
- Phase 2: Data layer (yfinance/FRED fetchers, IV computation, liquidity filtering, vol features).
- Phase 3: Real-data calibration validation + XGBoost residual correction + diagnostic plots.
- Phase 4: HMM regime detection + regime-conditional recalibration.

## 2. Tech Stack
- Python 3.14, numpy 2.3, scipy 1.18 (optimize, integrate, stats).
- pyyaml for config. pytest for tests.
- Phase 2+ (not installed yet): yfinance, pandas, fredapi, xgboost, hmmlearn, matplotlib.
- Virtualenv at `.venv` (created `--system-site-packages` to reuse system numpy/scipy).

## 3. Architecture / Codebase Map
```
models/heston.py        Heston characteristic function + Gil-Pelaez pricing (Gauss-Legendre)
models/black_scholes.py Black-Scholes pricing + implied-vol inversion (Brent)
models/hmm.py           [Phase 4 stub]
data/fetchers.py        [Phase 2 stub]
data/features.py        [Phase 2 stub]
calibration/optimizer.py  L-BFGS-B nonlinear least-squares calibration
calibration/validators.py synthetic-data generation + round-trip validation
analysis/               [Phase 3/4 stubs]
visualization/plots.py  [Phase 3 stub]
configs/base.yaml       all hyperparameters (market, quadrature, calibration, synthetic)
tests/test_synthetic.py pytest: round-trip recovery within 1%, put-call parity, BS<->IV
```
Data flow (phase 1): `configs/base.yaml` → synthetic Heston prices (`validators`) →
calibrate (`optimizer` → `heston` pricing) → compare recovered vs ground-truth params.

## 4. Build / Run / Test
- Activate env: `source .venv/bin/activate` (or use `.venv/bin/python`).
- Run tests: `.venv/bin/python -m pytest tests/ -q`
- Run synthetic validation as a script: `.venv/bin/python -m calibration.validators`

## 5. Conventions & Gotchas
- Char. function uses the **"little Heston trap"** (Albrecher et al. 2007) g2 formulation
  to avoid branch-cut discontinuities of the complex log — do NOT switch back to g1.
- Gil-Pelaez integrands have a removable singularity at u=0; integrate over (0, U] with
  Gauss-Legendre nodes that never hit 0, so the singularity is never evaluated.
- All rates/vols are continuously-compounded, annualized; time in years.
- Calibration optimizes in IV space (relative) by default; bounds enforce Feller-ish ranges.
- Type hints + math-heavy docstrings everywhere (interview requirement).
