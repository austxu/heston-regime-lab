"""Market-data fetchers (SPX options chain, daily SPX/VIX history, FRED series).

PHASE 2 — not yet implemented. Phase 1 is the mathematical core only and is validated
exclusively on synthetic data, so no network/data dependencies are introduced here.

Planned surface:
    fetch_spx_options_chain(...) -> pandas.DataFrame   # via yfinance, malformed-chain safe
    fetch_price_history(ticker, years) -> pandas.DataFrame
    fetch_vix_term_structure(...) -> pandas.DataFrame
    fetch_fred_series(series_id) -> pandas.Series        # via FRED API
"""

from __future__ import annotations


def _phase_2_placeholder() -> None:  # pragma: no cover
    raise NotImplementedError("data.fetchers is implemented in Phase 2.")
