"""Turn a Cboe delayed-quote SPX chain into a clean, forward-normalised calibration set.

Input: the JSON served at ``https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json``
(every listed SPX / SPXW contract with bid, ask, sizes, open interest, ...).  Output: a
handful of expiries, each with its parity-implied forward and discount factor and ~20
out-of-the-money strikes with bid / mid / ask Black implied vols.  Only these derived
numbers are kept; raw quotes are not written anywhere.

Steps per expiry:

1. **Settlement time.** SPXW contracts settle PM (16:00 New York) on the expiry date; the
   standard SPX monthlies settle AM (09:30) at the open.  tau is ACT/365 from the quote
   timestamp.  PM-settled SPXW is preferred when both roots list the date.
2. **Forward and discount from put-call parity.** C - P = D (F - K): a weighted linear
   fit of call-minus-put mids on strike over near-the-money pairs gives D (slope) and
   D F (intercept).  For expiries under ~5 weeks the slope is too short-lever to pin D, so
   D comes from the median parity-implied rate of the 2-12 month expiries and only F is fit.
3. **Liquidity filter.** OTM leg only (puts below F, calls above), two-sided markets,
   relative spread below 35 %, and |k| within a standardised moneyness band.
4. **Strike thinning.** ~21 strikes per expiry, nearest to an even grid in
   z = k / (vol_atm sqrt(tau)), so every expiry has the same weight in the fit.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np

from models.fourier import implied_vol_otm

NY = ZoneInfo("America/New_York")
SYMBOL = re.compile(r"^(SPXW?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$")

# Target maturities in calendar days; each picks the most open-interest expiry nearby.
TARGET_DAYS = (7, 14, 30, 45, 63, 91, 136, 182, 273, 365, 547, 770)
Z_LO, Z_HI = -3.25, 2.0
N_STRIKES = 21
MAX_REL_SPREAD = 0.35


@dataclass
class Contract:
    root: str
    expiry: str  # YYYY-MM-DD
    right: str  # 'C' | 'P'
    strike: float
    bid: float
    ask: float
    open_interest: float


def parse_chain(raw: dict) -> tuple[datetime, float, list[Contract]]:
    """Quote time (UTC), index level and contracts from the Cboe JSON."""
    as_of = datetime.strptime(raw["timestamp"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    data = raw["data"]
    out = []
    for o in data["options"]:
        m = SYMBOL.match(o["option"])
        if not m:
            continue
        root, yy, mm, dd, right, k = m.groups()
        out.append(
            Contract(
                root=root,
                expiry=f"20{yy}-{mm}-{dd}",
                right=right,
                strike=int(k) / 1000.0,
                bid=float(o.get("bid") or 0.0),
                ask=float(o.get("ask") or 0.0),
                open_interest=float(o.get("open_interest") or 0.0),
            )
        )
    return as_of, float(data["current_price"]), out


def settlement(expiry: str, root: str) -> datetime:
    y, m, d = (int(x) for x in expiry.split("-"))
    hour, minute = (16, 0) if root == "SPXW" else (9, 30)
    return datetime(y, m, d, hour, minute, tzinfo=NY)


def year_fraction(as_of: datetime, expiry: str, root: str) -> float:
    return (settlement(expiry, root) - as_of).total_seconds() / (365.0 * 86400.0)


def choose_expiries(contracts: list[Contract], as_of: datetime) -> list[tuple[str, str]]:
    """(expiry, root) per target maturity, by open interest, without repeats."""
    oi: dict[tuple[str, str], float] = {}
    for c in contracts:
        oi[(c.expiry, c.root)] = oi.get((c.expiry, c.root), 0.0) + c.open_interest
    by_date: dict[str, str] = {}
    for exp, root in oi:
        if exp not in by_date or root == "SPXW":  # prefer PM settlement
            by_date[exp] = root
    days = {e: year_fraction(as_of, e, r) * 365.0 for e, r in by_date.items()}
    total = {e: sum(v for (ee, _), v in oi.items() if ee == e) for e in by_date}
    picked: list[tuple[str, str]] = []
    for target in TARGET_DAYS:
        cands = [e for e in by_date if 0.8 * target <= days[e] <= 1.25 * target and days[e] >= 5]
        cands = [e for e in cands if e not in {p[0] for p in picked}]
        if cands:
            best = max(cands, key=lambda e: total[e])
            picked.append((best, by_date[best]))
    return sorted(picked, key=lambda p: days[p[0]])


def parity_forward(
    strikes: np.ndarray,
    call_mid: np.ndarray,
    put_mid: np.ndarray,
    weight: np.ndarray,
    discount: float | None,
) -> tuple[float, float]:
    """(F, D) from C - P = D (F - K); D is held fixed when ``discount`` is given."""
    y = call_mid - put_mid
    if discount is None:
        A = np.stack([np.ones_like(strikes), -strikes], axis=1) * np.sqrt(weight)[:, None]
        (df, d), *_ = np.linalg.lstsq(A, y * np.sqrt(weight), rcond=None)
        return float(df / d), float(d)
    f = strikes + y / discount
    return float(np.sum(weight * f) / np.sum(weight)), float(discount)


@dataclass
class SliceData:
    expiry: str
    root: str
    tau: float
    forward: float
    discount: float
    atm_vol: float
    strike: np.ndarray
    k: np.ndarray
    iv: np.ndarray
    iv_bid: np.ndarray
    iv_ask: np.ndarray
    n_listed: int


def _pairs(rows: list[Contract]) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    calls = {c.strike: c for c in rows if c.right == "C" and c.bid > 0 and c.ask > c.bid}
    puts = {c.strike: c for c in rows if c.right == "P" and c.bid > 0 and c.ask > c.bid}
    ks = np.array(sorted(set(calls) & set(puts)))
    cm = np.array([(calls[k].bid + calls[k].ask) / 2 for k in ks])
    pm = np.array([(puts[k].bid + puts[k].ask) / 2 for k in ks])
    sp = np.array([calls[k].ask - calls[k].bid + puts[k].ask - puts[k].bid for k in ks])
    return ks, cm, pm, sp


def build_slice(
    rows: list[Contract], expiry: str, root: str, tau: float, spot: float, discount: float | None
) -> SliceData | None:
    ks, cm, pm, sp = _pairs(rows)
    if len(ks) < 6:
        return None
    # Near-the-money pairs: within ~1.5 standard deviations at a rough 20 % vol.
    near = np.abs(np.log(ks / spot)) < max(0.02, 1.5 * 0.2 * np.sqrt(tau))
    if near.sum() < 4:
        near = np.argsort(np.abs(ks - spot))[:6]
    fwd, disc = parity_forward(
        ks[near], cm[near], pm[near], 1.0 / np.maximum(sp[near], 0.05) ** 2, discount
    )

    otm = [
        c
        for c in rows
        if ((c.right == "P" and c.strike < fwd) or (c.right == "C" and c.strike >= fwd))
        and c.bid > 0
        and c.ask > c.bid
        and (c.ask - c.bid) / (0.5 * (c.ask + c.bid)) <= MAX_REL_SPREAD
    ]
    if len(otm) < 6:
        return None
    strike = np.array([c.strike for c in otm])
    k = np.log(strike / fwd)
    scale = disc * fwd
    bid = np.array([c.bid for c in otm]) / scale
    ask = np.array([c.ask for c in otm]) / scale
    mid = 0.5 * (bid + ask)
    iv = implied_vol_otm(mid, k, tau)
    ok = np.isfinite(iv)
    atm = float(np.interp(0.0, k[ok], iv[ok])) if ok.sum() >= 2 else float("nan")
    if not np.isfinite(atm):
        return None
    z = k / (atm * np.sqrt(tau))
    keep = ok & (z >= Z_LO) & (z <= Z_HI)
    idx = np.flatnonzero(keep)
    if len(idx) < 6:
        return None
    # Thin to the strikes nearest an even z-grid over the available range.
    grid = np.linspace(z[idx].min(), z[idx].max(), N_STRIKES)
    chosen = sorted({int(idx[np.argmin(np.abs(z[idx] - g))]) for g in grid})
    sel = np.array(chosen)
    iv_bid = implied_vol_otm(bid[sel], k[sel], tau)
    iv_ask = implied_vol_otm(ask[sel], k[sel], tau)
    # A zero-ish bid can be below the vol floor; treat its IV as the bracket floor.
    iv_bid = np.where(np.isfinite(iv_bid), iv_bid, 1e-4)
    order = np.argsort(k[sel])
    sel = sel[order]
    return SliceData(
        expiry=expiry,
        root=root,
        tau=tau,
        forward=fwd,
        discount=disc,
        atm_vol=atm,
        strike=strike[sel],
        k=k[sel],
        iv=iv[sel],
        iv_bid=iv_bid[order],
        iv_ask=iv_ask[order],
        n_listed=len(rows),
    )


def build_snapshot(raw: dict) -> tuple[datetime, float, list[SliceData]]:
    as_of, spot, contracts = parse_chain(raw)
    picks = choose_expiries(contracts, as_of)
    groups: dict[tuple[str, str], list[Contract]] = {}
    for c in contracts:
        groups.setdefault((c.expiry, c.root), []).append(c)
    taus = {p: year_fraction(as_of, *p) for p in picks}

    # Pass 1: free (F, D) fits on 2-12 month expiries give the short-end discount rate.
    rates = []
    for p in picks:
        if 2 / 12 <= taus[p] <= 1.0:
            s = build_slice(groups[p], p[0], p[1], taus[p], spot, None)
            if s is not None:
                rates.append(-np.log(s.discount) / s.tau)
    r_short = float(np.median(rates)) if rates else 0.04

    out = []
    for p in picks:
        disc = np.exp(-r_short * taus[p]) if taus[p] < 0.1 else None
        s = build_slice(groups[p], p[0], p[1], taus[p], spot, disc)
        if s is not None:
            out.append(s)
    return as_of, spot, out
