# Lessons

Format: `[date] | what went wrong | rule to prevent it`

2026-06-24 | (seed) Heston char-fn g1 formulation has branch-cut discontinuities in the
complex log that corrupt the Fourier integral for long maturities | Always use the g2
"little Heston trap" (Albrecher et al. 2007) formulation; verify martingale φ(-i)=F.

2026-06-24 | (seed) Gil-Pelaez integrand Re[e^{-iu ln K}φ(u)/(iu)] has a 0/0 singularity
at u=0 | Use Gauss-Legendre on an open interval so nodes never land on 0; the singularity
is removable and never needs explicit evaluation.
