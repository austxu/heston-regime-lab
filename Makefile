PYTHON ?= python

.PHONY: bootstrap test lint frontend-check compose-check check

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
