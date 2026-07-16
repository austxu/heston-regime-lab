"""Volatility feature engineering for HMM regime detection.

The HMM observes a low-dimensional vector of *volatility-state* features each day and
infers a latent regime.  These features are chosen to separate calm, elevated and crisis
markets:

* **Realized volatility** at 5d / 21d / 63d horizons — annualised rolling std of log
  returns.  Short windows react fast; long windows are smooth.  RV is the most direct
  observable of the latent variance the Heston ``v_t`` tracks.
* **VIX level** — the market's forward-looking 30-day implied vol (risk-neutral), which
  leads realized vol and carries a variance-risk premium.
* **VIX term-structure slope** — ``vix3m - vix``.  Positive (contango) in calm markets,
  negative (backwardation) in stress, so its sign is a clean regime signal.
* **Return skewness** (rolling 63d) — crashes are left-skewed; skew turns sharply
  negative entering crises.
* **Volume ratio** — volume relative to its own rolling mean; spikes in stress.

All features are computed on a shared business-day index and the warmup NaNs are dropped,
yielding a clean matrix ready for ``models.hmm``.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def realized_vol(log_returns: pd.Series, window: int) -> pd.Series:
    """Annualised rolling realized volatility: ``std(returns, window) * sqrt(252)``."""
    if isinstance(window, bool) or int(window) != window or window < 2:
        raise ValueError(f"window must be an integer >= 2, got {window!r}")
    return log_returns.rolling(window).std() * np.sqrt(TRADING_DAYS)


def engineer_features(
    prices: pd.DataFrame,
    vix: pd.DataFrame,
    config: dict | None = None,
) -> pd.DataFrame:
    """Build the regime-detection feature matrix from price and VIX history.

    Parameters
    ----------
    prices : pd.DataFrame
        Daily history with at least a ``close`` column (``volume`` optional), indexed
        by date (see :func:`data.fetchers.get_price_history`).
    vix : pd.DataFrame
        VIX term structure with columns ``vix9d, vix, vix3m`` on a comparable index.
    config : dict, optional
        Unused today but accepted so callers can pass the global config uniformly.

    Returns
    -------
    pd.DataFrame
        Columns: ``ret, rv_5d, rv_21d, rv_63d, vix9d, vix, vix3m, vix_slope,
        ret_skew_21d, ret_skew_63d, volume_ratio``.  Warmup rows (NaN) are dropped.
    """
    if "close" not in prices.columns:
        raise KeyError("prices frame must contain a 'close' column")
    required_vix = {"vix9d", "vix", "vix3m"}
    missing_vix = sorted(required_vix.difference(vix.columns))
    if missing_vix:
        raise KeyError(f"VIX frame is missing required columns: {missing_vix}")
    if prices.index.has_duplicates or vix.index.has_duplicates:
        raise ValueError("price and VIX indexes must not contain duplicate dates")

    prices = prices.sort_index()
    vix = vix.sort_index()
    close = prices["close"].astype(float)
    if close.empty:
        raise ValueError("prices frame must contain at least one observation")
    if not np.all(np.isfinite(close)) or (close <= 0.0).any():
        raise ValueError("close prices must all be finite and > 0")
    log_ret = np.log(close).diff()

    feats = pd.DataFrame(index=close.index)
    feats["ret"] = log_ret
    feats["rv_5d"] = realized_vol(log_ret, 5)
    feats["rv_21d"] = realized_vol(log_ret, 21)
    feats["rv_63d"] = realized_vol(log_ret, 63)

    # VIX term structure, aligned to the price index (forward-fill small gaps).
    fill_limit = int((config or {}).get("data", {}).get("vix_forward_fill_days", 5))
    if fill_limit < 0:
        raise ValueError("data.vix_forward_fill_days must be >= 0")
    vix_aligned = vix.reindex(close.index)
    if fill_limit:
        vix_aligned = vix_aligned.ffill(limit=fill_limit)
    feats["vix9d"] = vix_aligned["vix9d"]
    feats["vix"] = vix_aligned["vix"]
    feats["vix3m"] = vix_aligned["vix3m"]
    feats["vix_slope"] = feats["vix3m"] - feats["vix"]

    # Rolling return skewness (crash asymmetry).
    feats["ret_skew_21d"] = log_ret.rolling(21).skew()
    feats["ret_skew_63d"] = log_ret.rolling(63).skew()

    # Volume relative to its own 63d mean (1.0 = average activity).
    if "volume" in prices.columns:
        vol = prices["volume"].astype(float)
        feats["volume_ratio"] = vol / vol.rolling(63).mean()
    else:
        feats["volume_ratio"] = 1.0

    result = feats.replace([np.inf, -np.inf], np.nan).dropna()
    if result.empty:
        raise ValueError("feature engineering produced no complete finite observations")
    return result


def feature_matrix(features: pd.DataFrame, columns: list[str]) -> np.ndarray:
    """Select and order the HMM input columns as a float matrix.

    Raises a clear error if a configured feature column is missing, rather than letting
    a silent ``KeyError`` surface deep inside hmmlearn.
    """
    missing = [c for c in columns if c not in features.columns]
    if missing:
        raise KeyError(f"feature columns missing from frame: {missing}")
    if not columns:
        raise ValueError("at least one feature column is required")
    matrix = features[columns].to_numpy(dtype=float)
    if matrix.shape[0] == 0:
        raise ValueError("feature frame contains no observations")
    if not np.all(np.isfinite(matrix)):
        raise ValueError("feature matrix must contain only finite values")
    return matrix
