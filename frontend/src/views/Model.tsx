import { num } from '../lib/format'
import type { MarketData } from '../lib/market'
import type { SpxData } from '../lib/spx'

/** Static MathML (rendered natively by the browser; no math library shipped). */
const EQ = {
  sde: `<math display="block"><mtable columnalign="left"><mtr><mtd displaystyle="true"><mi>d</mi><msub><mi>S</mi><mi>t</mi></msub><mo>=</mo><mo>(</mo><mi>r</mi><mo>−</mo><mi>q</mi><mo>)</mo><msub><mi>S</mi><mi>t</mi></msub><mspace width="0.17em"/><mi>d</mi><mi>t</mi><mo>+</mo><msqrt><msub><mi>v</mi><mi>t</mi></msub></msqrt><mspace width="0.17em"/><msub><mi>S</mi><mi>t</mi></msub><mspace width="0.17em"/><mi>d</mi><msubsup><mi>W</mi><mi>t</mi><mi>S</mi></msubsup></mtd></mtr><mtr><mtd displaystyle="true"><mi>d</mi><msub><mi>v</mi><mi>t</mi></msub><mo>=</mo><mi>κ</mi><mo>(</mo><mi>θ</mi><mo>−</mo><msub><mi>v</mi><mi>t</mi></msub><mo>)</mo><mspace width="0.17em"/><mi>d</mi><mi>t</mi><mo>+</mo><mi>σ</mi><msqrt><msub><mi>v</mi><mi>t</mi></msub></msqrt><mspace width="0.17em"/><mi>d</mi><msubsup><mi>W</mi><mi>t</mi><mi>v</mi></msubsup><mo>,</mo><mspace width="1em"/><mi>d</mi><mo>⟨</mo><msup><mi>W</mi><mi>S</mi></msup><mo>,</mo><msup><mi>W</mi><mi>v</mi></msup><msub><mo>⟩</mo><mi>t</mi></msub><mo>=</mo><mi>ρ</mi><mspace width="0.17em"/><mi>d</mi><mi>t</mi></mtd></mtr></mtable></math>`,
  cf: `<math display="block"><mtable columnalign="left"><mtr><mtd displaystyle="true"><mi>φ</mi><mo>(</mo><mi>u</mi><mo>)</mo><mo>=</mo><mi>exp</mi><mo>(</mo><mi>C</mi><mo>+</mo><mi>D</mi><msub><mi>v</mi><mn>0</mn></msub><mo>+</mo><mi>i</mi><mi>u</mi><mo>[</mo><mi>ln</mi><msub><mi>S</mi><mn>0</mn></msub><mo>+</mo><mo>(</mo><mi>r</mi><mo>−</mo><mi>q</mi><mo>)</mo><mi>τ</mi><mo>]</mo><mo>)</mo><mo>,</mo><mspace width="1em"/><mi>ξ</mi><mo>=</mo><mi>κ</mi><mo>−</mo><mi>ρ</mi><mi>σ</mi><mi>i</mi><mi>u</mi><mo>,</mo><mspace width="0.6em"/><mi>d</mi><mo>=</mo><msqrt><msup><mrow><mo>(</mo><mi>ρ</mi><mi>σ</mi><mi>i</mi><mi>u</mi><mo>−</mo><mi>κ</mi><mo>)</mo></mrow><mn>2</mn></msup><mo>+</mo><msup><mi>σ</mi><mn>2</mn></msup><mo>(</mo><mi>i</mi><mi>u</mi><mo>+</mo><msup><mi>u</mi><mn>2</mn></msup><mo>)</mo></msqrt></mtd></mtr><mtr><mtd displaystyle="true"><mi>g</mi><mo>=</mo><mfrac><mrow><mi>ξ</mi><mo>−</mo><mi>d</mi></mrow><mrow><mi>ξ</mi><mo>+</mo><mi>d</mi></mrow></mfrac><mo>,</mo><mspace width="0.6em"/><mi>C</mi><mo>=</mo><mfrac><mrow><mi>κ</mi><mi>θ</mi></mrow><msup><mi>σ</mi><mn>2</mn></msup></mfrac><mrow><mo>[</mo><mo>(</mo><mi>ξ</mi><mo>−</mo><mi>d</mi><mo>)</mo><mi>τ</mi><mo>−</mo><mn>2</mn><mi>ln</mi><mfrac><mrow><mn>1</mn><mo>−</mo><mi>g</mi><msup><mi>e</mi><mrow><mo>−</mo><mi>d</mi><mi>τ</mi></mrow></msup></mrow><mrow><mn>1</mn><mo>−</mo><mi>g</mi></mrow></mfrac><mo>]</mo></mrow><mo>,</mo><mspace width="0.6em"/><mi>D</mi><mo>=</mo><mfrac><mrow><mi>ξ</mi><mo>−</mo><mi>d</mi></mrow><msup><mi>σ</mi><mn>2</mn></msup></mfrac><mfrac><mrow><mn>1</mn><mo>−</mo><msup><mi>e</mi><mrow><mo>−</mo><mi>d</mi><mi>τ</mi></mrow></msup></mrow><mrow><mn>1</mn><mo>−</mo><mi>g</mi><msup><mi>e</mi><mrow><mo>−</mo><mi>d</mi><mi>τ</mi></mrow></msup></mrow></mfrac></mtd></mtr></mtable></math>`,
  gp: `<math display="block"><mi>C</mi><mo>=</mo><msub><mi>S</mi><mn>0</mn></msub><msup><mi>e</mi><mrow><mo>−</mo><mi>q</mi><mi>τ</mi></mrow></msup><msub><mi>P</mi><mn>1</mn></msub><mo>−</mo><mi>K</mi><msup><mi>e</mi><mrow><mo>−</mo><mi>r</mi><mi>τ</mi></mrow></msup><msub><mi>P</mi><mn>2</mn></msub><mo>,</mo><mspace width="1em"/><msub><mi>P</mi><mn>2</mn></msub><mo>=</mo><mfrac><mn>1</mn><mn>2</mn></mfrac><mo>+</mo><mfrac><mn>1</mn><mi>π</mi></mfrac><msubsup><mo>∫</mo><mn>0</mn><mi>U</mi></msubsup><mi>Re</mi><mrow><mo>[</mo><mfrac><mrow><msup><mi>e</mi><mrow><mo>−</mo><mi>i</mi><mi>u</mi><mi>ln</mi><mi>K</mi></mrow></msup><mi>φ</mi><mo>(</mo><mi>u</mi><mo>)</mo></mrow><mrow><mi>i</mi><mi>u</mi></mrow></mfrac><mo>]</mo></mrow><mi>d</mi><mi>u</mi></math>`,
  obj: `<math display="block"><msup><mi>p</mi><mo>*</mo></msup><mo>=</mo><munder><mi>argmin</mi><mrow><mi>p</mi><mo>∈</mo><mi>box</mi></mrow></munder><munder><mo>∑</mo><mi>i</mi></munder><msup><mrow><mo>(</mo><msub><mi>IV</mi><mi>model</mi></msub><mo>(</mo><mi>p</mi><mo>;</mo><msub><mi>K</mi><mi>i</mi></msub><mo>,</mo><msub><mi>τ</mi><mi>i</mi></msub><mo>)</mo><mo>−</mo><msubsup><mi>IV</mi><mi>i</mi><mi>mkt</mi></msubsup><mo>)</mo></mrow><mn>2</mn></msup><mo>,</mo><mspace width="1em"/><mo>(</mo><msup><mi>J</mi><mo>⊤</mo></msup><mi>J</mi><mo>+</mo><mi>λ</mi><mi>diag</mi><msup><mi>J</mi><mo>⊤</mo></msup><mi>J</mi><mo>)</mo><mi>δ</mi><mo>=</mo><mo>−</mo><msup><mi>J</mi><mo>⊤</mo></msup><mi>r</mi></math>`,
  hmm: `<math display="block"><msub><mi>x</mi><mi>t</mi></msub><mo>∣</mo><msub><mi>s</mi><mi>t</mi></msub><mo>=</mo><mi>k</mi><mo>∼</mo><mi>𝒩</mi><mo>(</mo><msub><mi>μ</mi><mi>k</mi></msub><mo>,</mo><msub><mi>Σ</mi><mi>k</mi></msub><mo>)</mo><mo>,</mo><mspace width="1em"/><mi>P</mi><mo>(</mo><msub><mi>s</mi><mi>t</mi></msub><mo>=</mo><mi>j</mi><mo>∣</mo><msub><mi>s</mi><mrow><mi>t</mi><mo>−</mo><mn>1</mn></mrow></msub><mo>=</mo><mi>i</mi><mo>)</mo><mo>=</mo><msub><mi>A</mi><mrow><mi>i</mi><mi>j</mi></mrow></msub></math>`,
  lewis: `<math display="block"><mfrac><mi>C</mi><mrow><msub><mi>D</mi><mi>T</mi></msub><msub><mi>F</mi><mi>T</mi></msub></mrow></mfrac><mo>=</mo><mn>1</mn><mo>−</mo><mfrac><msup><mi>e</mi><mrow><mi>k</mi><mo>/</mo><mn>2</mn></mrow></msup><mi>π</mi></mfrac><msubsup><mo>∫</mo><mn>0</mn><mi>∞</mi></msubsup><mfrac><mrow><mi>Re</mi><mo>[</mo><msup><mi>e</mi><mrow><mo>−</mo><mi>i</mi><mi>u</mi><mi>k</mi></mrow></msup><mi>φ</mi><mo>(</mo><mi>u</mi><mo>−</mo><mi>i</mi><mo>/</mo><mn>2</mn><mo>)</mo><mo>]</mo></mrow><mrow><msup><mi>u</mi><mn>2</mn></msup><mo>+</mo><mn>1</mn><mo>/</mo><mn>4</mn></mrow></mfrac><mi>d</mi><mi>u</mi><mo>,</mo><mspace width="1em"/><mi>k</mi><mo>=</mo><mi>ln</mi><mfrac><mi>K</mi><msub><mi>F</mi><mi>T</mi></msub></mfrac></math>`,
  bates: `<math display="block"><msub><mi>φ</mi><mi>Bates</mi></msub><mo>(</mo><mi>u</mi><mo>)</mo><mo>=</mo><msub><mi>φ</mi><mi>Heston</mi></msub><mo>(</mo><mi>u</mi><mo>)</mo><mspace width="0.2em"/><mi>exp</mi><mrow><mo>(</mo><mi>λ</mi><mi>τ</mi><mo>[</mo><msup><mi>e</mi><mrow><mi>i</mi><mi>u</mi><msub><mi>μ</mi><mi>J</mi></msub><mo>−</mo><msubsup><mi>σ</mi><mi>J</mi><mn>2</mn></msubsup><msup><mi>u</mi><mn>2</mn></msup><mo>/</mo><mn>2</mn></mrow></msup><mo>−</mo><mn>1</mn><mo>−</mo><mi>i</mi><mi>u</mi><mo>(</mo><msup><mi>e</mi><mrow><msub><mi>μ</mi><mi>J</mi></msub><mo>+</mo><msubsup><mi>σ</mi><mi>J</mi><mn>2</mn></msubsup><mo>/</mo><mn>2</mn></mrow></msup><mo>−</mo><mn>1</mn><mo>)</mo><mo>]</mo><mo>)</mo></mrow></math>`,
  dh: `<math display="block"><msub><mi>φ</mi><mi>2H</mi></msub><mo>(</mo><mi>u</mi><mo>)</mo><mo>=</mo><msub><mi>φ</mi><mi>Heston</mi></msub><mo>(</mo><mi>u</mi><mo>;</mo><msub><mi>κ</mi><mn>1</mn></msub><mo>,</mo><msub><mi>θ</mi><mn>1</mn></msub><mo>,</mo><msub><mi>σ</mi><mn>1</mn></msub><mo>,</mo><msub><mi>ρ</mi><mn>1</mn></msub><mo>,</mo><msub><mi>v</mi><mn>1</mn></msub><mo>)</mo><mspace width="0.2em"/><msub><mi>φ</mi><mi>Heston</mi></msub><mo>(</mo><mi>u</mi><mo>;</mo><msub><mi>κ</mi><mn>2</mn></msub><mo>,</mo><msub><mi>θ</mi><mn>2</mn></msub><mo>,</mo><msub><mi>σ</mi><mn>2</mn></msub><mo>,</mo><msub><mi>ρ</mi><mn>2</mn></msub><mo>,</mo><msub><mi>v</mi><mn>2</mn></msub><mo>)</mo></math>`,
  svi: `<math display="block"><mi>w</mi><mo>(</mo><mi>k</mi><mo>)</mo><mo>=</mo><msubsup><mi>σ</mi><mi>BS</mi><mn>2</mn></msubsup><mi>τ</mi><mo>=</mo><mi>a</mi><mo>+</mo><mi>b</mi><mrow><mo>[</mo><mi>ρ</mi><mo>(</mo><mi>k</mi><mo>−</mo><mi>m</mi><mo>)</mo><mo>+</mo><msqrt><msup><mrow><mo>(</mo><mi>k</mi><mo>−</mo><mi>m</mi><mo>)</mo></mrow><mn>2</mn></msup><mo>+</mo><msup><mi>s</mi><mn>2</mn></msup></msqrt><mo>]</mo></mrow><mo>,</mo><mspace width="1em"/><mi>q</mi><mo>(</mo><mi>K</mi><mo>)</mo><mo>=</mo><mfrac><mrow><msup><mo>∂</mo><mn>2</mn></msup><mi>C</mi></mrow><mrow><mo>∂</mo><msup><mi>K</mi><mn>2</mn></msup></mrow></mfrac></math>`,
  vix: `<math display="block"><mfrac><msubsup><mi>VIX</mi><mi>T</mi><mn>2</mn></msubsup><msup><mn>100</mn><mn>2</mn></msup></mfrac><mo>≈</mo><mi>θ</mi><mo>+</mo><mo>(</mo><msub><mi>v</mi><mn>0</mn></msub><mo>−</mo><mi>θ</mi><mo>)</mo><mfrac><mrow><mn>1</mn><mo>−</mo><msup><mi>e</mi><mrow><mo>−</mo><mi>κ</mi><mi>T</mi></mrow></msup></mrow><mrow><mi>κ</mi><mi>T</mi></mrow></mfrac><mo>,</mo><mspace width="1em"/><mi>T</mi><mo>∈</mo><mo>{</mo><mn>30</mn><mi>d</mi><mo>,</mo><mn>93</mn><mi>d</mi><mo>}</mo></math>`,
}

const Eq = ({ m, alt }: { m: string; alt: string }) => <div class="eq" role="math" aria-label={alt} dangerouslySetInnerHTML={{ __html: m }} />

export function Model({ market, spx }: { market: MarketData | null; spx: SpxData | null }) {
  return (
    <section class="view v-model" aria-labelledby="model-title">
      <article class="panel prose">
        <p class="eyebrow">06 / model</p>
        <h2 id="model-title">How the lab works</h2>
        <p>
          The Heston model treats volatility as random. The index S and its instantaneous variance v follow two correlated diffusions, and
          variance is pulled back toward a long-run level:
        </p>
        <Eq m={EQ.sde} alt="dS = (r minus q) S dt + square root of v S dW^S; dv = kappa (theta minus v) dt + sigma square root of v dW^v; correlation rho." />
        <ul>
          <li>
            <b>κ</b>: how fast variance mean-reverts. <b>θ</b>: the long-run variance. <b>σ</b>: vol of vol. <b>ρ</b>: spot–vol correlation (negative for
            equities, which produces the skew). <b>v₀</b>: today's variance.
          </li>
          <li>
            Variance stays strictly positive when the <b>Feller condition</b> 2κθ &gt; σ² holds. Calibrations to equity markets often violate it, and
            pricing remains valid when they do.
          </li>
        </ul>

        <h3>Pricing by Fourier inversion</h3>
        <p>
          Heston prices come from the characteristic function of ln S<sub>T</sub>, which has a closed form. The lab uses the “little Heston trap”
          form (Albrecher et al., 2007). It is algebraically equal to Heston's original, but its complex logarithm stays on the principal branch at
          long maturities.
        </p>
        <Eq m={EQ.cf} alt="Characteristic function phi of u equals exp of C plus D v0 plus i u times log forward, with the little-trap g = (xi minus d) over (xi plus d)." />
        <p>
          Gil-Pelaez inversion turns φ into exercise probabilities. The integral runs over (0, U] with 128 Gauss-Legendre nodes and U = 200, the
          values in <code>configs/base.yaml</code>. The nodes never land on the removable singularity at u = 0. Implied vols come from inverting
          Black-Scholes on the out-of-the-money leg with Brent's method.
        </p>
        <Eq m={EQ.gp} alt="Call = S0 e^{-q tau} P1 minus K e^{-r tau} P2, with P2 = 1/2 + 1/pi integral from 0 to U of the real part of e^{-iu ln K} phi(u) over i u." />

        <h3>Real option data</h3>
        <p>
          <code>scripts/bake_spx_options.py</code> reads Cboe's public delayed-quote chain for SPX and SPXW (every listed contract)
          {spx ? `, here as of ${spx.asOf.replace('T', ' ').replace('Z', ' UTC')}` : ''}. For each of ~12 expiries from one week to two years it fits
          put–call parity, C − P = D(F − K), on near-the-money pairs to get that expiry's forward F and discount factor D (for expiries under ~5 weeks
          D comes from the 2–12 month rate). It then keeps the out-of-the-money leg with two-sided quotes and a spread under 35% of mid, thins to 21
          strikes evenly spaced in standardised moneyness, and converts bid, mid and ask to Black implied vols. Only those derived vols, strikes,
          forwards and discount factors are published. PM-settled SPXW is used where it exists; the time to expiry runs to the settlement print.
        </p>
        <p>
          Every model then prices in forward units, where the forward and discounting drop out. Calls come from the Lewis (2001) single integral,
          better conditioned than Gil-Pelaez:
        </p>
        <Eq m={EQ.lewis} alt="C over D F = 1 minus e^{k/2} over pi times the integral of Re[e^{-iuk} phi(u - i/2)] over u squared plus one quarter, with k = ln K/F." />
        <p>
          Real fits push vol of vol to 4–6, where φ decays exponentially rather than like a Gaussian, so a single fixed truncation is not enough.
          The integral uses three Gauss–Legendre panels per expiry, [0, 2], [2, 12/a] and [12/a, 60/a] with a = σ<sub>ATM</sub>√τ (184 nodes),
          which reprices the fitted surfaces to about 1e-11 in implied vol against a 4,000-node reference.
        </p>

        <h3>Beyond Heston</h3>
        <p>
          <b>Bates (1996)</b> adds Merton lognormal jumps to the index. Jumps are independent of the diffusion, so the characteristic function
          gains a factor, and the compensator keeps the forward a martingale:
        </p>
        <Eq m={EQ.bates} alt="phi Bates equals phi Heston times exp of lambda tau times [e^{iu mu - sigma_J^2 u^2 / 2} minus 1 minus iu (e^{mu + sigma_J^2/2} minus 1)]." />
        <p>
          <b>Double Heston</b> (Christoffersen, Heston &amp; Jacobs, 2009) gives the index two independent variance factors. A fast one can carry the
          steep one-week skew while a slow one sets the long end, which one factor cannot do at the same time:
        </p>
        <Eq m={EQ.dh} alt="phi double Heston is the product of two Heston characteristic functions with their own kappa, theta, sigma, rho and v." />
        <p>
          <b>SVI</b> (Gatheral, 2004) is the benchmark: five parameters per expiry fitted to total implied variance. It is a smoothing curve, not a
          model of the index, so it has no dynamics and says nothing between expiries. Its second strike-derivative gives the market's
          risk-neutral density (Breeden–Litzenberger), and Gatheral's g(k) ≥ 0 certifies a slice free of butterfly arbitrage:
        </p>
        <Eq m={EQ.svi} alt="SVI total variance w(k) = a + b [rho (k - m) + square root of ((k - m)^2 + s^2)]; density q(K) = second derivative of C in K." />
        <p>
          Model densities come straight from the characteristic function, q(x) = (1/π)∫ Re[e<sup>−iux</sup>φ(u)] du, on a finer 696-node rule
          (the integrand oscillates faster far from the money). The density tab compares them, their skewness and kurtosis term structures, and
          the tail probabilities they imply.
        </p>

        <h3>Calibration</h3>
        <p>
          Calibration searches the same parameter box as the Python research code for the parameters that minimise squared implied-vol errors. The
          Python package uses scipy's L-BFGS-B on that scalar loss. In the browser, a bounded Levenberg–Marquardt solver uses the least-squares
          structure directly: a finite-difference Jacobian of the residuals, Nielsen damping, and projection onto the box. It runs in a Web Worker
          and streams every accepted step, which the market tab replays. The real-snapshot fits use a wider box than the textbook one (κ ≤ 50,
          σ ≤ 8) and the same equally weighted squared mid-IV objective; scipy's trust-region least squares solves it offline from the same starts.
        </p>
        <Eq m={EQ.obj} alt="p star = argmin over the box of the sum of squared implied-vol residuals; Levenberg-Marquardt step (J^T J + lambda diag J^T J) delta = minus J^T r." />
        <p>
          <b>Parity with Python.</b> A vitest suite checks the TypeScript core against fixtures generated by the repository's own Python modules.
          Characteristic-function values agree to about 1e-14 (relative) and prices to about 1e-11. Implied vols agree to about 1e-9, and the
          synthetic round trip recovers the ground truth within 1%. On each regime surface the browser optimiser finds the same optimum as
          L-BFGS-B (parameters within about 5e-5 relative) in 7–9 iterations, against about 30 for L-BFGS-B. For the real-market models,
          characteristic functions agree to ~1e-15, Lewis prices to ~3e-14, implied vols to ~7e-12 and densities to ~1e-13, and on the SPX
          snapshot the browser fit reaches the scipy optimum's RMSE to 4 significant figures for all three models.
        </p>

        <h3>Regimes</h3>
        <p>
          A 3-state Gaussian hidden Markov model (hmmlearn, full covariance; <code>models/hmm.py</code>) is fitted offline to daily features from
          real data: 21-day realised vol, VIX, the VIX3M − VIX slope and 63-day return skew. States are ordered by realised vol. The K = 2 and K = 4
          refits on the regimes tab run Baum–Welch in your browser. For K = 3, the browser fit reproduces the hmmlearn path on 100% of days.
        </p>
        <Eq m={EQ.hmm} alt="x_t given s_t = k is normal with mean mu_k and covariance Sigma_k; transition probabilities A_ij." />
        <p>
          Regime-conditional Heston parameters are read from the real VIX term structure. Under Heston, squared VIX is the expected average
          variance over its tenor:
        </p>
        <Eq m={EQ.vix} alt="VIX squared over 100 squared approximately equals theta plus (v0 minus theta) times (1 minus e^{-kappa T}) over kappa T, for T of 30 and 93 days." />
        <p>
          The pooled slope of VIX3M² on VIX² gives one κ{market ? ` (${num(market.estimation.kappa, 2)})` : ''}. Each regime's θ and v₀ follow from the
          two tenors, σ from day-to-day variance changes, and ρ from their correlation with S&amp;P 500 returns. These parameters approximate each
          regime. They are not a calibration to traded options.
        </p>

        <h3>Paths</h3>
        <p>
          Monte Carlo uses Andersen's quadratic-exponential scheme for the variance, which samples the exact transition closely and never produces
          negative variance. The log-price uses the matching discretisation. The sanity checks on the paths tab compare E[S<sub>T</sub>] with the
          forward, and an MC call price with the Fourier price.
        </p>

        <h3>What is real, what is estimated</h3>
        <ul>
          <li>
            <b>Real:</b> one snapshot of SPX option quotes (Cboe delayed data{spx ? `, ${spx.asOf.slice(0, 10)}` : ''}), stored as derived implied vols;
            daily S&amp;P 500 close, VIX, VIX3M and 3-month Treasury yield from FRED{market ? `, ${market.start} to ${market.asOf}` : ''}.
          </li>
          <li>
            <b>Estimated:</b> every model fit, the SVI slices, the HMM regimes and the regime Heston parameters (a VIX-based proxy). There is no free
            history of option chains, so regimes are not tied to option-implied fits except through today's snapshot.
          </li>
          <li>
            <b>Computed live:</b> every surface, calibration, path and K ≠ 3 regime fit runs on your device. The page makes no API calls.
          </li>
        </ul>
        <p>
          Data is baked by <code>scripts/bake_market_data.py</code> and <code>scripts/bake_spx_options.py</code>, parity fixtures by{' '}
          <code>scripts/make_parity_fixtures.py</code>. Source:{' '}
          <a href="https://github.com/austxu/heston-regime-lab">github.com/austxu/heston-regime-lab</a>.
        </p>
      </article>
      <aside>
        <div class="panel panel-pad">
          <p class="eyebrow" style={{ marginBottom: '10px' }}>
            parity with python · vitest
          </p>
          <dl class="kv">
            <div>
              <dt>Characteristic function</dt>
              <dd>
                1.6e−14<small>max relative difference</small>
              </dd>
            </div>
            <div>
              <dt>Call and put prices</dt>
              <dd>
                1.1e−11<small>max abs., S₀ = 100</small>
              </dd>
            </div>
            <div>
              <dt>Implied vols</dt>
              <dd>
                1.7e−10<small>max abs., OTM price &gt; 1e−4</small>
              </dd>
            </div>
            <div>
              <dt>Round trip, clean data</dt>
              <dd>
                &lt; 1%<small>every parameter vs truth</small>
              </dd>
            </div>
            <div>
              <dt>Regime fits vs L-BFGS-B</dt>
              <dd>
                4.8e−5<small>max rel. parameter difference</small>
              </dd>
            </div>
            <div>
              <dt>Lewis prices, 3 models</dt>
              <dd>
                2.6e−14<small>per unit forward; IVs 6.7e−12</small>
              </dd>
            </div>
            <div>
              <dt>Model densities</dt>
              <dd>
                9.3e−14<small>max abs. vs numpy</small>
              </dd>
            </div>
            <div>
              <dt>SPX fits vs scipy</dt>
              <dd>
                same optimum<small>RMSE equal to 4 s.f.</small>
              </dd>
            </div>
            <div>
              <dt>HMM, K = 3</dt>
              <dd>
                100%<small>days matching hmmlearn</small>
              </dd>
            </div>
          </dl>
          <p class="panel-sub" style={{ marginTop: '10px' }}>
            Observed in the last run of <code>npm test</code> against fixtures from <code>scripts/make_parity_fixtures.py</code>.
          </p>
        </div>
        {spx && (
          <div class="panel panel-pad">
            <p class="eyebrow" style={{ marginBottom: '10px' }}>
              option snapshot
            </p>
            <dl class="kv">
              <div>
                <dt>Quotes as of</dt>
                <dd>
                  {spx.asOf.slice(0, 10)}
                  <small>{spx.asOf.slice(11, 16)} UTC</small>
                </dd>
              </div>
              <div>
                <dt>SPX</dt>
                <dd>
                  {num(spx.spot, 2)}
                  <small>{spx.spotChangePct >= 0 ? '+' : '−'}{num(Math.abs(spx.spotChangePct), 2)}% on the day</small>
                </dd>
              </div>
              <div>
                <dt>Quotes kept</dt>
                <dd>
                  {spx.slices.reduce((t, s) => t + s.k.length, 0)}
                  <small>
                    of {spx.slices.reduce((t, s) => t + s.listed, 0).toLocaleString('en-US')} listed on {spx.slices.length} expiries
                  </small>
                </dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>
                  Cboe<small>delayed quotes, derived values only</small>
                </dd>
              </div>
            </dl>
          </div>
        )}
        {market && (
          <div class="panel panel-pad">
            <p class="eyebrow" style={{ marginBottom: '10px' }}>
              baked data
            </p>
            <dl class="kv">
              <div>
                <dt>Trading days</dt>
                <dd>{market.series.t.length.toLocaleString('en-US')}</dd>
              </div>
              <div>
                <dt>Range</dt>
                <dd>
                  {market.start}
                  <small>to {market.asOf}</small>
                </dd>
              </div>
              <div>
                <dt>Series</dt>
                <dd>
                  SP500 · VIXCLS<small>VXVCLS · DGS3MO (FRED)</small>
                </dd>
              </div>
              <div>
                <dt>Generated</dt>
                <dd>{market.generatedAt.replace('T', ' ')}</dd>
              </div>
            </dl>
          </div>
        )}
      </aside>
    </section>
  )
}
