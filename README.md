# heston-regime-lab

Stochastic-volatility research lab: calibrate the **Heston** model to SPX options, detect
market **regimes** with a hidden Markov model, and study how Heston parameters and
calibration error change across regimes.

> **Status: Phase 1 / 4 — mathematical core.** Pricing and calibration proven on synthetic
> data. Data, regime, and ML layers come in later phases.

## Phases
1. **Math core (this phase):** Heston characteristic function, Gil-Pelaez Fourier inversion
   with Gauss-Legendre quadrature, Black-Scholes baseline + implied-vol inversion, L-BFGS-B
   calibration, synthetic round-trip validation (recover ground-truth params within 1%).
2. Data layer (yfinance/FRED, IV computation, liquidity filtering, vol features).
3. Real-data calibration validation, XGBoost residual correction, diagnostic plots.
4. HMM regime detection, regime-conditional recalibration.

## Quickstart
```bash
python -m venv --system-site-packages .venv && source .venv/bin/activate
pip install -r requirements.txt
pytest tests/ -q                      # full synthetic test suite
python -m calibration.validators      # round-trip calibration demo
```

## Layout
```
models/heston.py          Heston char. function + Gil-Pelaez pricing (Gauss-Legendre)
models/black_scholes.py   Black-Scholes pricing + implied-vol inversion (Brent)
calibration/optimizer.py  L-BFGS-B nonlinear least-squares calibration
calibration/validators.py synthetic data generation + round-trip validation
configs/base.yaml         all hyperparameters
tests/test_synthetic.py   pytest suite
```

The mathematical derivations (characteristic function, Gil-Pelaez inversion, HMM) are in
[Mathematical background](#mathematical-background) below.

## Mathematical background

All formulas below are implemented in `models/` and `calibration/`; the code comments
cross-reference these derivations.

### 1. The Heston model

Under the risk-neutral measure $\mathbb{Q}$ the spot $S_t$ and its instantaneous
variance $v_t$ follow

$$
\begin{aligned}
dS_t &= (r-q)\,S_t\,dt + \sqrt{v_t}\,S_t\,dW_t^{S},\\
dv_t &= \kappa(\theta - v_t)\,dt + \sigma\sqrt{v_t}\,dW_t^{v},\\
d\langle W^{S}, W^{v}\rangle_t &= \rho\,dt,
\end{aligned}
$$

with $\kappa$ (mean-reversion speed), $\theta$ (long-run variance), $\sigma$ (vol of
vol), $\rho$ (correlation) and $v_0$ (initial variance). The variance is a CIR /
square-root process; it stays strictly positive when the **Feller condition**
$2\kappa\theta > \sigma^2$ holds.

### 2. Characteristic function of the log-price

Let $x_t=\ln S_t$. By Itô, $dx_t=(r-q-\tfrac12 v_t)\,dt+\sqrt{v_t}\,dW_t^S$. The
conditional characteristic function $\phi(u;\tau)=\mathbb{E}\!\left[e^{iu x_T}\mid x_t,v_t\right]$,
$\tau=T-t$, is **affine** in $(x_t,v_t)$:

$$
\phi(u;\tau)=\exp\big(C(u,\tau)+D(u,\tau)\,v_t+iu\,x_t\big).
$$

Substituting into the Feynman–Kac PDE turns it into a Riccati system for $C,D$ whose
closed-form solution is, writing the **little-trap** branch (Albrecher et al. 2007),

$$
d=\sqrt{(\rho\sigma iu-\kappa)^2+\sigma^2(iu+u^2)},\qquad
g=\frac{\kappa-\rho\sigma iu-d}{\kappa-\rho\sigma iu+d},
$$

$$
\phi(u;\tau)=\exp\Bigg(
iu\big(\ln S_0+(r-q)\tau\big)
+\frac{\kappa\theta}{\sigma^2}\Big[(\kappa-\rho\sigma iu-d)\tau-2\ln\frac{1-g e^{-d\tau}}{1-g}\Big]
+\frac{v_0}{\sigma^2}(\kappa-\rho\sigma iu-d)\frac{1-e^{-d\tau}}{1-g e^{-d\tau}}
\Bigg).
$$

**Why the trap.** The original Heston (1993) form uses $g^{-1}$ together with
$e^{+d\tau}$. Because $\operatorname{Re}(d)>0$ that factor *overflows* for long
maturities and the complex logarithm $\ln(1-g^{-1}e^{+d\tau})$ crosses a branch cut,
producing discontinuities in the integrand. The trap form above uses $e^{-d\tau}\to0$,
so $1-g e^{-d\tau}\to1$ stays on the principal branch — analytically identical, but
numerically stable. (See `models/heston.py`; this is the "fix numerical instability"
step in the git history.) A self-consistency check is the martingale identity
$\phi(-i)=\mathbb{E}[S_T]=S_0 e^{(r-q)\tau}$.

### 3. Gil-Pelaez Fourier inversion → option price

Gil-Pelaez (1951) recovers a probability directly from the characteristic function
without forming the density. For any random variable $X$ with CF $\phi$,

$$
\mathbb{P}(X>a)=\frac12+\frac1\pi\int_0^\infty
\operatorname{Re}\!\left[\frac{e^{-iua}\,\phi(u)}{iu}\right]du.
$$

A European call has the discounted-payoff decomposition

$$
C = e^{-r\tau}\,\mathbb{E}^{\mathbb{Q}}\big[(S_T-K)^+\big]
  = S_0 e^{-q\tau}\,\Pi_1 - K e^{-r\tau}\,\Pi_2,
$$

where $\Pi_2=\mathbb{Q}(S_T>K)$ is the risk-neutral exercise probability and $\Pi_1$
is the same event under the **stock-as-numéraire** measure, whose characteristic
function is the Esscher-tilted $\phi_1(u)=\phi(u-i)/\phi(-i)$ with forward
$F=\phi(-i)=S_0 e^{(r-q)\tau}$. Applying Gil-Pelaez to each (with $a=\ln K$):

$$
\Pi_2=\frac12+\frac1\pi\int_0^\infty\operatorname{Re}\!\left[\frac{e^{-iu\ln K}\phi(u)}{iu}\right]du,
\qquad
\Pi_1=\frac12+\frac1\pi\int_0^\infty\operatorname{Re}\!\left[\frac{e^{-iu\ln K}\phi(u-i)}{iu\,F}\right]du.
$$

The put follows from put–call parity $C-P=S_0e^{-q\tau}-Ke^{-r\tau}$.

### 4. Gauss-Legendre quadrature

The semi-infinite integrals are truncated at $U$ and evaluated with an $n$-point
Gauss-Legendre rule. Mapping the canonical nodes $t_k\in(-1,1)$ to $(0,U)$ via
$u_k=\tfrac{U}{2}(t_k+1)$ with weights $\tfrac{U}{2}w_k$,

$$
\int_0^U f(u)\,du\;\approx\;\frac{U}{2}\sum_{k=1}^{n} w_k\, f\!\left(u_k\right).
$$

Gauss-Legendre is exact for polynomials of degree $\le 2n-1$ and converges
geometrically for the smooth, exponentially-decaying Heston integrand. The integrand
has a *removable* $1/(iu)$ singularity at $u=0$; because Legendre nodes are strictly
interior, $u=0$ is never sampled, so no special handling is needed.

### 5. Black-Scholes baseline & implied vol

With constant volatility, $C=S_0e^{-q\tau}N(d_1)-Ke^{-r\tau}N(d_2)$,
$d_{1,2}=\frac{\ln(S_0/K)+(r-q\pm\frac12\sigma^2)\tau}{\sigma\sqrt\tau}$. The price is
strictly increasing in $\sigma$ (vega $=S_0e^{-q\tau}\varphi(d_1)\sqrt\tau>0$), so the
**implied volatility** — the $\sigma$ solving $\mathrm{BS}(\sigma)=\text{price}$ — is
unique and found by Brent's method (`scipy.optimize.brentq`).

### 6. Calibration as nonlinear least squares

Calibration is the inverse problem

$$
p^\star=\arg\min_{p}\ \sum_i w_i\big(\mathrm{IV}_{\text{model}}(p;K_i,\tau_i)-\mathrm{IV}_{\text{mkt}}(K_i,\tau_i)\big)^2,
\qquad p=(\kappa,\theta,\sigma,\rho,v_0),
$$

solved with box-constrained quasi-Newton **L-BFGS-B**. Parameters are mapped affinely
to $[0,1]^5$ before optimisation so their disparate magnitudes do not distort the
finite-difference gradients, and a soft penalty on $\max(0,\sigma^2-2\kappa\theta)$ can
discourage Feller violations. Phase 1 proves the whole stack on synthetic data:
generate IVs from known $p_{\text{true}}$, calibrate back, and require recovery within
1% — achieved to $\sim$0.005% (`tests/test_synthetic.py`).

### 7. HMM regime formulation (Phase 4 preview)

A Gaussian hidden Markov model has discrete latent regimes $z_t\in\{1,\dots,K\}$
($K=3$) with transition matrix $A_{ij}=\mathbb{P}(z_{t+1}=j\mid z_t=i)$, initial
distribution $\pi$, and Gaussian emissions of the vol-feature vector
$x_t\mid z_t=k\sim\mathcal{N}(\mu_k,\Sigma_k)$. The joint likelihood is

$$
p(x_{1:T},z_{1:T})=\pi_{z_1}\prod_{t=2}^{T}A_{z_{t-1}z_t}\prod_{t=1}^{T}\mathcal{N}(x_t;\mu_{z_t},\Sigma_{z_t}).
$$

Parameters are fit by Baum–Welch (EM); the most-likely regime path is decoded by
Viterbi. Later phases test whether calibrated Heston parameters differ across the
decoded regimes (Kruskal–Wallis, $p<0.01$) and recalibrate per regime. *Implemented in
Phase 4 — included here for completeness of the mathematical narrative.*

