# CI Plan

The repo currently has **no CI** (`.github/` holds only app config, no workflows). Because the service runs via `tsx`, which strips types without checking them, nothing today prevents merging code that doesn't compile. CI is the missing gate the Postgres migration plan leans on (its step 9 assumes typecheck + selftests run somewhere enforced).

Scope: one GitHub Actions workflow, no deploy stages, no matrix. Small on purpose.

## Workflow: `.github/workflows/ci.yml`

Triggers: `pull_request` and `push` to `main`.

Single job (the repo is small enough that parallel jobs buy latency but cost setup duplication; split later if it slows):

1. **Setup**: checkout; `corepack enable` (repo pins `pnpm@11.9.0` via `packageManager`); Node 22 via `actions/setup-node` with `cache: pnpm`; `pnpm install --frozen-lockfile` — frozen so a `package.json`/lockfile drift (the thing step 1 of the migration plan warns about) fails loudly here.
2. **Typecheck**: `pnpm -r typecheck`, backed by a new `"typecheck": "tsc --noEmit"` script added to each package. This is the gate that `tsx` removed — non-negotiable, runs first because it's the fastest failure.
3. **Lint**: minimal flat-config ESLint with `typescript-eslint`, only rules that catch bug classes the reviews actually hit — `@typescript-eslint/no-floating-promises` and `no-misused-promises` (the `if (!promiseReturningCall())` family from the async store migration). Not a style linter; keep the rule set under ten.
4. **Selftests**: `pnpm feature-rec:selftest` (core + service + action aggregate). The service selftest needs Postgres, provided as a workflow service container:

```yaml
services:
  postgres:
    image: postgres:18
    env:
      POSTGRES_PASSWORD: postgres
    ports: ["5432:5432"]
    options: >-
      --health-cmd "pg_isready -U postgres"
      --health-interval 5s --health-timeout 5s --health-retries 10
env:
  TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
```

Matches the selftest contract from the migration plan (admin URL; the test creates/drops its own uniquely named database, so parallel CI runs can't collide).

## Deliberately out of scope (add when the trigger happens)

- **Build/publish artifact** — when the service is containerized, add a `tsup`/esbuild bundle job then; until then `tsx` is the runtime and there is nothing to build.
- **Action packaging check** — if/when `packages/action` is published for external consumers, add a job verifying the committed dist matches source.
- **Migration-drift check** — if migration count grows, a one-line assertion that files in `migrations/` equal static-map entries (see migration plan, step 3).
- **Coverage, release automation, deploy pipelines** — nothing to deploy from CI yet.

## Definition of done

A PR that fails typecheck, lint, or any selftest cannot merge (branch protection on `main` requiring the workflow). Local parity: `make ci` (typecheck + selftests against local docker Postgres) reproduces the gate *minus lint* — no ESLint config exists yet, so local parity is exact only once step 3's lint setup lands. Update `make ci` to include lint at that point.
