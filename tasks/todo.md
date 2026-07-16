# Maintenance backlog

The four implementation phases are complete. This file tracks real follow-up work instead
of preserving the obsolete Phase 4 launch checklist.

## Completed repository readiness

- [x] Deterministic offline math, data, API, and hardening tests
- [x] Python lint plus frontend lint/typecheck/build in CI
- [x] API/frontend production image builds in CI
- [x] Non-root, runtime-only API image and restricted Docker build context
- [x] Same-origin nginx proxy for REST, health, and WebSocket traffic
- [x] Railway config, exact-green-commit CD workflow, and deployment runbook
- [x] Rate limiting, gzip, request IDs/JSON logs, optional Sentry, and cache fallback

## User-owned launch steps

- [ ] Create the Railway project, managed Redis, API, and frontend services
- [ ] Configure service references/secrets and a GitHub `RAILWAY_TOKEN`
- [ ] Generate the frontend domain and run the smoke checks in `DEPLOY.md`
- [ ] Add a real demo URL to `README.md` only after it is verified
- [ ] Configure external uptime monitoring and resource/billing alerts

## Engineering follow-ups

- [ ] Move calibration job state to Redis or a durable queue before scaling the API above
      one replica
- [ ] Replace the simplified weekday session key with an exchange-holiday calendar
- [ ] Add end-to-end browser coverage for the deployed same-origin REST/WebSocket path
- [ ] Evaluate an unprivileged nginx base after verifying dynamic `PORT` templating on
      Compose and Railway; the API image already runs as a non-root UID
- [ ] Periodically refresh dependency bounds and the pinned Ruff/Railway CLI versions under
      a green CI run
