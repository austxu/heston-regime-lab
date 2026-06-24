"""Gaussian Hidden Markov Model for volatility-regime detection.

A Hidden Markov Model assumes the market each day occupies one of ``K`` *hidden* states
(regimes) and that the observed feature vector ``x_t`` is drawn from a Gaussian whose
mean/covariance depend on that state:

    s_t in {0, ..., K-1},   P(s_t = j | s_{t-1} = i) = A_ij        (transition matrix)
    x_t | s_t = k  ~  Normal(mu_k, Sigma_k)                         (emission)

The parameters (A, {mu_k, Sigma_k}, initial distribution) are fit by Baum-Welch (the EM
algorithm) — :mod:`hmmlearn` does this.  Given a fitted model we recover regimes two ways:

* **Viterbi** — the single most-likely *path* of states (``model.predict``), used for the
  historical overlay.
* **Forward-backward posteriors** — ``P(s_t = k | x_{1:T})`` (``model.predict_proba``),
  used for the "current regime with probabilities" the API serves.

hmmlearn labels states arbitrarily, so after fitting we **relabel by volatility**: the
state with the lowest mean realized vol becomes 0 (calm), the highest becomes K-1
(crisis).  This makes "regime 2" mean the same thing across refits — essential for a
stable API and for the economic interpretation.

A small pure-NumPy fallback is provided if hmmlearn cannot be imported, so the regime
endpoints still function.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class RegimeModel:
    """A fitted regime model plus the artifacts needed for stable inference.

    Bundles the feature standardiser, the fitted HMM, the volatility-ordering permutation
    (raw hmmlearn state -> ordered label 0..K-1) and the human-readable labels.
    """

    hmm: object
    mean: np.ndarray            # feature standardisation mean
    std: np.ndarray             # feature standardisation std
    state_order: np.ndarray     # ordered_label -> raw hmm state index
    inverse_order: np.ndarray   # raw hmm state index -> ordered_label
    labels: list[str]           # ordered label -> name (e.g. "low_vol")
    feature_cols: list[str]
    vol_feature_idx: int        # index (in feature_cols) used to order states by vol

    @property
    def n_states(self) -> int:
        return len(self.labels)

    def _standardise(self, X: np.ndarray) -> np.ndarray:
        return (X - self.mean) / self.std

    def decode(self, X: np.ndarray) -> np.ndarray:
        """Most-likely *ordered* regime path (Viterbi) for feature matrix ``X``."""
        raw = np.asarray(self.hmm.predict(self._standardise(X)))
        return self.inverse_order[raw]

    def posteriors(self, X: np.ndarray) -> np.ndarray:
        """Posterior ``P(s_t = k | x)`` for each ordered regime ``k``; shape (T, K)."""
        raw_post = np.asarray(self.hmm.predict_proba(self._standardise(X)))
        # Reorder columns from raw-state order to volatility order.
        return raw_post[:, self.state_order]

    def current(self, X: np.ndarray) -> tuple[int, np.ndarray]:
        """(ordered regime label, posterior vector) for the *latest* row of ``X``."""
        post = self.posteriors(X)[-1]
        return int(np.argmax(post)), post


def fit_regime_hmm(X: np.ndarray, config: dict) -> RegimeModel:
    """Fit a Gaussian HMM to standardised features and order states by volatility.

    Parameters
    ----------
    X : np.ndarray, shape (T, n_features)
        Feature matrix (rows = days), columns in ``config['hmm']['feature_cols']`` order.
    config : dict
        Global config; the ``hmm`` section drives ``n_states``, covariance type, EM
        iterations, the random seed, feature columns and the ordered state labels.

    Returns
    -------
    RegimeModel
    """
    hcfg = config["hmm"]
    n_states = int(hcfg["n_states"])
    feature_cols = list(hcfg["feature_cols"])
    labels = list(hcfg["state_labels"])

    X = np.asarray(X, dtype=float)
    mean = X.mean(axis=0)
    std = X.std(axis=0)
    std[std == 0] = 1.0
    Xs = (X - mean) / std

    model = _fit_backend(Xs, n_states, hcfg)

    # Order states by mean (standardised) realized vol so labels are stable & meaningful.
    vol_idx = _pick_vol_feature(feature_cols)
    raw_states = np.asarray(model.predict(Xs))
    state_mean_vol = np.array([
        Xs[raw_states == k, vol_idx].mean() if np.any(raw_states == k) else np.inf
        for k in range(n_states)
    ])
    state_order = np.argsort(state_mean_vol)           # ordered_label -> raw state
    inverse_order = np.argsort(state_order)            # raw state -> ordered_label

    return RegimeModel(
        hmm=model, mean=mean, std=std,
        state_order=state_order, inverse_order=inverse_order,
        labels=labels, feature_cols=feature_cols, vol_feature_idx=vol_idx,
    )


def _pick_vol_feature(feature_cols: list[str]) -> int:
    """Index of the column used to rank regimes by vol (prefer realized vol, then VIX)."""
    for pref in ("rv_21d", "rv_63d", "rv_5d", "vix"):
        if pref in feature_cols:
            return feature_cols.index(pref)
    return 0


def _fit_backend(Xs: np.ndarray, n_states: int, hcfg: dict):
    """Fit hmmlearn's GaussianHMM, or a NumPy EM fallback if hmmlearn is absent."""
    try:
        from hmmlearn.hmm import GaussianHMM

        model = GaussianHMM(
            n_components=n_states,
            covariance_type=hcfg.get("covariance_type", "full"),
            n_iter=int(hcfg.get("n_iter", 200)),
            random_state=int(hcfg.get("random_state", 42)),
        )
        model.fit(Xs)
        return model
    except Exception:  # noqa: BLE001 — fall back to the bundled EM implementation
        return _GaussianHMMFallback(n_states, int(hcfg.get("random_state", 42))).fit(Xs)


class _GaussianHMMFallback:
    """Minimal diagonal-covariance Gaussian HMM (Baum-Welch) for when hmmlearn is absent.

    Implements just enough of the hmmlearn API (``fit``, ``predict``, ``predict_proba``)
    for :class:`RegimeModel`.  Uses scaled forward-backward to stay numerically stable.
    """

    def __init__(self, n_states: int, random_state: int = 42, n_iter: int = 100):
        self.K = n_states
        self.rng = np.random.default_rng(random_state)
        self.n_iter = n_iter

    def fit(self, X: np.ndarray) -> "_GaussianHMMFallback":
        T, D = X.shape
        K = self.K
        # Init means by quantiles of the first feature; unit variance; uniform transitions.
        order = np.argsort(X[:, 0])
        chunks = np.array_split(order, K)
        self.means_ = np.array([X[c].mean(axis=0) for c in chunks])
        self.vars_ = np.tile(X.var(axis=0) + 1e-3, (K, 1))
        self.startprob_ = np.full(K, 1.0 / K)
        self.transmat_ = np.full((K, K), 0.1 / (K - 1))
        np.fill_diagonal(self.transmat_, 0.9)

        for _ in range(self.n_iter):
            B = self._emission(X)                      # (T, K)
            alpha, beta, c = self._forward_backward(B)
            gamma = alpha * beta                        # (T, K), already normalised
            xi = np.zeros((K, K))
            for t in range(T - 1):
                num = (alpha[t][:, None] * self.transmat_
                       * B[t + 1][None, :] * beta[t + 1][None, :])
                xi += num / num.sum()
            self.startprob_ = gamma[0] / gamma[0].sum()
            self.transmat_ = xi / xi.sum(axis=1, keepdims=True)
            w = gamma / gamma.sum(axis=0, keepdims=True)
            self.means_ = w.T @ X
            for k in range(K):
                diff = X - self.means_[k]
                self.vars_[k] = (w[:, k][:, None] * diff**2).sum(axis=0) + 1e-3
        return self

    def _emission(self, X: np.ndarray) -> np.ndarray:
        T = X.shape[0]
        B = np.empty((T, self.K))
        for k in range(self.K):
            diff = X - self.means_[k]
            log_p = -0.5 * (np.log(2 * np.pi * self.vars_[k]).sum()
                            + (diff**2 / self.vars_[k]).sum(axis=1))
            B[:, k] = np.exp(log_p)
        return np.clip(B, 1e-300, None)

    def _forward_backward(self, B: np.ndarray):
        T, K = B.shape
        alpha = np.zeros((T, K)); beta = np.zeros((T, K)); c = np.zeros(T)
        alpha[0] = self.startprob_ * B[0]
        c[0] = alpha[0].sum(); alpha[0] /= c[0]
        for t in range(1, T):
            alpha[t] = (alpha[t - 1] @ self.transmat_) * B[t]
            c[t] = alpha[t].sum(); alpha[t] /= c[t]
        beta[-1] = 1.0
        for t in range(T - 2, -1, -1):
            beta[t] = (self.transmat_ @ (B[t + 1] * beta[t + 1])) / c[t + 1]
        return alpha, beta, c

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        B = self._emission(X)
        alpha, beta, _ = self._forward_backward(B)
        g = alpha * beta
        return g / g.sum(axis=1, keepdims=True)

    def predict(self, X: np.ndarray) -> np.ndarray:
        return self.predict_proba(X).argmax(axis=1)
