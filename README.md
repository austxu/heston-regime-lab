# heston-regime-lab

Stochastic-volatility research lab: calibrate the **Heston** model to SPX options, detect
market **regimes** with a hidden Markov model, and study how Heston parameters and
calibration error change across regimes.

> **Status: Phase 1 / 4 — mathematical core.** Pricing and calibration proven on synthetic
> data. Data, regime, and ML layers come in later phases.

## Phases
1. **Math core (this phase):** Heston characteristic function, Gil-Pelaez Fourier inversion
   with Gauss-Legendre quadrature, Black-Scholes baseline + implied-vol inversion, L-BFGS-B
   calibration, synthetic round-trip validation (recover ground-truth params within 1%).
2. Data layer (yfinance/FRED, IV computation, liquidity filtering, vol features).
3. Real-data calibration validation, XGBoost residual correction, diagnostic plots.
4. HMM regime detection, regime-conditional recalibration.

## Quickstart
```bash
python -m venv --system-site-packages .venv && source .venv/bin/activate
pip install -r requirements.txt
pytest tests/ -q                      # full synthetic test suite
python -m calibration.validators      # round-trip calibration demo
```

## Layout
```
models/heston.py          Heston char. function + Gil-Pelaez pricing (Gauss-Legendre)
models/black_scholes.py   Black-Scholes pricing + implied-vol inversion (Brent)
calibration/optimizer.py  L-BFGS-B nonlinear least-squares calibration
calibration/validators.py synthetic data generation + round-trip validation
configs/base.yaml         all hyperparameters
tests/test_synthetic.py   pytest suite
```

The mathematical derivations (characteristic function, Gil-Pelaez inversion, HMM) are in
[Mathematical background](#mathematical-background) below.

## Mathematical background
_See the derivations section added alongside the implementation._
