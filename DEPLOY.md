# Deployment (Railway)

The stack deploys as **three Railway services in one project**: a managed **Redis**, the
**API** (FastAPI), and the **frontend** (nginx-served React build). Config-as-code lives in
`railway.json` (API) and `frontend/railway.json` (frontend); both build from the Dockerfiles
in `docker/`.

```
                 ┌─────────────┐
  browser  ──►   │  frontend   │  (nginx, static SPA)
                 └─────┬───────┘
                       │  /api, /ws  (or VITE_API_BASE → API public URL)
                 ┌─────▼───────┐        ┌──────────┐
                 │     api     │ ─────► │  Redis    │ (cache, persistent volume)
                 └─────┬───────┘        └──────────┘
                       │ yfinance / FRED (live, with synthetic fallback)
                       ▼
                 market data
```

## One-time setup

1. **Create a project** at [railway.app](https://railway.app) and connect this GitHub repo.
2. **Add Redis**: New → Database → Redis. It comes with a persistent volume, so the cache
   survives redeploys. Railway exposes its connection string as `${{Redis.REDIS_URL}}`.
3. **Add the API service** from the repo:
   - Config-as-code path: `railway.json` (Dockerfile `docker/Dockerfile.api`, healthcheck `/health`).
   - Variables (below). Generate a public domain for it.
4. **Add the frontend service** from the same repo:
   - Config-as-code path: `frontend/railway.json` (Dockerfile `docker/Dockerfile.frontend`).
   - Build variable `VITE_API_BASE` = the API service's public URL (so the SPA calls the API
     cross-origin). Generate a public domain for it.

## Environment variables

| Service  | Variable | Value / notes |
|----------|----------|---------------|
| api      | `REDIS_URL` | `${{Redis.REDIS_URL}}` (reference the Redis service) |
| api      | `CORS_ORIGINS` | the frontend's public URL (e.g. `https://hrl-frontend.up.railway.app`) — restricts CORS to it |
| api      | `FRED_API_KEY` | optional; enables the live risk-free rate |
| api      | `SENTRY_DSN` | optional; enables error tracking |
| api      | `LOG_FORMAT` | `json` (default) |
| api      | `ENVIRONMENT` | `production` |
| frontend | `VITE_API_BASE` | the API's public URL (build-time) |

`HRL_OFFLINE=1` on the API forces the synthetic data path (handy for a no-key demo).

## CORS

Production CORS is locked to the deployed frontend origin via `CORS_ORIGINS` (comma-separated
if you have several). When unset, the API falls back to the localhost dev origins in
`configs/base.yaml`.

## Redis persistence

Railway's managed Redis is backed by a volume, so cached calibrations/regime inference
survive redeploys. (If you instead run Redis from `redis:7-alpine`, attach a volume at
`/data` and start with `--appendonly yes`.) Cache keys are also session-scoped, so stale
entries roll over after market close regardless.

## Health checks & restarts

Both services declare a `healthcheckPath` (`/health` for the API, `/` for the frontend) and
`restartPolicyType: ON_FAILURE`, so Railway restarts an unhealthy container automatically.

## CI/CD

- **CI** (`.github/workflows/ci.yml`) runs on every push/PR: pytest + `tsc --noEmit` +
  frontend build, and (on push) builds both Docker images.
- **CD** (`.github/workflows/deploy.yml`) runs after CI succeeds on `main`/`master` and
  deploys via the Railway CLI. It needs a repo secret **`RAILWAY_TOKEN`** (a project token
  from Railway → project → Settings → Tokens); optional repo *variables*
  `RAILWAY_API_SERVICE` / `RAILWAY_FRONTEND_SERVICE` override the default service names
  (`api` / `frontend`). Without the token the deploy job no-ops.

> Simplest alternative: Railway's **native GitHub integration** auto-redeploys each service
> on push to the watched branch — no token or Action needed. The `deploy.yml` Action is for
> teams that want deploys gated explicitly on green CI.
