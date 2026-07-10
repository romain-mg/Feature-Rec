DB_CONTAINER := feature-rec-pg
DB_URL       := postgres://postgres:postgres@localhost:5432/postgres

.DEFAULT_GOAL := help
.PHONY: help db db-wait db-stop db-clean dev selftest selftest-service typecheck ci

help: ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

db: ## start local Postgres 18 (idempotent)
	@docker info >/dev/null 2>&1 || \
		{ echo "Docker daemon not running — start Docker Desktop first (open -a Docker)"; exit 1; }
	@docker start $(DB_CONTAINER) 2>/dev/null || \
		docker run -d --name $(DB_CONTAINER) -p 5432:5432 \
			-e POSTGRES_PASSWORD=postgres postgres:18
	@$(MAKE) --no-print-directory db-wait

db-wait: ## block until Postgres accepts connections
	@until docker exec $(DB_CONTAINER) pg_isready -U postgres -q; do sleep 0.5; done

db-stop: ## stop the Postgres container
	docker stop $(DB_CONTAINER)

db-clean: ## remove the Postgres container and its data
	docker rm -f $(DB_CONTAINER)

dev: db ## load .env and run the service locally against local Postgres
	@set -a; \
	if [ -f .env ]; then . ./.env; fi; \
	set +a; \
	DATABASE_URL=$(DB_URL) pnpm feature-rec:service

selftest: db ## run all selftests (core + service + action)
	TEST_DATABASE_URL=$(DB_URL) pnpm feature-rec:selftest

selftest-service: db ## run only the service selftest (the DB-bound one)
	TEST_DATABASE_URL=$(DB_URL) pnpm --filter @feature-rec/service run selftest

typecheck: ## typecheck all packages
	pnpm run typecheck

ci: typecheck selftest ## typecheck + selftests (planned CI gate minus lint)
