# Agent orientation — Agora / Feature-Rec

Read this first; it's the map. Deep detail lives in the linked docs — trust them over re-derivation.

## What this repo is

Feature-Rec: a GitHub Action + backend that watches PRs, classifies whether a diff is frontend-visible, renders a video of the change (Remotion), and routes it to Slack for human validation, reporting back via a GitHub check run and PR comments. pnpm monorepo, TypeScript, ESM, Node >= 20, run via `tsx` (no build step, no ESLint — typecheck is the only static gate).

## Layout

- `packages/core` — shared Zod schemas/types (config, statuses, run request/response). Contract source of truth.
- `packages/service` — Fastify backend: cycle lifecycle, Postgres store, GitHub/Slack side effects. Most invariants live here.
- `packages/action` — composite GitHub Action (runs from source via tsx); classifier + diff extraction + backend client.
- `packages/cli` / `packages/video` — Remotion render pipeline (scene generation, offline agent).
- `apps/web` — Next.js app, no DB usage.
- `feature-rec-testbed/` — separate nested git repo (ignored by this one) for live end-to-end testing; see its `README.md`.

## Authoritative docs

- `docs/postgres-migration-plan.md` — design authority for the service's storage + concurrency model: guarded transitions, attempt ownership, `startCycle` advisory lock, attach-and-recheck repair, deferred items, and an appendix sequence diagram of every call/response. If you touch `packages/service` lifecycle code, read this first and keep code and doc in sync.
- `docs/ci-plan.md` — the **planned** CI gate (typecheck + lint-lite + selftests with a Postgres service container). Not yet implemented: there is no `.github/workflows/` file today, so nothing is enforced on push — run the gates locally.
- `docs/feature-rec.md` — consumer setup guide (GitHub App permissions, Slack app scopes, workflow wiring).
- `docs/technical-architecture.md`, `docs/architecture-hosting-strategy.corrected.md` — broader architecture context; older, verify against code before relying on details.

## Commands

- `make help` — list targets. `make db` (local Postgres 18, idempotent), `make dev` (service on :3000), `make selftest` (core + service + action aggregate), `make selftest-service` (DB-bound one only), `make typecheck`, `make ci` (typecheck + selftests — the planned CI gate minus lint, which doesn't exist yet).
- Without make: `pnpm run typecheck`, `pnpm feature-rec:selftest`, `pnpm feature-rec:service`.
- Service needs `.env` (see `.env.example`); `DATABASE_URL` is the only var required *to start the process*. A usable deployment also needs `FEATURE_REC_RUNNER_TOKEN` (runner calls 401 without it), and GitHub App + Slack credentials once real side effects run (calls throw at use time, not startup). Tests use `TEST_DATABASE_URL` (admin URL; the selftest creates/drops its own throwaway database).

## Invariants to preserve (service work)

- A stale or duplicate runner must never move a cycle backward or overwrite the active cycle.
- Every status change is an atomic conditional UPDATE (`transitionRunnerStatus` with required `attemptId`, `transitionSlackStatus` without) — never read-then-write, never widen a from-set to "fix" a flow.
- DB transition first, external side effects (GitHub/Slack) after; artifact attach calls (`attachCheckRun`, `attachSlackMessage`) return current status so the creator repairs its own artifact if superseded mid-window.
- Multi-statement invariants need the per-PR advisory lock (see `startCycle`); single-statement guards don't.
- Duplicate detection relies on unique constraints + `ON CONFLICT`, never on error-message matching.

## Testing conventions

- Selftests are plain `node:assert` scripts (`scripts/selftest.mts` in core, service, and action — the aggregate covers exactly those three), run via tsx — no test framework. Service selftest requires Postgres (use `make selftest-service`). The CLI has no selftest script; it has a separate validator (see `docs/feature-rec.md`).
- New lifecycle behavior needs a matching case in the service selftest; the migration plan's step 7 lists the existing concurrency matrix.

## Gotchas

- `tsx` strips types without checking them — always run `pnpm run typecheck` before considering work done; nothing else catches type errors.
- TypeScript won't flag `if (!promiseReturningCall())` — every `store.` call site must be `await`ed; grep for missing awaits when touching handlers.
- `pg` returns `bigint` (int8) columns as strings — see `check_run_id` mapping in the store.
- Kysely migrations use a static import map (`src/storage/migrations/`), not `FileMigrationProvider`; a new migration file must also be added to the map or it silently never runs.
- The GitHub Action installs this whole monorepo at CI time and runs from source; the workflow `uses:` ref must point at a pushed branch.
