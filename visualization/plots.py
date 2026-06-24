"""Diagnostic plots for the README and reports.

Renders four figures from the (offline, deterministic) pipeline so they can be regenerated
and embedded anywhere:

* ``vol_surface_fit``     — Heston fit to the market vol smile, per maturity.
* ``regime_overlay``      — SPX price with HMM regime periods shaded.
* ``model_comparison``    — mean abs IV error by moneyness: BS vs Heston vs +residual.
* ``calibration_convergence`` — L-BFGS-B objective vs iteration.

Run ``python -m visualization.plots`` to write PNGs to ``docs/assets/``.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless
import matplotlib.pyplot as plt
import numpy as np

from analysis.pricing_comparison import compare_pricing
from calibration.optimizer import (
    CalibrationProgress,
    MarketData,
    calibrate,
    heston_implied_vols,
    load_config,
)
from data import fetchers as F
from data.features import engineer_features, feature_matrix
from models.hmm import fit_regime_hmm

CONFIG_PATH = Path(__file__).resolve().parents[1] / "configs" / "base.yaml"
ASSETS = Path(__file__).resolve().parents[1] / "docs" / "assets"

# Dark theme matching the dashboard.
BG = "#0a0e16"
PANEL = "#111726"
INK = "#e6edf6"
MUTED = "#8a97ad"
ACCENT = "#38bdf8"
MODEL = "#a78bfa"
CORR = "#34d399"
BS = "#fb7185"
REGIME_COLORS = ["#34d399", "#fbbf24", "#f43f5e"]


def _style() -> None:
    plt.rcParams.update({
        "figure.facecolor": BG, "axes.facecolor": PANEL, "savefig.facecolor": BG,
        "text.color": INK, "axes.labelcolor": INK, "axes.edgecolor": "#1e2940",
        "xtick.color": MUTED, "ytick.color": MUTED, "grid.color": "#1e2940",
        "axes.titlecolor": INK, "font.size": 10, "axes.grid": True,
        "legend.facecolor": PANEL, "legend.edgecolor": "#1e2940",
    })


def _liquid_market_data(config: dict) -> MarketData:
    snap = F.get_market_snapshot(config, prefer_live=False)
    liquid, _ = F.filter_liquid_options(snap, config)
    return MarketData(
        spot=snap.spot, rate=snap.rate, div_yield=snap.div_yield,
        strikes=liquid["strike"].to_numpy(), maturities=liquid["maturity"].to_numpy(),
        market_iv=liquid["market_iv"].to_numpy(),
    )


def plot_vol_surface_fit(config: dict, path: Path) -> None:
    data = _liquid_market_data(config)
    result = calibrate(data, config)
    model_iv = heston_implied_vols(result.params, data)

    fig, ax = plt.subplots(figsize=(8, 4.5))
    maturities = np.unique(data.maturities)
    cmap = plt.cm.viridis(np.linspace(0.2, 0.9, len(maturities)))
    for tau, c in zip(maturities, cmap):
        m = data.maturities == tau
        order = np.argsort(data.strikes[m])
        k = data.strikes[m][order] / data.spot
        ax.scatter(k, data.market_iv[m][order], color=c, s=22, alpha=0.9)
        ax.plot(k, model_iv[m][order], color=c, lw=1.6, label=f"τ={tau:.2f}y")
    ax.set_xlabel("Moneyness K/S")
    ax.set_ylabel("Implied volatility")
    ax.set_title(f"Heston fit to the vol smile  ·  mean IV error {result.mean_abs_iv_error:.2%}")
    ax.legend(fontsize=8, ncol=2, title="dots = market, lines = Heston", title_fontsize=8)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def plot_regime_overlay(config: dict, path: Path) -> None:
    hist = F.get_price_history(config, prefer_live=False)
    vix = F.get_vix_term_structure(config, price_history=hist.data, prefer_live=False)
    feats = engineer_features(hist.data, vix.data, config)
    X = feature_matrix(feats, list(config["hmm"]["feature_cols"]))
    model = fit_regime_hmm(X, config)
    path_states = model.decode(X)
    dates = feats.index
    close = hist.data["close"].reindex(dates).to_numpy()

    fig, ax = plt.subplots(figsize=(9, 4))
    ax.plot(dates, close, color=INK, lw=0.9, zorder=3)
    # Shade contiguous regime runs.
    start = 0
    for i in range(1, len(path_states) + 1):
        if i == len(path_states) or path_states[i] != path_states[start]:
            ax.axvspan(dates[start], dates[min(i, len(dates) - 1)],
                       color=REGIME_COLORS[path_states[start]], alpha=0.18, zorder=1)
            start = i
    labels = config["hmm"]["state_labels"]
    handles = [plt.Rectangle((0, 0), 1, 1, color=REGIME_COLORS[k], alpha=0.5) for k in range(len(labels))]
    ax.legend(handles, [l.replace("_", " ").title() for l in labels], fontsize=8, loc="upper left")
    ax.set_ylabel("SPX (synthetic)")
    ax.set_title("HMM-detected volatility regimes over SPX")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def plot_model_comparison(config: dict, path: Path) -> None:
    data = _liquid_market_data(config)
    result = calibrate(data, config)
    cmp = compare_pricing(data, result.params, config)

    centers = [b["moneyness"] for b in cmp.by_moneyness]
    x = np.arange(len(centers))
    w = 0.27
    fig, ax = plt.subplots(figsize=(8, 4.2))
    ax.bar(x - w, [b["bs"] for b in cmp.by_moneyness], w, label="Black-Scholes", color=BS)
    ax.bar(x, [b["heston"] for b in cmp.by_moneyness], w, label="Heston", color=MODEL)
    ax.bar(x + w, [b["corrected"] for b in cmp.by_moneyness], w, label="Heston + residual", color=CORR)
    ax.set_xticks(x)
    ax.set_xticklabels([f"{c:.2f}" for c in centers])
    ax.set_xlabel("Moneyness K/S")
    ax.set_ylabel("Mean abs IV error")
    ax.yaxis.set_major_formatter(lambda v, _: f"{v:.0%}")
    ax.set_title("Pricing error by moneyness: BS vs Heston vs residual-corrected")
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def plot_calibration_convergence(config: dict, path: Path) -> None:
    data = _liquid_market_data(config)
    steps: list[CalibrationProgress] = []
    calibrate(data, config, callback=steps.append)

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.semilogy([s.iteration for s in steps], [max(s.loss, 1e-16) for s in steps],
                color=ACCENT, marker="o", ms=3, lw=1.5)
    ax.set_xlabel("L-BFGS-B iteration")
    ax.set_ylabel("Objective (Σ IV residual²)")
    ax.set_title("Calibration convergence")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def generate_all(outdir: Path = ASSETS) -> list[Path]:
    """Render every diagnostic PNG into ``outdir`` and return the paths."""
    _style()
    outdir.mkdir(parents=True, exist_ok=True)
    config = load_config(CONFIG_PATH)
    jobs = {
        "vol_surface_fit.png": plot_vol_surface_fit,
        "regime_overlay.png": plot_regime_overlay,
        "model_comparison.png": plot_model_comparison,
        "calibration_convergence.png": plot_calibration_convergence,
    }
    written = []
    for name, fn in jobs.items():
        target = outdir / name
        fn(config, target)
        written.append(target)
        print(f"wrote {target}")
    return written


if __name__ == "__main__":
    generate_all()
