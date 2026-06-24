# TODO — Phase 4: Deploy, CI/CD, production hardening

Ship the full stack as a live app with CI/CD and production hardening.

**Reality check:** the actual Railway deploy requires the user's Railway account/login, which
this environment can't do. I produce all deploy config + CI/CD (auto-deploys once a
RAILWAY_TOKEN secret exists) + a DEPLOY.md, and use a placeholder live URL until deployed.

## Plan (each step has a verify condition)
- [ ] Production hardening (API):
      - gzip response compression → verify: Content-Encoding: gzip on large responses
      - CORS from env (prod = deployed origin only) → verify: CORS_ORIGINS overrides config
      - structured JSON logging + request middleware → verify: JSON log line per request
      - Sentry init guarded by SENTRY_DSN → verify: no-op without DSN, inits with it
      - rate limit calibration endpoint (1/min/IP) → verify: 2nd call within window → 429
      - yfinance request timeout → cache/synthetic fallback → verify: timeout raises DataUnavailable
- [ ] CI: .github/workflows/ci.yml — pytest + tsc on push(main/master) & PR
      → verify: workflow YAML valid; steps mirror local commands
- [ ] CD: deploy to Railway on push to main (after CI), gated on RAILWAY_TOKEN
      → verify: deploy job present, conditional, documented
- [ ] Railway config: railway.json (api), frontend/railway.json, DEPLOY.md, redis volume notes
      → verify: configs reference the right Dockerfiles + healthcheck
- [ ] visualization/plots.py: diagnostic charts (surface fit, regime overlay, comparison, convergence)
      → verify: running it writes PNGs under docs/assets/
- [ ] README: badges, live-demo placeholder, mermaid architecture diagram, embedded charts,
      research findings, local dev + API docs link
      → verify: renders; badges point at the repo's Actions
- [ ] Tests for hardening (rate limit, gzip); full pytest + tsc + build green
      → verify: `pytest -q` green; `npm run build` green
- [ ] Commit in focused batches; push

## Done when
CI runs tests+typecheck on every push/PR and auto-deploys to Railway on main (once the
token is set); the API is hardened (gzip, rate limit, JSON logs, Sentry, timeouts); the
README has badges, an architecture diagram, embedded charts, and a live-demo link slot.
