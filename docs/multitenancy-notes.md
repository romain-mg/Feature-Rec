# Multitenancy Notes

## Current contract after deploy C

The singleton designs below are historical and are superseded by the
[OIDC and multitenancy plan](plans/feature-rec-oidc-multitenancy-plan.md).
Tenants are UUID product boundaries, each with one GitHub account/installation and one Slack workspace.
All runner calls verify GitHub OIDC, resolve the enabled tenant, and mint a live repository-scoped
installation token. Cycles, locks, supersession, and guarded transitions use tenant/repository IDs.
Repository names are transient GitHub coordinates only: deploy C stopped every legacy read/write, so
new cycles carry no `owner`/`repo` values and nothing touches `team_channel_routes`. The physical
legacy columns and table remain, inert, until the deploy-D contract drops them.

Every Slack Web API operation uses the token decrypted from the selected workspace row. Signed
workspace IDs have no global fallback, and approval payloads must match the cycle tenant's workspace.
The persisted bot user ID is refreshed by provisioning `auth.test`; normal membership events compare
it before decrypting or calling Slack. `slack_workspaces.selected_channel_id` owns routing. Lifecycle
deletion explicitly removes team settings and disables the tenant; since `0009_multitenant_enforce`,
the `channel_settings_team_id_fkey` `ON DELETE CASCADE` also backstops that cleanup at the database.

The A/B/C/D release boundaries remain separate: expand, cut over, enforce/stop legacy writes, then
contract. Deploy C registers `0009_multitenant_enforce` (`NOT NULL` review-cycle identity plus the
cascade FK). Later schema rollback must run the newer artifact's targeted down migration before
starting the older artifact: C-to-B migrates down to `0008` with C's admin artifact. B-to-A was
limited to a validated singleton; once deploy C has written cycles, recovering to A means restoring
the pre-cutover backup. See the [cutover and rollback runbook](setup-and-operations.md#oidc-cutover-checklist).

## Historical singleton notes

Single-workspace assumptions currently baked into the service, recorded so the
multitenant redesign revisits them deliberately.

Note: v0 stores no org-level identity anywhere — the workspace (`team_id`) is
the only tenant key. That is safe to defer because org identity is always
derivable — in the single-token era every row belongs to the token's workspace
(`auth.test` reports its owner), and at multitenancy time the org↔workspace
pairing table knows each workspace's owner — so introducing it later is one
nullable-column migration plus a one-line backfill. Both concern how the backend
decides "which workspace am I talking to" — today there is exactly one answer,
so simple designs are correct; multi-workspace makes the same designs hazards.

## Tenant resolution: payload team id, with a single-tenant fallback

Interaction handlers prefer the team id carried by the Slack payload and fall
back to the bot token's own workspace (`auth.test`) when absent:

```typescript
const teamId = payload.team?.id ?? (await slack.botIdentity()).teamId;
```

The fallback is only correct while this backend serves a single workspace —
one env token, one tenant, so "whoever owns the token" is always the right
answer. In a multi-workspace deployment it becomes a wrong-tenant hazard: a
payload missing team context would silently resolve to whichever workspace the
global token belongs to, routing state into another tenant.

Multitenant version: never fall back to a global bot identity. Resolve the
tenant from the request's installation context (payload `team_id` → pairing
table) and use that tenant's token via `tokenForTeam()`; treat missing team
context as an error, not a default.

In practice the fallback should be nearly dead code — block actions, view
submissions, slash commands, and event callbacks all carry a team id. If it
ever fires, that is a payload shape worth understanding before multitenancy
makes it dangerous.

## Bot identity: cached `auth.test`, not a DB copy

Why `auth.test` instead of storing identity in the DB: Slack is the source of
truth for which installation the token belongs to. `auth.test` derives the bot
user id and team id directly from `SLACK_BOT_TOKEN`, so
identity can never drift from the configured token — a DB copy would need
setup and synchronization logic to avoid stale or mismatched token/identity
records.

This is not a per-call query. The promise is cached:

```typescript
this.#identity ??= slackApi(...);
```

so each `SlackClient` instance normally calls `auth.test` once, and concurrent
callers share the same in-flight promise. On failure the cache is cleared
(`this.#identity = null`), letting a later call retry instead of pinning a
rejected promise forever.

Trade-offs:

- Current approach: simple, always consistent with `SLACK_BOT_TOKEN`; costs
  one Slack request per service instance/restart.
- DB approach: avoids that startup request and supports multiple
  installations, but requires storing token↔team mappings and keeping them
  correct.

For multi-workspace support the DB approach becomes necessary: store each
installation's bot token and select it by `teamId` (`tokenForTeam()`). For one
global token, cached `auth.test` is the right design — simpler and less
error-prone, though not universally "better."

## OIDC and multitenancy rollout review (2026-09-03)

Proposed high-level order: additive schema, multitenant business logic, OIDC
business logic, then legacy-schema deletion. The direction is correct, with
these required safety constraints:

- Multitenant GitHub routing must not become active while runner requests are
  authorized only by the shared bearer token. A caller holding that token can
  supply another repository's names. The OIDC-verified `repository_id` and
  `repository_owner_id` must select the GitHub installation and tenant; a
  request-supplied `tenant_id` must never do so.
- Multitenancy and OIDC may be developed sequentially in one PR, but their
  GitHub-facing cutover is one security boundary. Verify OIDC, resolve the
  installation/tenant, check `tenants.enabled`, and prove repository access by
  minting a repository-scoped installation token before creating a cycle.
- Bind every runner endpoint, not only `/api/runs/start`, to the authenticated
  cycle tenant and repository. The action should request a fresh OIDC token for
  calls made after long rendering work rather than assume the start token is
  still valid.
- Add `review_cycles.tenant_id` and `repository_id` as nullable first. Backfill
  and validate them before changing application reads or adding `NOT NULL`.
  Decide explicitly how unresolvable historical repositories are archived or
  removed; they must not silently block the constraint migration.
- Backfill the singleton tenant, Slack workspace/token/channel, GitHub
  installation/account, repository IDs, and cycle keys before enabling strict
  multitenant reads. Token encryption belongs in application code or a one-off
  script, not in SQL.
- Prevent drift during the interval between channel-route backfill and cutover:
  either briefly stop writes or dual-write `selected_channel_id` and perform a
  final reconciliation before dropping `team_channel_routes`.
- Switch cycle-key construction, the unique lookup, advisory-lock scope, and
  supersession queries together to `tenant_id + repository_id`. Mixed old/new
  service instances would use different locks and can create competing active
  cycles, so use a non-rolling/maintenance cutover or a compatible transition
  protocol.
- Do not ship the destructive migration in the same automatically applied
  migration wave as the additive migration. `PostgresCycleStore.init()` calls
  `migrateToLatest()`, so every migration present in one deployed artifact is
  applied before that process serves traffic, potentially while old instances
  still read the removed columns/table. Use a later contract deployment (a
  second PR is simplest), unless accepting downtime and loss of rollback.
- Remove `FEATURE_REC_RUNNER_TOKEN`, the shared Slack token, `owner`/`repo`,
  `config_hash`, `config_json`, and `team_channel_routes` only after production
  traffic proves there are no remaining readers/writers and a final backfill
  validation passes.

Safe deployment order:

1. Add nullable/new schema and compatibility code.
2. Backfill and validate all tenant/integration/repository data.
3. Add multitenant plumbing without exposing GitHub routing under legacy auth.
4. Add OIDC plus installation authorization and cut the action/backend over as
   one release; switch cycle identity, locks, and supersession atomically.
5. Observe and reconcile; enforce the new non-null invariants. (Landed as
   deploy C / `0009_multitenant_enforce`.)
6. In a later contract deployment, remove legacy columns, tables, and secrets.
   (Deploy D, pending.)
