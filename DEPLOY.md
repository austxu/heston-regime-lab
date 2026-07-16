# Deployment (Railway)

The recommended production topology exposes only the nginx frontend. nginx forwards
`/api`, `/health`, and `/ws` to FastAPI over Railway's private network; the API reaches
managed Redis privately as well. This keeps browser traffic same-origin and avoids making
the API a second public entry point.

```text
browser ──HTTPS──> frontend (public nginx)
                       │
                       ├── /api, /health, /ws
                       ▼
                 api.railway.internal:8000 (FastAPI)
                       │
                       ▼
                  managed Redis
```

Railway setup is still a user-owned operation: this repository does not contain project
IDs, tokens, domains, or secrets.

## 1. Create the services

1. Create one Railway project and environment.
2. Add a managed Redis database.
3. Add two services from this GitHub repository, named `api` and `frontend` (the workflow
   defaults use those names).
4. Keep the repository root as the build context for **both** services. Do not set the
   frontend Root Directory to `/frontend`: its Docker build also needs `/docker`.
5. Set each service's Config-as-Code path:

   | Service | Config path | Dockerfile |
   |---|---|---|
   | API | `/railway.json` | `docker/Dockerfile.api` |
   | Frontend | `/frontend/railway.json` | `docker/Dockerfile.frontend` |

   Railway requires the custom frontend config path to be repository-absolute. See its
   [Config as Code guide](https://docs.railway.com/config-as-code#using-a-custom-config-as-code-file).

6. Generate a public domain for `frontend`. A public API domain is optional and is not
   needed for the dashboard.

## 2. Configure variables

Use Railway reference variables instead of copying generated credentials or hostnames.
Variable/service names are case-sensitive; select the generated references in the UI if
your Redis service has a different name.

### API service

| Variable | Value / purpose |
|---|---|
| `PORT` | `8000` — fixes the private port used by nginx and the Railway health check |
| `UVICORN_HOST` | `::` — bind Uvicorn's IPv6 wildcard for Railway private networking |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` (choose the managed Redis reference) |
| `ENVIRONMENT` | `production` |
| `LOG_FORMAT` | `json` |
| `FRED_API_KEY` | optional; enables the live risk-free-rate source |
| `SENTRY_DSN` | optional; enables error reporting |
| `SENTRY_TRACES_SAMPLE_RATE` | optional, e.g. `0.05`; defaults to no tracing |
| `HRL_OFFLINE` | optional; set `1` for a deterministic synthetic-only demo |

The API defaults to live data with synthetic fallback when `HRL_OFFLINE` is unset. Never
put these values in `.env` files committed to Git.

### Frontend service

| Variable | Value / purpose |
|---|---|
| `API_HOST` | `${{api.RAILWAY_PRIVATE_DOMAIN}}` |
| `API_PORT` | `${{api.PORT}}` |
| `DNS_RESOLVER` | `[fd12::10]` — Railway's project-scoped private DNS resolver |
| `TRUST_UPSTREAM_PROXY` | `1` — trust Railway edge's overwritten `X-Real-IP` header |
| `VITE_API_BASE` | leave unset/empty so browser requests stay same-origin through nginx |

`API_HOST`, `API_PORT`, `DNS_RESOLVER`, and `TRUST_UPSTREAM_PROXY` are runtime values
consumed by nginx's template. nginx re-resolves the private API name every 10 seconds so
an API-only redeploy does not pin the frontend to an old address. `VITE_API_BASE` is a
Vite build-time value; changing it requires a rebuild.

The trust switch is deliberately off by default. When off, nginx ignores inbound
`X-Real-IP` / `X-Forwarded-For` values and identifies the socket peer. Enable it only when
the service is reachable exclusively through a trusted edge that overwrites
`X-Real-IP`—as Railway does for this topology. nginx replaces both headers sent to FastAPI
with one validated, IP-shaped value; it never appends an attacker-controlled chain.

`UVICORN_HOST=::` makes Uvicorn open an IPv6 wildcard socket, covering legacy Railway
environments whose internal DNS may be IPv6-only; Railway's Linux networking treats this
as the service's dual-stack bind. Compose explicitly keeps `UVICORN_HOST=0.0.0.0`, and the
image health check selects `::1` or `127.0.0.1` to match. See
[Railway private networking](https://docs.railway.com/private-networking#internal-dns).

## 3. Deploy and smoke-test

Deploy Redis, then API, then frontend. After Railway marks both application deployments
healthy, verify the public frontend domain:

```bash
curl -fsS https://YOUR-FRONTEND-DOMAIN/health
curl -fsS 'https://YOUR-FRONTEND-DOMAIN/api/regime/current?live=false'
```

Open the dashboard and confirm the API status is connected, switch between Live and
Synthetic modes, and run one calibration to verify the WebSocket path. Railway health
checks gate a new deployment before traffic moves to it; the frontend check uses its
proxied `/health` route so a broken private API connection cannot deploy green. These are
startup checks, not continuous monitoring. Add an external uptime monitor for ongoing availability. See
[Railway health checks](https://docs.railway.com/deployments/healthchecks).

## CI/CD

CI runs Ruff, deterministic pytest, frontend lint/type checks/build, Compose validation,
and both Docker builds. The deploy workflow runs only after CI succeeds on `main` or
`master`, checks out the exact tested commit, and uses a pinned Railway CLI.

To enable it, create a Railway **project token** for the production environment and add it
as the GitHub Actions secret `RAILWAY_TOKEN`. Optional repository variables
`RAILWAY_API_SERVICE` and `RAILWAY_FRONTEND_SERVICE` override the default service names.
The workflow safely no-ops while the token is absent.

Choose one deployment trigger: if this GitHub Actions workflow is enabled, disable
Railway's native GitHub autodeploy for these services to avoid duplicate deployments.

## Optional split-origin deployment

If you intentionally expose the API directly:

1. Generate an API public domain.
2. Set frontend `VITE_API_BASE` to `https://${{api.RAILWAY_PUBLIC_DOMAIN}}` and rebuild.
3. Set API `CORS_ORIGINS` to the exact frontend origin (comma-separated for more than one).

Do not use `*` with credentialed CORS. The private same-origin topology above is simpler
and avoids CORS entirely.

## Operational notes

- Keep the API at one replica for now. Calibration job status is process-local, so polling
  can hit a different worker if the service is scaled horizontally. Cached research
  results and rate-limit buckets can still use shared Redis.
- Redis data is a cache, not the system of record. Persistence improves warm restarts, but
  the application can reconstruct values or fall back to synthetic data.
- `ON_FAILURE` restarts a process that exits unsuccessfully; it does not continuously poll
  `/health`. Review logs, Sentry, and external uptime checks for runtime failures.
- For a rollback, use Railway's deployment history to redeploy the last known-good image,
  then verify `/health` and a synthetic endpoint before reopening traffic.
