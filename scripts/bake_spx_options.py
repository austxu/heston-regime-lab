"""Bake a real SPX implied-volatility snapshot for the browser lab and fit every model to it.

1. Read Cboe's public delayed-quote chain for SPX (download, or ``--input`` a saved copy).
2. :func:`data.cboe.build_snapshot`: parity-implied forwards and discount factors, OTM
   liquidity filter, ~21 strikes on each of ~12 expiries from one week to two years.
3. Fit raw SVI per expiry (:mod:`models.svi`) and calibrate Heston, Bates and double
   Heston to the whole surface (:mod:`calibration.market`), as the offline reference that
   the browser's own calibration is compared against.

Only derived values are written (log-moneyness, strikes, bid / mid / ask Black implied
vols, forwards, discount factors and fits); raw prices, sizes and open interest are not.
The fits run on the rounded values that are written, so browser and Python see identical
inputs.

Usage::

    .venv/bin/python -m scripts.bake_spx_options                       # download now
    .venv/bin/python -m scripts.bake_spx_options --input chain.json    # saved chain

Writes ``frontend/src/data/spx.json``.
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from calibration.market import MODELS, Slice, calibrate_market, fit_stats
from data import cboe
from models.svi import SVI_NAMES, fit_svi, svi_g, svi_w

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "frontend" / "src" / "data" / "spx.json"
URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json"


def download() -> dict:
    req = urllib.request.Request(
        URL, headers={"User-Agent": "Mozilla/5.0 (heston-regime-lab bake)"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:  # noqa: S310 (fixed https URL)
        return json.load(resp)


def r6(a: np.ndarray) -> list[float]:
    return [round(float(x), 6) for x in a]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", type=Path, help="a saved Cboe chain JSON instead of downloading")
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    args = ap.parse_args()

    raw = json.loads(args.input.read_text()) if args.input else download()
    as_of, spot, built = cboe.build_snapshot(raw)
    underlying = raw["data"]

    # Round first so the reference fits use exactly the numbers the browser will read.
    slices = [
        Slice(
            tau=round(s.tau, 8),
            k=np.array(r6(s.k)),
            iv=np.array(r6(s.iv)),
            iv_bid=np.array(r6(s.iv_bid)),
            iv_ask=np.array(r6(s.iv_ask)),
            atm_vol=round(s.atm_vol, 6),
        )
        for s in built
    ]

    svi_out = []
    svi_iv = []
    for s in slices:
        # No butterfly arbitrage on the density tab's grid, [-8a, 4a] with a = vol_atm sqrt(tau).
        a = s.atm_vol * np.sqrt(s.tau)
        p, rmse = fit_svi(s.k, s.iv, s.tau, check=(-8 * a, 4 * a))
        grid = np.linspace(-8 * a, 4 * a, 2401)
        svi_out.append(
            {
                **dict(zip(SVI_NAMES, (float(x) for x in p), strict=True)),
                "rmse": rmse,
                "minG": float(svi_g(grid, p).min()),
            }
        )
        svi_iv.append(np.sqrt(svi_w(s.k, p) / s.tau))
    # Calendar check: total variance must not decrease with maturity at fixed k.
    kk = np.linspace(-0.3, 0.1, 81)
    ws = np.array([svi_w(kk, np.array([o[n] for n in SVI_NAMES])) for o in svi_out])
    calendar_violations = int(np.sum(np.diff(ws, axis=0) < -1e-6))

    fits: dict[str, dict] = {}
    fits["heston"] = calibrate_market(
        "heston",
        slices,
        [[1.0, 0.06, 0.3, -0.4, 0.05], [3.0, 0.04, 1.0, -0.8, 0.05], [10.0, 0.04, 3.0, -0.8, 0.07]],
    )
    hp = list(fits["heston"]["params"].values())
    fits["bates"] = calibrate_market(
        "bates",
        slices,
        [
            hp + [0.5, -0.1, 0.1],
            hp + [0.1, -0.25, 0.15],
            [2.0, 0.04, 0.8, -0.7, 0.04, 0.3, -0.15, 0.1],
        ],
    )
    fits["double"] = calibrate_market(
        "double",
        slices,
        [
            [8.0, 0.02, 1.5, -0.9, 0.04, 0.5, 0.03, 0.4, -0.6, 0.03],
            [15.0, 0.01, 2.5, -0.95, 0.05, 1.0, 0.04, 0.6, -0.7, 0.02],
        ],
    )
    fits["svi"] = {**fit_stats(svi_iv, slices), "calendarViolations": calendar_violations}
    for name, f in fits.items():
        print(
            f"{name:7s} rmse {f['rmse'] * 100:.3f} vp  inside {f['inside']:.1%}  {f.get('seconds', 0):.1f}s"
        )

    out = {
        "source": {
            "name": "Cboe delayed quotes, SPX and SPXW index options",
            "url": "https://www.cboe.com/delayed_quotes/spx/quote_table",
            "note": "Derived values only: implied vols from bid/ask quotes, parity-implied forwards. Delayed data, not for trading.",
        },
        "asOf": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "spot": round(spot, 2),
        "spotChangePct": round(float(underlying.get("price_change_percent") or 0.0), 3),
        "filters": {
            "maxRelSpread": cboe.MAX_REL_SPREAD,
            "zRange": [cboe.Z_LO, cboe.Z_HI],
            "strikesPerExpiry": cboe.N_STRIKES,
            "targetDays": list(cboe.TARGET_DAYS),
        },
        "slices": [
            {
                "expiry": b.expiry,
                "root": b.root,
                "settle": "PM" if b.root == "SPXW" else "AM",
                "tau": s.tau,
                "forward": round(b.forward, 4),
                "discount": round(b.discount, 7),
                "atmVol": s.atm_vol,
                "listed": b.n_listed,
                "strike": [float(x) for x in b.strike],
                "k": list(s.k),
                "iv": list(s.iv),
                "ivBid": list(s.iv_bid),
                "ivAsk": list(s.iv_ask),
                "svi": svi,
            }
            for b, s, svi in zip(built, slices, svi_out, strict=True)
        ],
        "bounds": {name: [list(b) for b in spec.bounds] for name, spec in MODELS.items()},
        "fits": fits,
    }
    args.out.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(
        f"wrote {args.out.relative_to(ROOT)} ({args.out.stat().st_size / 1024:.0f} KB), as of {out['asOf']}"
    )


if __name__ == "__main__":
    main()
