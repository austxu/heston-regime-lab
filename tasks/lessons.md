# Lessons

Format: `[date] | what went wrong | rule to prevent it`

2026-06-24 | (seed) Heston char-fn g1 formulation has branch-cut discontinuities in the
complex log that corrupt the Fourier integral for long maturities | Always use the g2
"little Heston trap" (Albrecher et al. 2007) formulation; verify martingale φ(-i)=F.

2026-06-24 | (seed) Gil-Pelaez integrand Re[e^{-iu ln K}φ(u)/(iu)] has a 0/0 singularity
at u=0 | Use Gauss-Legendre on an open interval so nodes never land on 0; the singularity
is removable and never needs explicit evaluation.

2026-06-24 | Cross-checking GL pricing vs adaptive quad at 1e-8 failed for deep-OTM,
short-dated options (slowest-decaying integrand) — both methods share a ~1e-8 truncation
floor | Set such cross-quadrature tolerances at 1e-7, not 1e-8; tighter than that tests the
truncation floor, not the implementation. Tighten only by raising U / n_nodes if needed.

2026-06-24 | Regime calibrations ran ~40s each (1700+ feval) — the slow case was the
LOW-vol regime, not crisis: deep-OTM / short-dated options are near-zero and non-invertible
in low vol, returning nan that the objective penalises with a 10.0 cliff, which makes
L-BFGS-B thrash | Always liquidity-filter (near-the-money, finite IV, min maturity) BEFORE
calibrating, not just in the API path. The deep-OTM nan-penalty cliff, not the optimiser,
is the cost.

2026-06-24 | xgboost imported but failed to load its native lib (libxgboost.dylib ->
libomp.dylib not found) on macOS | xgboost needs the OpenMP runtime: `brew install libomp`.
Guard the import and fall back to sklearn GradientBoosting so the residual model still runs.

2026-06-24 | `tsc -b --noEmit` errors ("--noEmit cannot be specified with --build") | For a
typecheck script use `tsc --noEmit -p tsconfig.app.json` (or plain `tsc -b`, since the app
tsconfig already sets noEmit). Don't combine `-b` with `--noEmit`.

2026-06-24 | The frontend nginx `proxy_pass http://api:8000` only resolves under
docker-compose (shared network alias). On Railway, services don't see each other by bare
name | Prefer same-origin proxying with `API_HOST=${{api.RAILWAY_PRIVATE_DOMAIN}}` and a
fixed referenced `API_PORT`; use `VITE_API_BASE` + exact CORS origins only when the API is
intentionally public.

2026-06-24 | Can't deploy to Railway from this environment (needs the user's account/login).
| For deploy phases, produce all config + CI/CD that auto-deploys once a token secret exists,
document the manual steps in DEPLOY.md, and use a placeholder live URL — be explicit that the
deploy itself is the user's step rather than implying it's done.

2026-07-15 | nginx returned plain text from `/health` while the typed dashboard client
expected the API's JSON health contract | Platform/container liveness should use `/`; proxy
the browser-facing `/health` route to FastAPI so local Compose and production behave alike.

2026-07-15 | A root Docker build context combined with `COPY . .` can send `.git`, virtual
environments, node_modules, and secrets into an API image | Maintain `.dockerignore` and use
explicit runtime-only `COPY` statements; run the resulting process as a non-root UID.

2026-07-15 | A `workflow_run` deployment that checks out the default branch can deploy a
newer commit than the one CI actually tested | Check out `workflow_run.head_sha`, pin the
deployment CLI, and serialize production deploys.
