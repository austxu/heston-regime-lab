"""Emit Python reference values that the browser lab's TypeScript math core is tested against.

Every number here comes from the repository's own Python implementation
(``models.heston``, ``models.black_scholes``, ``calibration.optimizer`` and
``calibration.validators``), so ``frontend/src/math/*.test.ts`` proves the TypeScript port
is faithful rather than merely plausible.

Usage::

    HRL_OFFLINE=1 .venv/bin/python -m scripts.make_parity_fixtures

Writes ``frontend/src/math/__fixtures__/parity.json`` and, for the real-market models
(``models.fourier``, ``models.bates``, ``models.double_heston``, ``models.svi``),
``frontend/src/math/__fixtures__/market.json``.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from calibration.market import MODELS
from calibration.optimizer import MarketData, calibrate, heston_implied_vols, load_config
from calibration.validators import CONFIG_PATH, generate_synthetic_data
from models.black_scholes import bs_price, bs_vega, implied_vol
from models.fourier import density_nodes, implied_vol_otm, log_density, otm_price, slice_nodes
from models.heston import (
    HestonParams,
    _gauss_legendre_nodes,
    heston_characteristic_function,
    heston_price,
)
from models.svi import svi_density, svi_g, svi_w

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend" / "src" / "math" / "__fixtures__" / "parity.json"
OUT_MARKET = OUT.with_name("market.json")
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


# Parameter vectors in calibration.market order; values typical of fits to SPX.
MARKET_PARAMS = {
    "heston": [12.8, 0.05, 3.8, -0.76, 0.093],
    "bates": [4.2, 0.034, 2.0, -0.84, 0.065, 0.77, -0.09, 0.11],
    "double": [35.0, 0.024, 6.2, -0.78, 0.095, 0.53, 0.062, 1.3, -0.8, 0.024],
}
MARKET_SLICES = [(0.0219, 0.27), (0.25, 0.19), (2.1, 0.18)]
SVI_SET = [0.01, 0.12, -0.6, 0.02, 0.15]


def cplx(z: np.ndarray) -> list[list[float]]:
    return [[float(v.real), float(v.imag)] for v in np.atleast_1d(z)]


def market_fixtures() -> None:
    u = np.array([0.3, 2.0, 15.0, 120.0])
    u = np.concatenate([u + 0j, u - 0.5j, u - 1j])
    out: dict = {"u": cplx(u), "models": {}, "svi": {}}
    a, t = MARKET_SLICES[1]
    nodes, weights = slice_nodes(a, t)
    out["nodes"] = {"atm": a, "tau": t, "nodes": nodes.tolist(), "weights": weights.tolist()}
    for name, p in MARKET_PARAMS.items():
        spec = MODELS[name]
        rows = []
        for tau, atm in MARKET_SLICES:
            cf = spec.cf(np.array(p), tau)
            quad = slice_nodes(atm, tau)
            sd = atm * np.sqrt(tau)
            k = np.linspace(-3.0, 1.75, 9) * sd
            x = np.linspace(-8.0, 4.0, 13) * sd
            price = otm_price(cf, k, quad)
            rows.append(
                {
                    "tau": tau,
                    "atm": atm,
                    "phi": cplx(cf(u)),
                    "k": k.tolist(),
                    "otm": price.tolist(),
                    "iv": [
                        None if not np.isfinite(v) else float(v)
                        for v in implied_vol_otm(price, k, tau)
                    ],
                    "x": x.tolist(),
                    "density": log_density(cf, x, density_nodes(atm, tau)).tolist(),
                }
            )
        out["models"][name] = {"params": p, "slices": rows}
    k = np.linspace(-0.6, 0.4, 11)
    out["svi"] = {
        "params": dict(zip(("a", "b", "rho", "m", "s"), SVI_SET, strict=True)),
        "k": k.tolist(),
        "w": svi_w(k, np.array(SVI_SET)).tolist(),
        "g": svi_g(k, np.array(SVI_SET)).tolist(),
        "density": svi_density(k, np.array(SVI_SET)).tolist(),
    }
    OUT_MARKET.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT_MARKET} ({OUT_MARKET.stat().st_size / 1024:.0f} KB)")


def main() -> None:
    market_fixtures()
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
