"""Emit Python reference values that the browser lab's TypeScript math core is tested against.

Every number here comes from the repository's own Python implementation
(``models.heston``, ``models.black_scholes``, ``calibration.optimizer`` and
``calibration.validators``), so ``frontend/src/math/*.test.ts`` proves the TypeScript port
is faithful rather than merely plausible.

Usage::

    HRL_OFFLINE=1 .venv/bin/python -m scripts.make_parity_fixtures

Writes ``frontend/src/math/__fixtures__/parity.json``.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from calibration.optimizer import MarketData, calibrate, heston_implied_vols, load_config
from calibration.validators import CONFIG_PATH, generate_synthetic_data
from models.black_scholes import bs_price, bs_vega, implied_vol
from models.heston import (
    HestonParams,
    _gauss_legendre_nodes,
    heston_characteristic_function,
    heston_price,
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend" / "src" / "math" / "__fixtures__" / "parity.json"
NAMES = ("kappa", "theta", "sigma", "rho", "v0")

PARAM_SETS = {
    "base": HestonParams(kappa=2.0, theta=0.04, sigma=0.5, rho=-0.7, v0=0.04),
    "calm": HestonParams(kappa=3.0, theta=0.015, sigma=0.30, rho=-0.55, v0=0.012),
    "crisis": HestonParams(kappa=1.5, theta=0.110, sigma=0.95, rho=-0.80, v0=0.130),
    "extreme": HestonParams(kappa=0.4, theta=0.09, sigma=1.8, rho=-0.95, v0=0.02),
    "positive_rho": HestonParams(kappa=6.0, theta=0.02, sigma=0.2, rho=0.5, v0=0.06),
}
SPOT, RATE, DIV = 100.0, 0.03, 0.01
TAUS = [0.02, 0.1, 0.5, 1.0, 2.0, 5.0]
STRIKES = [60.0, 75.0, 85.0, 92.5, 100.0, 107.5, 115.0, 130.0, 160.0]


def as_dict(p: HestonParams) -> dict:
    return {n: float(getattr(p, n)) for n in NAMES}


def main() -> None:
    config = load_config(CONFIG_PATH)
    n_nodes = int(config["quadrature"]["n_nodes"])
    upper = float(config["quadrature"]["upper_limit"])

    nodes, weights = _gauss_legendre_nodes(n_nodes, upper)

    u = np.array([0.0, 0.5, 1.0, 3.0, 10.0, 40.0, 150.0]) + 0.0j
    u = np.concatenate([u, u - 1j])
    charfn = []
    for name, p in PARAM_SETS.items():
        for tau in (0.1, 1.0, 5.0):
            phi = heston_characteristic_function(u, p, SPOT, RATE, DIV, tau)
            charfn.append(
                {
                    "set": name,
                    "tau": tau,
                    "u": [[float(z.real), float(z.imag)] for z in u],
                    "phi": [[float(z.real), float(z.imag)] for z in phi],
                }
            )

    prices = []
    for name, p in PARAM_SETS.items():
        for tau in TAUS:
            calls = heston_price(p, SPOT, np.array(STRIKES), RATE, DIV, tau, "call", n_nodes, upper)
            puts = heston_price(p, SPOT, np.array(STRIKES), RATE, DIV, tau, "put", n_nodes, upper)
            data = MarketData(
                SPOT, RATE, DIV, np.array(STRIKES), np.full(len(STRIKES), tau), np.full(9, 0.2)
            )
            ivs = heston_implied_vols(p, data, n_nodes=n_nodes, upper_limit=upper)
            prices.append(
                {
                    "set": name,
                    "tau": tau,
                    "call": [float(x) for x in calls],
                    "put": [float(x) for x in puts],
                    "iv": [None if not np.isfinite(x) else float(x) for x in ivs],
                }
            )

    bs = []
    for tau in (0.05, 0.5, 2.0):
        for sigma in (0.05, 0.2, 0.6):
            for k in STRIKES:
                for kind in ("call", "put"):
                    price = bs_price(SPOT, k, RATE, DIV, tau, sigma, kind)
                    bs.append(
                        {
                            "k": k,
                            "tau": tau,
                            "sigma": sigma,
                            "type": kind,
                            "price": price,
                            "vega": bs_vega(SPOT, k, RATE, DIV, tau, sigma),
                            "iv": implied_vol(price, SPOT, k, RATE, DIV, tau, kind),
                        }
                    )
    bs = [{**row, "iv": None if not np.isfinite(row["iv"]) else row["iv"]} for row in bs]

    # Synthetic round trip, exactly as calibration.validators.round_trip_validation runs it.
    truth = HestonParams(**{n: float(config["synthetic"]["params"][n]) for n in NAMES})
    data = generate_synthetic_data(truth, config)
    t0 = time.perf_counter()
    fit = calibrate(data, config)
    seconds = time.perf_counter() - t0
    resid = fit.model_iv - data.market_iv

    out = {
        "config": {
            "nNodes": n_nodes,
            "upperLimit": upper,
            "initialGuess": {n: float(config["calibration"]["initial_guess"][n]) for n in NAMES},
            "bounds": {n: [float(x) for x in config["calibration"]["bounds"][n]] for n in NAMES},
        },
        "market": {"spot": SPOT, "rate": RATE, "div": DIV},
        "params": {name: as_dict(p) for name, p in PARAM_SETS.items()},
        "strikes": STRIKES,
        "gl": {"nodes": nodes.tolist(), "weights": weights.tolist()},
        "charfn": charfn,
        "prices": prices,
        "bs": bs,
        "roundTrip": {
            "truth": as_dict(truth),
            "spot": float(data.spot),
            "rate": float(data.rate),
            "div": float(data.div_yield),
            "strike": data.strikes.tolist(),
            "maturity": data.maturities.tolist(),
            "iv": data.market_iv.tolist(),
            "python": {
                "params": as_dict(fit.params),
                "loss": float(np.sum(resid**2)),
                "rmseIv": float(fit.rmse_iv),
                "nit": int(fit.n_iter),
                "nfev": int(fit.n_feval),
                "seconds": round(seconds, 2),
            },
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")
    print(f"python round trip: rmse={fit.rmse_iv:.2e} nit={fit.n_iter} in {seconds:.1f}s")


if __name__ == "__main__":
    main()
