# SQLite → Postgres Migration Plan

Scope: replace SQLite entirely with a 1:1 schema port (text timestamps, JSON as text), using **Kysely + `pg`** as the query layer. No data migration needed — no production `.db` file exists. All DB code lives in `packages/service`.

## Step 1 — Add the driver

- `packages/service/package.json`: add `kysely` and `pg` (+ `@types/pg` in devDependencies) via `pnpm --filter @feature-rec/service add kysely pg` / `add -D @types/pg`, and commit the resulting `pnpm-lock.yaml` update alongside — hand-editing package.json without the lockfile lets installs drift.
- Remove the `node:sqlite` type shim `src/node-sqlite.d.ts` (in step 6, once nothing imports it).

## Step 2 — Make `CycleStore` async

`node:sqlite` is synchronous; `pg` is not. This is the one structural change.

- `src/storage.ts`: change every `CycleStore` method to return a `Promise<...>` (`getCycle`, `getCycleByKey`, `recordProcessedInteraction`, `close`). Four replacements (all defined in step 3, concurrency): `upsertCycle` + `markSupersededForPr` → combined `startCycle`; `updateCheckRun` → `attachCheckRun(cycleId, checkRunId): Promise<ReviewCycleStatus>`; unconditional `updateStatus` → two guarded transition methods sharing one private implementation: `transitionRunnerStatus({ cycleId, attemptId, from, to })` (`attemptId: string`, **required** — ownership check always applies) and `transitionSlackStatus({ cycleId, from, to })` (no `attemptId` — Slack acts on the cycle, not an attempt). Two names instead of one optional param, so "runner calls must prove ownership" is enforced by the type system rather than by convention; `updateSlackMessage` → `attachSlackMessage(cycleId, channel, ts): Promise<ReviewCycleStatus>` (conditional write + status return, see step 3). The old methods leave the public interface entirely.
- Update all callers in `src/http.ts` to `await` store calls. Fastify handlers are already async-friendly.
- **Careful with truthiness checks**: `http.ts:256` and `http.ts:284` (inside the fire-and-forget `handleBlockAction` / `handleViewSubmission` Slack handlers) do `if (!store.recordProcessedInteraction(...)) return;`. Unawaited, this is a `Promise<boolean>` — always truthy — so duplicate-interaction protection would silently stop working. These must become `if (!(await store.recordProcessedInteraction(...))) return;`. The outer `void handler().catch(...)` pattern at `http.ts:225/238` is fine as-is. Safety net: the service has **no ESLint setup**, so don't count on `no-floating-promises` — the verification step (step 9) relies on typecheck plus a grep/manual review of every `store.` call site for missing `await`. (Adding ESLint with that one rule is a worthwhile follow-up, but out of scope here.)

## Step 3 — Write `PostgresCycleStore` (Kysely + `pg`)

New file `src/storage/postgres.ts` implementing the async `CycleStore` with `new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool(...) }) })`.

- **Table types**: define a `DB` interface (`review_cycles`, `processed_interactions`) in e.g. `src/storage/schema.ts` — column types mirror the schema (`string` for text/timestamps/JSON). Nullable columns must include `undefined` in their insert type or Kysely's `Insertable` makes them required: `check_run_id: ColumnType<string | null, number | string | null | undefined, number | string | null>` (int8 selects come back as strings from `pg`, writes accept numbers); `slack_channel_id` / `slack_message_ts`: `ColumnType<string | null, string | null | undefined, string | null>`. Hand-written, no codegen needed for two tables.
- **Schema via Kysely migrations**: the schema will evolve, so use Kysely's `Migrator` from day one instead of ad-hoc startup DDL. Create `src/storage/migrations/0001_initial.ts` with `up()` building both tables via `db.schema.createTable(...)` (no `ifNotExists` — the Migrator's `kysely_migration` bookkeeping table handles idempotency). Types: `text`/`integer` as in SQLite, except `check_run_id bigint` (GitHub check run IDs can exceed int4 — Postgres `integer` is 32-bit, SQLite's is 64-bit, so int4 would NOT be a faithful port). Same PKs, `cycle_key` unique, plus a new `attempt_id text not null` column on `review_cycles` (ownership token, see concurrency below — it goes straight into `0001_initial`, no separate migration needed). Run `migrator.migrateToLatest()` in an async `init()` called from `index.ts`; fail startup on migration error. Use a static import map for migrations (not `FileMigrationProvider`) so it works under `tsx` and any future bundling.
- **Queries**: rewrite the ~9 raw statements as typed builders (`db.selectFrom("review_cycles").selectAll().where("id", "=", id).executeTakeFirst()` etc.). No placeholder conversion — Kysely handles `$n` binding.
- **Concurrency — new `startCycle` method**: with synchronous SQLite, `upsertCycle` + `markSupersededForPr` (called back-to-back in `http.ts:117-119`) couldn't interleave; with async `pg`, two concurrent `/api/runs/start` requests for different heads of the same PR can each insert a cycle and each supersede the other. Fix: replace the two calls with one store method running insert + supersession in a single `db.transaction().execute(async (trx) => { ... })`.
  - **Signature**: `startCycle(input): Promise<{ cycle: CycleRecord; superseded: CycleRecord[]; created: boolean; attemptId: string | null }>` — the `/api/runs/start` handler needs the active cycle and the superseded list for GitHub/Slack finalization; `created` says whether this call inserted the row (vs. hit the `cycle_key` conflict). `attemptId` (uuid, stored in `attempt_id`) is minted only on insert — duplicates get `null` at the store level. `null` never reaches the wire: the handler **omits** `attemptId` from duplicate responses (`RunStartResponseSchema` declares it `.optional()`, not nullable).
  - **Locking**: build the key in TS (`const lockKey = \`${owner}/${repo}#${prNumber}\``) and take the lock as the transaction's first statement with a bound param: `sql\`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))\`` — bound value, not string-concatenated SQL, and `hashtextextended` gives a 64-bit key (plain `hashtext` truncates to 32 bits).
  - **Ordering inside the transaction — insert first, supersede only on create**: take the advisory lock, attempt the insert with `.onConflict((oc) => oc.column("cycle_key").doNothing())`; if the insert hit the conflict (`created === false`), **return the duplicate immediately and run no supersession**. Supersession (`update ... where head_sha != $head and status in (...)`) runs only for newly created cycles. Otherwise a late duplicate start for old head A would supersede the currently active head B — a stale start must never displace the active cycle.
  - **Retire the split API**: once the HTTP caller uses `startCycle`, drop `upsertCycle` and `markSupersededForPr` from the public `CycleStore` interface (keep them as private helpers inside the store if useful). Leaving them public invites future callers to reintroduce the race. `BEGIN IMMEDIATE` disappears with them — Kysely transactions handle commit/rollback.
- **Concurrency — same-head duplicates exit at start**: when `created === false`, the `/api/runs/start` handler returns `200 { duplicate: true, cycleId, cycleKey }` and the action treats `duplicate: true` as a clean successful exit (small change in `packages/action/src/index.ts`: check the flag after `startCycle`, log, return). This kills the whole class of duplicate-runner downstream races in one move — no duplicate check runs, no duplicate `/video` uploads or Slack posts, and a duplicate that fails locally can't call `/failed` against the shared cycle (it exited long before, and holds no `attemptId` anyway). Schema: add optional `duplicate` and `attemptId` to `RunStartResponseSchema` in `packages/core`; keep `checkRunId` `.optional()` and omit it in duplicate responses (it's not `.nullable()` — `packages/core/src/index.ts:61`). **Exception — takeover from `failed`**: if the existing cycle's status is `failed`, do not return `duplicate: true`; instead, inside the same locked transaction, mint a fresh `attempt_id`, reset status to `analyzing`, and proceed as the new owner. Safe because `failed` is terminal — there is provably no live owner to race (the old runner's last act was posting `/failed`; any zombie twitch after is fenced by its stale token). Known accepted edge (deferred): re-running a `failed` *old* head while a newer head is live revives a stale cycle alongside the active one — duplicate validation noise, not corruption; see Deferred for the sibling guard. The handler must **reuse the existing `check_run_id`** (update it back to in-progress) rather than create a second check run — `startCycle` returns the cycle, so branch on `cycle.checkRunId` present. Without this carve-out, re-running after a clean failure would exit green while the check run stays red, with no way to retry short of pushing a new commit. Takeover from any *other* status (notably stale `analyzing` after a dirty runner death) remains deferred (see Deferred section). Accepted v0 consequence: a re-run of a same-head cycle in any non-`failed` state is a clean no-op; recovery from dirty death is pushing a new commit.
- **Concurrency — one check-run creator**: only the `created === true` caller calls `github.createCheckRun`, then attaches via `attachCheckRun(cycleId, checkRunId): Promise<ReviewCycleStatus>` (atomic set-and-return-status). One reconciliation case in v0: if it returns `superseded` — a newer head superseded us between our transaction and our attach, and its neutralize loop found `check_run_id = null` — the handler immediately neutralizes the check run it just created so it can't sit in-progress forever. No wider reconciliation matrix: with duplicates exiting at start, the winner's own runner is strictly sequential, so no other status can precede its attach.
- **Concurrency — result endpoints (`/accepted`, `/failed`, `/video`) need guarded transitions**: today each does `getCycle` then updates GitHub/status/Slack unconditionally (`http.ts:151-161`, `168-179`, `189-206`), so a stale runner for superseded head A can post results, resurrect status, or overwrite `slack_message_ts` after head B took over. Fix with the guarded transition methods (`transitionRunnerStatus` / `transitionSlackStatus`, step 2): an atomic `UPDATE ... SET status = $to WHERE id = $id AND status = ANY($from) [AND attempt_id = $attemptId] RETURNING *`, returning `null` when the cycle isn't in an allowed source state (or, for runner calls, the attempt doesn't own it).
  - Handlers do the **transition first, side effects after** (inverting today's GitHub-then-DB order), all via `transitionRunnerStatus` with the request's `attemptId`: `/video`: from `["analyzing"]` → `pending_validation`; `/accepted`: from `["analyzing"]` → `accepted` — **not** from `pending_validation`, or a duplicate runner that classified "not frontend-visible" could auto-accept a cycle already awaiting Slack validation; Slack approval is the only `pending_validation → accepted` path. `/failed`: from `["analyzing", "pending_validation"]` → `failed`. On `null`, respond **`200 { ok: false, stale: true }`** and skip all GitHub/Slack effects. Not 409: the action treats any non-2xx as an exception (`packages/action/src/backend.ts:24`) and its catch block then calls `/failed` and fails the workflow (`packages/action/src/index.ts:101-104`) — a 409 would turn a harmless lost race into a red CI run. Losing a race is a normal outcome for a correct client, so it's a 200; contrast with missing `attemptId`, which is a client bug and gets a 400.
  - This also gives **first-writer-wins idempotency**: a second `/video` for the same cycle finds status already `pending_validation`, gets `null`, and never re-uploads the video, re-posts Slack validation, or overwrites `slack_message_ts`.
  - **`attachSlackMessage` closes the `/video`-vs-supersession window**: after `/video` transitions to `pending_validation`, a newer head B can supersede cycle A *before* A posts to Slack — B's finalize loop finds no `slack_message_ts` and can't touch a message that doesn't exist yet, then A posts the validation message onto a dead cycle, stranding it in Slack. Fix: replace plain `updateSlackMessage` with `attachSlackMessage(cycleId, channel, ts): Promise<ReviewCycleStatus>` — atomically writes channel/ts **only if status is still `pending_validation`** and returns the current status; if it returns `superseded`, the handler immediately `slack.finalize(...)`s the message it just posted. Gotcha: `SlackClient.finalize` no-ops unless the record carries the message coordinates (`slack.ts:169` returns early on missing `slackChannelId`/`slackMessageTs`), and the in-memory `cycle` predates the post — pass an enriched record: `slack.finalize({ ...cycle, slackChannelId: channel, slackMessageTs: ts }, "superseded", ...)`. Mirror of the `attachCheckRun` pattern.
  - **Attempt ownership — required on runner result endpoints**: `startCycle` mints an `attemptId` (uuid) on insert (and on `failed`-takeover), stored in the `attempt_id` column and returned from `/api/runs/start`. The action sends it on `/accepted`, `/failed`, `/video` (body field; header `x-feature-rec-attempt` for the octet-stream `/video`), and `transitionRunnerStatus` enforces `AND attempt_id = $attemptId`. Two failure modes, deliberately distinct: **missing/malformed `attemptId` → `400`** (a client bug — fail loud); **wrong/stale `attemptId` → `200 { stale: true }`** (a correct client that lost ownership — fail quiet). Slack interactivity uses `transitionSlackStatus` — no `attemptId`, by design.
  - *No old-action compatibility path*: nothing is deployed and no consumer pins an action version, so there is no "old client" to support — a permissive missing-`attemptId` fallback would be an untestable branch that weakens the invariant. If the action is later published and version skew becomes real, a status-only fallback can be added back additively. This change touches `packages/core` (schemas: optional `duplicate` + `attemptId` on `RunStartResponse`) and `packages/action` (`backend.ts` plumbing + duplicate-exit) — small, but it widens the PR beyond the service.
  - **Slack interactivity handlers follow the same transition-first rule**: `handleBlockAction` / `handleViewSubmission` call `transitionSlackStatus(id, ["pending_validation"], "accepted" | "rejected")` **before** any GitHub comment / check-run update / Slack finalize, and stop on `null`. `recordProcessedInteraction` alone isn't enough — two different users' clicks have distinct interaction IDs, so both pass the dedupe; without transition-first, both could post GitHub comments before one loses the DB write. Attempt tokens don't apply here (Slack, not the runner): status guard only.
  - **Failure semantics of transition-first**: if the DB transition succeeds but the GitHub/Slack call after it fails, DB and check run diverge — e.g. `/accepted` transitions to `accepted`, then `github.updateCheckRun` throws; the action's `/failed` recovery hits the guard (`accepted` isn't an allowed source) and no-ops. Don't widen the from-set to compensate (`accepted → failed` would let stale runners flip settled cycles). Instead: wrap the post-transition GitHub call in a small bounded retry, treat the DB as source of truth, and accept the residual as documented — the failure mode is a check run stuck in-progress on a cycle the DB already settled, visible in CI and rare (requires a GitHub API failure at exactly that point). **Note the retry's limit**: it only covers calls that fail *and return*. A process crash (OOM, eviction, deploy) after the DB commit but before the side effect loses the intent entirely — no instance knows work was pending, nothing retries. Examples: `accepted` committed but check run never concluded; `pending_validation` committed but Slack message never posted. Accepted v0 residual, same family as dirty runner death; the outbox pattern (Deferred) is the real fix for both.
- **Duplicate detection** in `recordProcessedInteraction`: the string match `UNIQUE constraint failed: processed_interactions.id` will never match on Postgres. Replace with insert + `.onConflict((oc) => oc.column("id").doNothing())` and check `numInsertedOrUpdatedRows === 0n` (it's a bigint) — no error-catching needed.
- **Row mapping**: keep `rowToCycle` logic (`JSON.parse` + Zod) but rows are now typed via the `DB` interface, so most `String(...)` coercions can go. `pg` returns `integer` columns as JS numbers (`pr_number` fine); `bigint` (int8) comes back as a **string** — per the `ColumnType` above, map with `row.check_run_id === null ? null : Number(row.check_run_id)`. Safe: GitHub IDs stay far below `Number.MAX_SAFE_INTEGER` (2^53). The `CycleStore` interface keeps exposing `number | null`, so callers are untouched.

## Step 4 — Config

- `src/env.ts`: replace `dbPath` / `FEATURE_REC_DB_PATH` with `databaseUrl` from `DATABASE_URL` (fail fast if unset).
- `.env.example`: swap `FEATURE_REC_DB_PATH=./data/feature-rec.sqlite` for `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres` (matches the docker one-liner in step 7; note the DB must exist — migrations create tables, not databases).
- `.gitignore`: `packages/service/data/` entry can be removed.

## Step 5 — Wire-up

- `src/index.ts`: drop `--experimental-sqlite` from the shebang; instantiate `PostgresCycleStore(env.databaseUrl)`, `await store.init()`, and call `await store.close()` (`db.destroy()`, which ends the pool) on shutdown.

## Step 6 — Delete SQLite code

- Remove `src/storage/sqlite.ts` and `src/node-sqlite.d.ts`.

## Step 7 — Tests

- `scripts/selftest.mts`: read an admin URL from `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`), connect to it, `CREATE DATABASE feature_rec_test_<random>`, run the suite against that DB, then drop it. Cleanup details: generate the name from a safe-identifier alphabet only (`[a-z0-9_]`, e.g. hex of `randomBytes` — `CREATE/DROP DATABASE` can't take bound params); in the `finally`, close the app + store/pool **before** `DROP DATABASE`, and use `DROP DATABASE ... WITH (FORCE)` as a belt-and-braces so a failed test with lingering connections can't strand the DB. Convert assertions to async.
- Add concurrency tests at two levels:
  - *Store level*: two `startCycle` calls, same PR, different `head_sha`, via `Promise.all` → exactly one active cycle.
  - *HTTP level* (with stubbed `github`/`slack`): (a) **newer-head supersession**: two concurrent `/api/runs/start` for different heads → one active cycle, the losing cycle's check run ends neutralized, never left in-progress (exercises the `attachCheckRun` superseded re-check); (b) **same-head duplicate start**: two concurrent starts with the same `cycleKey` → exactly one gets `created`, the other gets `duplicate: true`, and `github.createCheckRun` is called exactly once; (c) **stale runner no-op**: head B starts, then old head A posts `/accepted`, `/failed`, and `/video` → each returns `200 { stale: true }`, A's status stays `superseded`, no Slack post and no `slack_message_ts` overwrite; (d) **attempt ownership**: a result posted with a wrong/stale (well-formed) `attemptId` → `200 { stale: true }`, winning cycle stays `analyzing`, not `failed`; a result with **missing or malformed** `attemptId` → `400`, nothing written; (e) runner `/accepted` on a `pending_validation` cycle → `{ stale: true }`, status unchanged (Slack remains the only acceptance path from validation); (f) **stale duplicate start can't displace**: head B active, late duplicate start arrives for old head A (A's `cycle_key` already exists) → response is `duplicate: true` and B stays active, unsuperseded; (g) **double Slack click**: two concurrent block actions with distinct interaction IDs on the same cycle → exactly one GitHub comment/finalize, the loser stops at the transition; (h) **supersession between `/video` transition and Slack post**: cycle A reaches `pending_validation`, head B supersedes before A's Slack post lands → A's just-posted message gets finalized as superseded (via `attachSlackMessage` returning `superseded`), no live validation message left pointing at a dead cycle; (i) **takeover from `failed`**: cycle fails cleanly, then a same-head re-run starts → not `duplicate: true` but a fresh `attemptId`, status back to `analyzing`, the **same** `check_run_id` reused (no second check run created), and a late result posted with the old attempt's token → `{ stale: true }`.
- Line ~246 asserts that a write after `close()` throws synchronously — with a pg pool, assert on the rejected promise instead (`assert.rejects`).
- For local runs, document the matching one-liner: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17` (no compose file exists in-repo; add one only if wanted).

## Step 8 — Docs

- Update `docs/technical-architecture.md` and `docs/architecture-hosting-strategy.corrected.md`: both currently describe the SQLite store as a pre-production placeholder and reference `FEATURE_REC_DB_PATH`. Point them at `DATABASE_URL` and the new store.

## Step 9 — Verify

- `pnpm --filter @feature-rec/service run selftest` against a local Postgres.
- Run the full `feature-rec:selftest` aggregate (core + service + action).
- Grep for leftovers: `sqlite`, `FEATURE_REC_DB_PATH`, `experimental-sqlite` should return no source hits.
- Typecheck, then review every `store.` call site for missing `await` (grep `store\.` in `src/`) — TS won't flag `if (!promise)` truthiness bugs and there's no ESLint in the repo.

## Deferred (post-v0)

The v0 invariant is: **a stale or duplicate runner must never move a cycle backward or overwrite the active cycle.** Everything below is explicitly out of scope until it's needed:

- Same-head takeover from **non-terminal** states — i.e. recovering a dirty runner death, where the cycle is stuck in `analyzing` and is indistinguishable from a slow healthy run. Likely design: allow takeover only when `updated_at` is older than the max plausible run time (staleness gate), so ordinary seconds-apart duplicates still exit. (Takeover from `failed` is IN scope for v0 — see step 3.) v0 recovery for dirty death: push a new commit.
- **Sibling guard on `failed`-takeover**: v0 allows re-running a `failed` old head even while a newer head is live, reviving a stale cycle alongside the active one (supersession never marks terminal cycles, and takeover must not supersede the newer head). Consequence is duplicate validation noise — two live cycles, two Slack messages — not state corruption; the active head is untouched. Fix when it matters: takeover additionally requires no non-terminal sibling cycle for the PR (one `SELECT` inside the locked transaction; with a live sibling, return `duplicate: true`), plus a test: takeover denied while a sibling is `analyzing`/`pending_validation`.
- Full `attachCheckRun` reconciliation matrix beyond `superseded` (accepted/failed/rejected/pending outputs at attach time) — not reachable in v0 (duplicates exit at start and there are no old clients); revisit only if a compatibility fallback is ever added.
- Perfect recovery from GitHub/Slack failures after a DB transition (outbox pattern, rich retry orchestration; v0 has bounded retry + DB-as-source-of-truth). Includes the crash-after-commit case: a process death between DB commit and side effect loses the intent with no retry — only an outbox written in the same transaction closes it.
- Waiting/polling duplicate runners instead of exiting.
- A proper job/attempt table (v0: single `attempt_id` column).
- Old-action compatibility fallback (status-only guarding for requests without `attemptId`) — only needed if/when the action is published and consumers can pin versions, creating real service/action skew. v0 has no deployed clients, so result endpoints require `attemptId` outright.

## Appendix — end-to-end request flow

Sequence of calls, DB transitions, and responses across the runner (GitHub Action), backend, Postgres, GitHub, and Slack under the target design (guarded transitions, attempt ownership, attach-and-recheck repair).

```mermaid
sequenceDiagram
    autonumber
    participant R as Runner (GHA)
    participant B as Backend
    participant DB as Postgres
    participant GH as GitHub API
    participant S as Slack
    participant H as Reviewer

    Note over R,DB: Phase 1 — start
    R->>B: POST /api/runs/start
    B->>DB: startCycle txn: advisory lock (PR key), insert ON CONFLICT
    alt duplicate (existing status not failed)
        DB-->>B: created = false
        B-->>R: 200 duplicate true
        Note over R: log + exit 0 (green) — this runner's flow ENDS here
    else fresh cycle created
        DB-->>B: cycle (analyzing), attemptId minted, superseded[]
        Note right of DB: supersession of other heads runs inside this txn
        loop each superseded old cycle
            B->>GH: neutralize its check run (if attached)
            B->>S: finalize its validation message (if posted)
        end
        B->>GH: createCheckRun (in_progress)
        B->>DB: attachCheckRun(id) — atomic set + return status
        opt returned status = superseded
            B->>GH: neutralize own just-created run
        end
        B-->>R: 200 cycleId + attemptId + checkRunId
    else failed takeover
        DB-->>B: fresh attemptId, status reset to analyzing, check_run_id kept
        B->>GH: update existing check run back to in_progress
        B-->>R: 200 cycleId + attemptId + checkRunId
    end

    Note over R: Phase 2 — local work (no supersession checks here)
    R->>R: classify diff, render video

    alt not frontend-visible
        R->>B: POST /accepted (attemptId)
        B->>DB: transitionRunnerStatus analyzing→accepted (status + attempt guard)
        alt guard fails (superseded / wrong token)
            B-->>R: 200 stale true — no side effects
        else transition won
            B->>GH: conclude check run success (withRetry)
            B-->>R: 200 ok
        end
    else frontend-visible
        R->>B: POST /video (x-feature-rec-attempt header)
        B->>DB: transitionRunnerStatus analyzing→pending_validation
        alt guard fails (superseded / wrong token)
            B-->>R: 200 stale true — no side effects
        else transition won
            B->>GH: check run output = "pending validation" (withRetry)
            B->>S: upload video + post validation message
            B->>DB: attachSlackMessage(channel, ts) — write iff still pending_validation
            opt returned status = superseded
                B->>S: finalize own just-posted message
            end
            B-->>R: 200 ok + channel + ts
            Note over R: workflow ends green here
        end
    end

    opt runner error at any local step (catch block)
        R->>B: POST /failed (attemptId)
        B->>DB: transitionRunnerStatus analyzing|pending_validation→failed
        alt guard fails (superseded / wrong token)
            B-->>R: 200 stale true — no side effects
        else transition won
            B->>GH: conclude check run failure (withRetry)
            B-->>R: 200 ok
        end
    end

    Note over H,GH: Phase 3 — human decision (minutes/hours later)
    alt approve — one interaction
        H->>S: click Approve
        S->>B: POST /api/slack/interactivity (block_actions)
        B->>B: verify Slack signature (401 if invalid)
        B-->>S: 200 ack immediately (work continues async)
        B->>B: check clicker is an approver (stop + log if not)
        B->>DB: recordProcessedInteraction — insert ON CONFLICT dedupe
        B->>DB: transitionSlackStatus pending_validation→accepted
    else reject — two interactions
        H->>S: click Needs changes
        S->>B: POST /api/slack/interactivity (block_actions)
        B->>B: verify signature + ack + approver check
        B->>S: open "request changes" modal (trigger_id)
        H->>S: submit modal (comment required)
        S->>B: POST /api/slack/interactivity (view_submission)
        B->>B: verify Slack signature (401 if invalid)
        B-->>S: 200 ack (or inline validation error if comment empty)
        B->>B: check submitter is an approver (stop + log if not)
        B->>DB: recordProcessedInteraction — insert ON CONFLICT dedupe
        B->>DB: transitionSlackStatus pending_validation→rejected
    end
    alt guard fails (superseded / already decided)
        Note over B: stop — no comment, no check update
    else transition won
        B->>GH: post PR comment → returns comment URL
        B->>GH: conclude check run (success / action_required), summary links comment
        B->>S: finalize validation message ("accepted" / "rejected")
    end
```

Reading notes: the DB write always precedes its side effects — a lost guard returns `200 { stale: true }` (or exits on `duplicate: true`) with zero external effects. The two attach calls are set-and-recheck pivots: each atomically publishes an external artifact's coordinates and returns the current status, so a creator that got superseded mid-window repairs its own artifact. The check run is created at start, before rendering, so the PR shows an in-progress check during the slowest phase. In phase 3 the PR comment precedes the check-run conclusion because the conclusion's summary embeds the comment URL; the Slack ack returns before decision processing (Slack requires a fast response), so phase 3's work is fire-and-forget with error logging.

## Risk notes

- The sync→async interface change (step 2) ripples beyond the storage layer — do it first and let the compiler surface all call sites. TypeScript will NOT catch the `if (!promiseReturningCall())` truthiness bugs (step 2) — those need manual review or `no-floating-promises` linting.
- Concurrency semantics change: SQLite's sync API + `BEGIN IMMEDIATE` gave implicit whole-DB write serialization. Postgres gives none by default — the advisory lock in `startCycle` (step 3) is what restores per-PR serialization. Any future multi-statement store method needs the same treatment.
- Schema evolution is handled by Kysely `Migrator` from the start (step 3); future schema changes are new numbered migration files, applied automatically at startup. Migrations create tables, not databases — provisioning the database itself stays an ops step.
