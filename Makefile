PYTHON ?= python

.PHONY: bootstrap test lint frontend-check compose-check check bake bake-options fixtures

bootstrap:
	$(PYTHON) -m pip install -r requirements-dev.txt
	npm --prefix frontend ci

test:
	HRL_OFFLINE=1 REDIS_URL= $(PYTHON) -m pytest -q

lint:
	ruff check .
	ruff format --check .

frontend-check:
	npm --prefix frontend run lint
	npm --prefix frontend run typecheck
	npm --prefix frontend test
	npm --prefix frontend run build

compose-check:
	docker compose config --quiet

check: lint test frontend-check

# Refresh the browser lab's baked FRED history / HMM regimes (needs network).
bake:
	HRL_OFFLINE=1 $(PYTHON) -m scripts.bake_market_data

# Bake a fresh real SPX implied-vol snapshot from Cboe delayed quotes and refit every model
# (needs network; pass INPUT=chain.json to use a saved chain instead).
bake-options:
	$(PYTHON) -m scripts.bake_spx_options $(if $(INPUT),--input $(INPUT))

# Regenerate the Python reference values the TypeScript math core is tested against.
fixtures:
	HRL_OFFLINE=1 $(PYTHON) -m scripts.make_parity_fixtures
