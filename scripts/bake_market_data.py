"""Bake the browser lab's market-history JSON from public FRED data.

The static lab (``frontend/``) never calls a server.  Everything it shows about real
markets comes from one compact JSON file produced here, offline, with the repository's
own research code:

1. Download daily public series from FRED's keyless CSV endpoint:
   ``SP500`` (S&P 500 close, ~10y), ``VIXCLS`` (VIX), ``VXVCLS`` (VIX3M) and
   ``DGS3MO`` (3-month T-bill, the risk-free proxy).
2. Engineer the regime features with :func:`data.features.engineer_features` and fit the
   repo's 3-state Gaussian HMM (:func:`models.hmm.fit_regime_hmm`).  FRED has no index
   volume, so ``volume_ratio`` is dropped from the HMM inputs (it would be a constant).
3. Estimate **regime-conditional Heston parameters** from the real VIX term structure
   and VIX dynamics on the days the HMM assigns to each regime (see ``estimate_kappa``
   and ``estimate_params``).
4. Generate a **synthetic** option surface per regime from those parameters plus
   Gaussian IV noise (the repo's ``analysis.regime_analysis`` approach — there is no free
   historical option-chain feed) and calibrate it with the repo's L-BFGS-B optimiser, so
   the browser's optimiser can be compared against the Python optimum on identical inputs.

Usage::

    HRL_OFFLINE=1 .venv/bin/python -m scripts.bake_market_data            # download
    HRL_OFFLINE=1 .venv/bin/python -m scripts.bake_market_data --cache-dir /tmp/fred

Writes ``frontend/src/data/market.json``.
"""

from __future__ import annotations

import argparse
import io
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from calibration.optimizer import MarketData, calibrate, heston_implied_vols, load_config
from calibration.validators import CONFIG_PATH
from data.features import engineer_features, feature_matrix
from models.heston import HestonParams

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "frontend" / "src" / "data" / "market.json"
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"
SERIES = ("SP500", "VIXCLS", "VXVCLS", "DGS3MO")
PARAM_NAMES = ("kappa", "theta", "sigma", "rho", "v0")

# HMM inputs: the repo's configured columns minus volume_ratio (FRED has no volume).
HMM_FEATURES = ["rv_21d", "vix", "vix_slope", "ret_skew_63d"]
DISPLAY_NAMES = ["calm", "normal", "stressed"]

# Synthetic option grid (per regime): maturities in days and strikes placed at fixed
# multiples of the regime's own vol * sqrt(T) around the forward, like a delta grid.
GRID_DAYS = [30, 61, 91, 182, 365, 730]
GRID_Z = [-2.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5]
NOISE_IV = 0.003  # std of Gaussian IV noise (0.3 vol points), as in regime_analysis
SPOT = 100.0
SEED = 20261105

T_VIX = 30.0 / 365.0
T_VIX3M = 93.0 / 365.0
DT = 1.0 / 252.0


def fetch_series(series: str, cache_dir: Path | None) -> pd.Series:
    """One FRED series as a float Series indexed by date (missing '.' rows dropped)."""
    text: str | None = None
    if cache_dir is not None and (cache_dir / f"{series}.csv").exists():
        text = (cache_dir / f"{series}.csv").read_text()
    if text is None:
        req = urllib.request.Request(
            FRED_URL.format(series=series), headers={"User-Agent": "heston-regime-lab/bake"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (fixed https URL)
            text = resp.read().decode("utf-8")
        if cache_dir is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)
            (cache_dir / f"{series}.csv").write_text(text)
    frame = pd.read_csv(io.StringIO(text), na_values=["."])
    frame.columns = ["date", "value"]
    frame["date"] = pd.to_datetime(frame["date"])
    return frame.dropna().set_index("date")["value"].astype(float)


def _b(kappa: float, tau: float) -> float:
    """Heston loading of v0 in the expected average variance over [0, tau]."""
    x = kappa * tau
    return (1.0 - np.exp(-x)) / x


def estimate_kappa(frame: pd.DataFrame, bounds: dict) -> tuple[float, float]:
    """Mean-reversion speed implied by the VIX term structure over the full sample.

    Under Heston, the risk-neutral expected average variance over ``[0, T]`` is
    ``theta + (v0 - theta) B(kappa, T)`` with ``B = (1 - e^{-kappa T}) / (kappa T)``.
    Treating VIX^2 and VIX3M^2 as those expectations at 30 and 93 days and eliminating
    ``v0`` gives ``VIX3M^2 = theta (1 - s) + s VIX^2`` with ``s = B(93d) / B(30d)``,
    which is decreasing in ``kappa``.  The OLS slope of VIX3M^2 on VIX^2 identifies ``s``
    and hence one shared ``kappa``.  (Within a single regime the VIX range is too narrow
    for the slope to be stable, so ``kappa`` is pooled; ``theta``/``v0`` are per regime.)
    """
    v1 = (frame["vix"].to_numpy() / 100.0) ** 2
    v3 = (frame["vix3m"].to_numpy() / 100.0) ** 2
    slope = float(np.polyfit(v1, v3, 1)[0])
    lo_k, hi_k = bounds["kappa"]
    s = float(np.clip(slope, _ratio(hi_k) + 1e-9, _ratio(lo_k) - 1e-9))
    a, b = lo_k, hi_k
    for _ in range(200):  # bisection on the monotone slope -> kappa map
        mid = 0.5 * (a + b)
        a, b = (mid, b) if _ratio(mid) > s else (a, mid)
    return 0.5 * (a + b), slope


def _ratio(kappa: float) -> float:
    return _b(kappa, T_VIX3M) / _b(kappa, T_VIX)


def estimate_params(days: pd.DataFrame, kappa: float, bounds: dict) -> tuple[HestonParams, dict]:
    """Regime-conditional Heston parameters from VIX/VIX3M on one regime's days.

    Given the pooled ``kappa`` (see :func:`estimate_kappa`):

    * each day's long-run level follows from the two tenors,
      ``theta_t = (VIX3M^2 - s VIX^2) / (1 - s)``; the regime's ``theta`` is the median;
    * each day's instantaneous variance is ``v0_t = theta + (VIX^2 - theta) / B(30d)``;
      the regime's ``v0`` is the median;
    * ``sigma`` is the annualised std of ``dv0_t / sqrt(v0_{t-1})`` over consecutive
      in-regime days (Euler discretisation of ``dv = ... + sigma sqrt(v) dW``);
    * ``rho`` is the correlation of daily SPX log returns with ``dv0_t``.

    Every estimate is clamped to the calibration bounds in ``configs/base.yaml``.
    """
    v1 = (days["vix"].to_numpy() / 100.0) ** 2
    v3 = (days["vix3m"].to_numpy() / 100.0) ** 2
    s = _ratio(kappa)
    theta = float(np.clip(np.median((v3 - s * v1) / (1.0 - s)), *bounds["theta"]))

    b30 = _b(kappa, T_VIX)
    v0_t = np.maximum(theta + (v1 - theta) / b30, 1e-4)
    v0 = float(np.clip(np.median(v0_t), *bounds["v0"]))

    # Only consecutive trading days that are both in this regime.
    pos = days["pos"].to_numpy()
    consecutive = np.diff(pos) == 1
    dv = np.diff(v0_t)[consecutive]
    scaled = dv / np.sqrt(v0_t[:-1][consecutive])
    sigma = float(np.clip(np.std(scaled, ddof=1) / np.sqrt(DT), *bounds["sigma"]))
    ret = days["ret"].to_numpy()[1:][consecutive]
    rho = float(np.clip(np.corrcoef(ret, dv)[0, 1], *bounds["rho"]))

    params = HestonParams(kappa=float(kappa), theta=theta, sigma=sigma, rho=rho, v0=v0)
    return params, {"nDays": int(len(days)), "nPairs": int(consecutive.sum())}


def synthetic_quotes(params: HestonParams, rate: float, config: dict, rng) -> MarketData:
    """A noisy synthetic IV surface from ``params`` on a delta-like strike grid."""
    ref_vol = float(np.sqrt(0.5 * (params.v0 + params.theta)))
    strikes, mats = [], []
    for days in GRID_DAYS:
        tau = days / 365.0
        fwd = SPOT * np.exp(rate * tau)
        for z in GRID_Z:
            strikes.append(round(fwd * np.exp(z * ref_vol * np.sqrt(tau)) * 2.0) / 2.0)
            mats.append(tau)
    data = MarketData(SPOT, rate, 0.0, np.array(strikes), np.array(mats), np.full(len(mats), 0.2))
    quad = config["quadrature"]
    iv = heston_implied_vols(
        params, data, n_nodes=int(quad["n_nodes"]), upper_limit=float(quad["upper_limit"])
    )
    iv = iv + rng.normal(0.0, NOISE_IV, size=iv.shape)
    ok = np.isfinite(iv) & (iv > 0.01)  # liquidity filter: invertible quotes only
    return MarketData(SPOT, rate, 0.0, data.strikes[ok], data.maturities[ok], iv[ok])


def _round(values, digits: int) -> list:
    return [None if not np.isfinite(v) else round(float(v), digits) for v in values]


def spells(labels: np.ndarray, k: int) -> list[int]:
    """Lengths (in trading days) of consecutive runs of regime ``k``."""
    out, run = [], 0
    for lab in labels:
        if lab == k:
            run += 1
        elif run:
            out.append(run)
            run = 0
    if run:
        out.append(run)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache-dir", type=Path, default=None, help="read/write raw CSVs here")
    parser.add_argument("--out", type=Path, default=OUT_PATH)
    args = parser.parse_args()

    config = load_config(CONFIG_PATH)
    config["hmm"]["feature_cols"] = HMM_FEATURES
    bounds = config["calibration"]["bounds"]

    raw = {s: fetch_series(s, args.cache_dir) for s in SERIES}
    spx = raw["SP500"].sort_index()
    limit = int(config["data"]["vix_forward_fill_days"])
    vix = pd.DataFrame({"vix": raw["VIXCLS"], "vix3m": raw["VXVCLS"]}).sort_index()
    vix["vix9d"] = vix["vix"]  # not on FRED; unused by the HMM features
    rate = raw["DGS3MO"].reindex(spx.index).ffill(limit=limit).bfill() / 100.0

    feats = engineer_features(pd.DataFrame({"close": spx}), vix, config)
    X = feature_matrix(feats, HMM_FEATURES)

    from models.hmm import fit_regime_hmm

    model = fit_regime_hmm(X, config)
    labels = model.decode(X)
    post = model.posteriors(X)
    K = model.n_states

    idx = feats.index
    spx_v = spx.reindex(idx).to_numpy()
    rate_v = rate.reindex(idx).to_numpy()
    as_of = idx[-1].strftime("%Y-%m-%d")
    latest_rate = float(rate_v[-1])

    hmm_raw = model.hmm
    transmat = np.asarray(hmm_raw.transmat_)[np.ix_(model.state_order, model.state_order)]
    means_std = np.asarray(hmm_raw.means_)[model.state_order]
    means = means_std * model.std + model.mean

    frame = feats.assign(regime=labels, pos=np.arange(len(feats)))
    kappa, term_slope = estimate_kappa(frame, bounds)
    rng = np.random.default_rng(SEED)
    regimes = []
    for k in range(K):
        days = frame[frame["regime"] == k]
        params, diag = estimate_params(days, kappa, bounds)
        quotes = synthetic_quotes(params, latest_rate, config, rng)
        t0 = time.perf_counter()
        fit = calibrate(quotes, config)
        elapsed = time.perf_counter() - t0
        resid = fit.model_iv - quotes.market_iv
        run_lengths = spells(labels, k)
        ret = days["ret"].to_numpy()
        regimes.append(
            {
                "key": model.labels[k],
                "name": DISPLAY_NAMES[k],
                "share": round(float(len(days) / len(frame)), 4),
                "days": int(len(days)),
                "stats": {
                    "vixMean": round(float(days["vix"].mean()), 2),
                    "vixMedian": round(float(days["vix"].median()), 2),
                    "vix3mMean": round(float(days["vix3m"].mean()), 2),
                    "termSlopeMean": round(float(days["vix_slope"].mean()), 2),
                    "realizedVol": round(float(np.std(ret, ddof=1) * np.sqrt(252)), 4),
                    "rv21Mean": round(float(days["rv_21d"].mean()), 4),
                    "annReturn": round(float(np.mean(ret) * 252), 4),
                    "skew63Mean": round(float(days["ret_skew_63d"].mean()), 3),
                    "spells": len(run_lengths),
                    "meanSpell": round(float(np.mean(run_lengths)), 1),
                    "maxSpell": int(np.max(run_lengths)),
                    "expectedDuration": round(float(1.0 / max(1e-9, 1.0 - transmat[k, k])), 1),
                },
                "params": {n: round(float(getattr(params, n)), 5) for n in PARAM_NAMES},
                "estimation": diag,
                "quotes": {
                    "spot": SPOT,
                    "rate": round(latest_rate, 6),
                    "noiseIv": NOISE_IV,
                    "seed": SEED,
                    "strike": _round(quotes.strikes, 2),
                    "maturity": _round(quotes.maturities, 6),
                    "iv": _round(quotes.market_iv, 6),
                },
                "python": {
                    "params": {n: float(getattr(fit.params, n)) for n in PARAM_NAMES},
                    "loss": float(np.sum(resid**2)),
                    "rmseIv": float(fit.rmse_iv),
                    "nit": int(fit.n_iter),
                    "nfev": int(fit.n_feval),
                    "seconds": round(elapsed, 2),
                    "message": fit.message,
                },
            }
        )
        print(
            f"[{model.labels[k]:>12}] days={len(days):5d} params="
            + ", ".join(f"{n}={getattr(params, n):.4f}" for n in PARAM_NAMES)
            + f" | py fit rmse={fit.rmse_iv * 100:.3f} vol pts in {elapsed:.1f}s"
        )

    # Standardised features (rounded) so the browser can refit the HMM with K = 2..4.
    Xs = (X - model.mean) / model.std
    t_days = (idx - idx[0]).days.to_numpy()
    out = {
        "asOf": as_of,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "sources": {
            "spx": "FRED SP500 (S&P 500 index close)",
            "vix": "FRED VIXCLS (CBOE VIX close)",
            "vix3m": "FRED VXVCLS (CBOE VIX3M close)",
            "rate": "FRED DGS3MO (3-month Treasury, % -> decimal)",
        },
        "start": idx[0].strftime("%Y-%m-%d"),
        "series": {
            "t": [int(d) for d in t_days],
            "spx": _round(spx_v, 2),
            "vix": _round(feats["vix"].to_numpy(), 2),
            "vix3m": _round(feats["vix3m"].to_numpy(), 2),
            "rate": _round(rate_v * 100.0, 2),
            "rv21": _round(feats["rv_21d"].to_numpy() * 100.0, 1),
            "regime": [int(v) for v in labels],
            "post": [[int(round(p * 1000)) for p in post[:, k]] for k in range(K)],
        },
        "features": {
            "cols": HMM_FEATURES,
            "mean": _round(model.mean, 6),
            "std": _round(model.std, 6),
            "z": [_round(Xs[:, j], 3) for j in range(Xs.shape[1])],
        },
        "hmm": {
            "K": K,
            "covariance": config["hmm"]["covariance_type"],
            "transmat": [_round(row, 5) for row in transmat],
            "means": [_round(row, 4) for row in means],
        },
        "latestRate": round(latest_rate, 6),
        "estimation": {
            "kappa": round(float(kappa), 5),
            "termSlope": round(term_slope, 5),
            "tenorsDays": [30, 93],
            "method": "kappa: pooled OLS of VIX3M^2 on VIX^2; theta, v0: per-regime medians "
            "implied by the two tenors; sigma: std of dv0/sqrt(v0); rho: corr(SPX ret, dv0)",
        },
        "regimes": regimes,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {args.out} ({args.out.stat().st_size / 1024:.0f} KB), as of {as_of}")


if __name__ == "__main__":
    main()
