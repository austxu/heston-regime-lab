"""Pricing-accuracy comparison: Black-Scholes baseline vs Heston vs Heston+residual.

Three levels of model, each scored by mean absolute implied-vol error against the market
surface:

1. **Flat Black-Scholes** — per maturity, price every strike with that maturity's
   at-the-money implied vol.  BS has a single vol per slice, so it *cannot* reproduce the
   smile/skew; its error grows in the wings.  This is the baseline Heston must beat.
2. **Heston** — the calibrated stochastic-vol surface, which bends to fit the smile.
3. **Heston + residual correction** — an XGBoost regressor trained on Heston's *systematic*
   residuals ``(market_iv - heston_iv)`` as a function of (log-moneyness, maturity,
   Heston IV).  Heston leaves structured errors at the tails/short maturities; a gradient-
   boosted tree mops up that structure.  Improvement is measured **out-of-fold** (K-fold)
   so it reflects genuine generalisation, not overfit.

XGBoost is used if its native library loads; otherwise we fall back to scikit-learn's
``GradientBoostingRegressor`` so the comparison still runs.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from calibration.optimizer import MarketData, heston_implied_vols
from models.black_scholes import bs_price, implied_vol
from models.heston import HestonParams

# --------------------------------------------------------------------------- #
# Residual-correction model                                                    #
# --------------------------------------------------------------------------- #


class ResidualModel:
    """Gradient-boosted regressor of Heston IV residuals (XGBoost, sklearn fallback)."""

    def __init__(self, config: dict):
        self.cfg = config["residual_model"]
        self.feature_cols = list(self.cfg["feature_cols"])
        self.model = self._make_model()

    def _make_model(self):
        params = dict(
            n_estimators=int(self.cfg["n_estimators"]),
            max_depth=int(self.cfg["max_depth"]),
            learning_rate=float(self.cfg["learning_rate"]),
            subsample=float(self.cfg["subsample"]),
            random_state=int(self.cfg["random_state"]),
        )
        try:
            from xgboost import XGBRegressor

            return XGBRegressor(objective="reg:squarederror", **params)
        except Exception:  # noqa: BLE001 — OpenMP/lib issues -> sklearn fallback
            from sklearn.ensemble import GradientBoostingRegressor

            params.pop("subsample", None)
            return GradientBoostingRegressor(
                n_estimators=params["n_estimators"],
                max_depth=params["max_depth"],
                learning_rate=params["learning_rate"],
                random_state=params["random_state"],
                subsample=float(self.cfg["subsample"]),
            )

    @property
    def backend(self) -> str:
        return type(self.model).__name__

    def fit(self, features: np.ndarray, residuals: np.ndarray) -> "ResidualModel":
        self.model.fit(features, residuals)
        return self

    def predict(self, features: np.ndarray) -> np.ndarray:
        return np.asarray(self.model.predict(features), dtype=float)


def build_residual_features(
    data: MarketData,
    heston_iv: np.ndarray,
    feature_cols: list[str] | None = None,
) -> np.ndarray:
    """Build configured, prediction-time-safe features for the residual model.

    Market IV is the prediction target and must never be an input feature.  Heston IV
    is available at inference time and gives the corrector a model-level baseline.
    """
    forward = data.spot * np.exp((data.rate - data.div_yield) * data.maturities)
    log_moneyness = np.log(data.strikes / forward)
    available = {
        "log_moneyness": log_moneyness,
        "spot_moneyness": data.strikes / data.spot,
        "maturity": data.maturities,
        "heston_iv": np.asarray(heston_iv, dtype=float),
    }
    columns = feature_cols or ["log_moneyness", "maturity", "heston_iv"]
    missing = [name for name in columns if name not in available]
    if missing:
        raise ValueError(
            f"unsupported residual feature columns {missing}; available={sorted(available)}"
        )
    return np.column_stack([available[name] for name in columns])


def _kfold_indices(n: int, k: int, seed: int) -> list[np.ndarray]:
    idx = np.random.default_rng(seed).permutation(n)
    return [fold for fold in np.array_split(idx, k)]


def out_of_fold_correction(
    features: np.ndarray, residuals: np.ndarray, config: dict, n_folds: int = 5
) -> np.ndarray:
    """Out-of-fold predicted residuals (honest generalisation estimate).

    For each fold, train on the other folds and predict the held-out residuals.  Leaves
    the residual uncorrected when there are too few points for an honest split.
    """
    n = len(residuals)
    if n == 0:
        return np.empty(0, dtype=float)
    if n < 2 * n_folds:
        return np.zeros(n, dtype=float)
    oof = np.zeros(n)
    folds = _kfold_indices(n, n_folds, int(config["residual_model"]["random_state"]))
    for i, test_idx in enumerate(folds):
        train_idx = np.concatenate([f for j, f in enumerate(folds) if j != i])
        model = ResidualModel(config).fit(features[train_idx], residuals[train_idx])
        oof[test_idx] = model.predict(features[test_idx])
    return oof


# --------------------------------------------------------------------------- #
# Comparison                                                                   #
# --------------------------------------------------------------------------- #


@dataclass
class PricingComparison:
    """Per-option and summary IV errors for BS / Heston / Heston+residual."""

    strike: np.ndarray
    maturity: np.ndarray
    moneyness: np.ndarray
    market_iv: np.ndarray
    bs_flat_iv: np.ndarray
    heston_iv: np.ndarray
    corrected_iv: np.ndarray
    mae_bs: float
    mae_heston: float
    mae_corrected: float
    residual_backend: str
    by_moneyness: list = field(default_factory=list)
    by_maturity: list = field(default_factory=list)


def _flat_bs_iv(data: MarketData) -> np.ndarray:
    """Per-maturity ATM implied vol broadcast to every strike in that slice.

    This is the flat-vol Black-Scholes 'model': within a maturity slice BS sees one vol
    (the ATM one), so its model IV is constant across strikes — by construction it misses
    the smile.  We invert its prices back to IV for an apples-to-apples error metric.
    """
    out = np.full(len(data), np.nan)
    for tau in np.unique(data.maturities):
        mask = data.maturities == tau
        forward = data.spot * np.exp((data.rate - data.div_yield) * tau)
        strikes = data.strikes[mask]
        ivs = data.market_iv[mask]
        atm_vol = float(ivs[np.argmin(np.abs(strikes - forward))])
        for j, k in zip(np.where(mask)[0], strikes):
            otype = "put" if k < forward else "call"
            price = bs_price(
                data.spot, float(k), data.rate, data.div_yield, float(tau), atm_vol, otype
            )
            out[j] = implied_vol(
                price, data.spot, float(k), data.rate, data.div_yield, float(tau), otype
            )
    return out


def _bucket_errors(key: np.ndarray, errs: dict, edges: np.ndarray, label: str) -> list:
    """Mean abs error per model within bins of ``key`` (moneyness or maturity)."""
    out = []
    idx = np.searchsorted(edges, key, side="right") - 1
    # Histogram convention: the final bin includes its right endpoint.
    idx[key == edges[-1]] = len(edges) - 2
    for b in range(len(edges) - 1):
        m = idx == b
        if not np.any(m):
            continue
        out.append(
            {
                label: float((edges[b] + edges[b + 1]) / 2),
                "n": int(m.sum()),
                **{name: float(np.nanmean(np.abs(e[m]))) for name, e in errs.items()},
            }
        )
    return out


def compare_pricing(data: MarketData, params: HestonParams, config: dict) -> PricingComparison:
    """Score BS / Heston / Heston+residual against the market surface in IV space.

    Parameters
    ----------
    data : MarketData
        The (liquid) market implied-vol quotes.
    params : HestonParams
        Calibrated Heston parameters.
    config : dict
        Global config (quadrature + residual_model sections).
    """
    quad = config.get("quadrature", {})
    heston_iv = heston_implied_vols(
        params,
        data,
        n_nodes=int(quad.get("n_nodes", 128)),
        upper_limit=float(quad.get("upper_limit", 200.0)),
    )
    bs_iv = _flat_bs_iv(data)

    # Residual correction trained on Heston's structured errors (out-of-fold).
    valid = np.isfinite(heston_iv) & np.isfinite(data.market_iv)
    residuals = np.where(valid, data.market_iv - heston_iv, 0.0)
    feats = build_residual_features(
        data,
        np.where(valid, heston_iv, 0.0),
        feature_cols=list(config["residual_model"]["feature_cols"]),
    )
    oof_resid = out_of_fold_correction(feats[valid], residuals[valid], config)
    corrected_iv = heston_iv.copy()
    corrected_iv[valid] = heston_iv[valid] + oof_resid

    forward = data.spot * np.exp((data.rate - data.div_yield) * data.maturities)
    moneyness = data.strikes / forward

    err_bs = bs_iv - data.market_iv
    err_h = heston_iv - data.market_iv
    err_c = corrected_iv - data.market_iv
    errs = {"bs": err_bs, "heston": err_h, "corrected": err_c}

    mny_edges = np.linspace(np.nanmin(moneyness), np.nanmax(moneyness), 7)
    tau_edges = np.unique(np.r_[data.maturities, data.maturities.max() * 1.001])

    return PricingComparison(
        strike=data.strikes,
        maturity=data.maturities,
        moneyness=moneyness,
        market_iv=data.market_iv,
        bs_flat_iv=bs_iv,
        heston_iv=heston_iv,
        corrected_iv=corrected_iv,
        mae_bs=float(np.nanmean(np.abs(err_bs))),
        mae_heston=float(np.nanmean(np.abs(err_h))),
        mae_corrected=float(np.nanmean(np.abs(err_c))),
        residual_backend=ResidualModel(config).backend,
        by_moneyness=_bucket_errors(moneyness, errs, mny_edges, "moneyness"),
        by_maturity=_bucket_errors(data.maturities, errs, tau_edges, "maturity"),
    )
