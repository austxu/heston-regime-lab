# TODO — Phase 1: Mathematical Core

Scope: pricing + calibration math, proven on synthetic data. NO application/data layer.

## Plan (each step has a verify condition)
- [x] Scaffold structure, venv, requirements, config, tasks files
      → verify: `import numpy,scipy,pytest,yaml` ok; dirs match spec
- [x] `models/black_scholes.py`: BS call/put with (r,q); vega; implied vol via Brent
      → verify: BS price round-trips through IV inversion to <1e-8; put-call parity holds
- [x] `models/heston.py`: characteristic function (trap g2 formulation)
      → verify: φ(-i) == S0·exp((r-q)T) (martingale check) to ~1e-10
- [x] Gil-Pelaez pricing via Gauss-Legendre quadrature
      → verify: Heston price → as σ,v0→BS-consistent limits matches BS; put-call parity
- [x] Fix numerical instability in complex integration (u→0 limit, trap branch)
      → verify: integrand finite for all u in (0,U]; price stable vs #nodes / U
- [x] `calibration/optimizer.py`: L-BFGS-B NLS fit of (κ,θ,σ,ρ,v0) to IVs
      → verify: objective decreases; respects bounds
- [x] `calibration/validators.py`: synthetic generation + round-trip
      → verify: recovered params within 1% of ground truth
- [x] `tests/test_synthetic.py`: pytest covering all of the above
      → verify: `pytest tests/ -q` all green
- [x] README with LaTeX-style math derivations (char fn, Gil-Pelaez, HMM formulation)
      → verify: derivations present and match code

## Done when
Round-trip calibration recovers ground-truth Heston params within 1%, all tests green,
README documents the math. (Phase 1 complete.)
