# Feature-Rec OIDC and Multitenancy Dev Plan

Status: PR A expand/prepare and PR B runtime implementation complete; production cutover and PR C/D migrations pending

Date: 2026-09-03

Last reviewed: 2026-09-04

PR B implemented: 2026-09-05. The action and service use OIDC and tenant/repository
identity, with workspace-bound Slack clients and compatibility writes retained.
No migration after `0008_multitenant_expand` is registered. Local verification
passed typecheck, lint, the full selftest suite, the production image build, and
compiled-admin/health smoke tests against isolated PostgreSQL. Production
backfill/cutover and the real two-tenant smoke remain operator release steps.

Scope: `packages/core`, `packages/action`, `packages/service`, migrations,
operator tooling, CI, and product documentation

## Goal

Before the first external beta testers, one hosted Feature-Rec deployment must
serve multiple customers without shared runner or Slack credentials and without
allowing one customer to address another customer's cycles, GitHub installation,
Slack workspace, channels, or settings.

The end-to-end identity chain is:

```text
GitHub OIDC JWT
-> verified repository_owner_id
-> github_installations.github_account_id
-> tenant_id
-> tenant's unique Slack workspace

verified repository_id + tenant_id
-> review-cycle identity
-> tenant's GitHub installation
-> repository-scoped installation token
-> current GitHub full_name for API coordinates
```

This plan uses expand/backfill/cutover/stop-legacy/contract. Because merging a PR
autodeploys its artifact, each of the four deployment waves is a separate PR.
Destructive migrations must be released only after the previously serving image
has stopped reading and writing the legacy schema. The service automatically
runs every registered migration before it becomes healthy.

## Source decisions

This plan implements the accepted brain decisions:

- **Feature-Rec beta tenant integration schema**
- **Feature-Rec repository identity and tenant routing**
- **Feature-Rec OIDC v0 keeps a GHES-compatible seam**
- **North Star** for staged beta onboarding, updated by the later invite-only
  onboarding decision

## Locked decisions

- A tenant is the product/customer boundary.
- For beta, a tenant has at most one Slack workspace and at most one GitHub
account/installation. Database uniqueness enforces both limits.
- GitHub accounts include both organizations and user accounts. There is no
`account_type` column because the product treats them identically.
- `github_account_id` is unique across tenants in this single-issuer deployment.
- GitHub Actions OIDC replaces `FEATURE_REC_RUNNER_TOKEN`.
- The configured issuer defaults to
`https://token.actions.githubusercontent.com`; it is not persisted.
- JWKS key IDs are transient verification inputs and are not persisted.
- `tenant_id + repository_id` is the repository identity used by cycles.
- Cycle keys use `tenant_id + repository_id + pr_number + head_sha`.
- Advisory locks and supersession use
`tenant_id + repository_id + pr_number`.
- Repository names are transient GitHub API coordinates, not durable identity.
- GitHub repository access is proven by minting an installation token scoped to
the verified repository ID for each logical operation, without a token cache.
- GitHub-to-Slack routing follows the tenant's unique workspace. Do not store
`slack_workspace_id` on GitHub installations or review cycles.
- `selected_channel_id` belongs to `slack_workspaces`.
- Slack installation rows represent current installations. Verified uninstall
or bot-token revocation deletes the row instead of setting lifecycle timestamps.
- No generic integration `status`, `provider_key`, `revoked_at`, or
`uninstalled_at` columns are introduced.
- This implementation uses operator-assisted onboarding. Before beta launch, a
  separate follow-up will add an invite-only onboarding page for Slack OAuth and
  GitHub App installation. Automated workflow PR creation remains deferred.

## Non-goals

- Multiple Slack workspaces or GitHub accounts per tenant.
- Many-to-many GitHub-to-Slack routing.
- A repositories table or repository synchronization subsystem.
- Persisting repository names merely to call GitHub APIs.
- Full GHES or multi-issuer support. A custom issuer remains a configuration
seam, not a support claim.
- Building the invite-only onboarding page in this implementation. It is a
  separate pre-beta requirement, not deferred beyond beta.
- Public self-serve onboarding, subscription, and billing UI.
- GitHub user OAuth or trusting a GitHub setup-URL `installation_id` directly.
- An outbox/reconciliation worker for already accepted side-effect failure
windows.
- Replacing the existing attempt-token and status-transition concurrency model.

## Current state and relevant seams

- `packages/service/src/http.ts` authenticates all runner endpoints with one
shared bearer token and accepts `owner/repo` from the request body.
- `packages/action/src/backend.ts` reads `FEATURE_REC_RUNNER_TOKEN` for every
backend request.
- `packages/service/src/github.ts` discovers an installation from `owner/repo`,
caches tokens by that mutable name, and uses the names in REST paths.
- `packages/service/src/slack.ts` owns one process-wide `SLACK_BOT_TOKEN` and one
cached bot identity.
- `packages/service/src/channels.ts` infers the workspace from that global bot
token instead of from a cycle's tenant.
- `review_cycles`, its cycle key, advisory lock, and supersession queries use
mutable repository names.
- `team_channel_routes` owns `selected_channel_id`.
- `channel_settings.team_id` has no foreign key to an installed workspace.
- `PostgresCycleStore.init()` calls `migrateToLatest()` before Fastify listens.
Railway keeps the old healthy deployment serving while the replacement starts,
so a destructive startup migration can break the still-serving old image.

## Target schema

The names below use lower snake case. PostgreSQL `bigint` values remain decimal
strings at TypeScript boundaries; code must not coerce installation, account, or
repository IDs through an unsafe JavaScript number.

```text
tenants
id       uuid primary key
enabled  boolean not null default false

slack_workspaces
  team_id               text primary key
  tenant_id             uuid not null references tenants(id)
  bot_user_id           text not null
  bot_token_ciphertext  text not null
  selected_channel_id   text null
  unique (tenant_id)

github_installations
installation_id   bigint primary key
tenant_id         uuid not null references tenants(id)
github_account_id bigint not null
unique (tenant_id)
unique (github_account_id)

review_cycles additions during expand
tenant_id      uuid null references tenants(id)
repository_id bigint null
owner          text null   -- relaxed only for the compatibility window
repo           text null   -- relaxed only for the compatibility window

review_cycles after contract
tenant_id      uuid not null references tenants(id)
repository_id bigint not null
-- owner, repo, config_hash, and config_json removed

channel_settings after contract
foreign key (team_id)
  references slack_workspaces(team_id)
  on delete cascade
```

Add an index supporting the supersession predicate:

```sql
create index review_cycles_tenant_repo_pr_idx
on review_cycles (tenant_id, repository_id, pr_number);
```

Keep `cycle_key` unique. Its canonical format becomes:

```text
<tenant UUID>/<repository ID>#<PR number>:<head SHA>
```

The precise delimiters are an internal format; tests must freeze them so the
action, service, backfill, duplicate detection, and GitHub check-run
`external_id` use one implementation.

## Secret handling

### Slack bot tokens

Add `FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY`, containing exactly 32 random bytes
encoded as base64. Fail startup when the key is missing or malformed in any
environment that contains Slack workspace rows. The first token-write transaction pins an independent
HMAC-SHA256 verifier in a singleton `slack_token_encryption_key` table (included in `0008`). Later
token writes and startup verify the supplied key against it. A wrong key or missing verifier blocks
startup, but with a verified key an individual token's decryption failure logs a prominent
tenant-scoped error and startup continues. Contract-readiness validation still reports those failures.
Back up the verifier with the database and retain the key separately; no automatic verifier reset
or key rotation is allowed.

Implement AES-256-GCM encryption in a small service module. Store a versioned
text envelope such as:

```text
v1:<base64 IV>:<base64 auth tag>:<base64 ciphertext>
```

Use `team_id` as additional authenticated data so swapping ciphertext between
workspace rows fails decryption. Never log plaintext tokens, ciphertexts, OAuth
JWTs, authorization headers, or encryption keys. Decrypt during the startup/readiness check without
retaining plaintext, or while constructing a team-bound Slack client for an operation.

Do not persist decrypted clients indefinitely. For beta, one DB lookup and
decrypt per logical Slack operation is preferable to token-rotation cache
invalidation complexity; reuse the bound client within that operation.

### OIDC configuration

In deploy B, require the public base URL explicitly at startup; keep the accepted
GitHub issuer default:

```text
FEATURE_REC_BASE_URL=https://<public-service-origin>             # required
GITHUB_OIDC_ISSUER=https://token.actions.githubusercontent.com   # optional default
```

Do not silently substitute a localhost base URL once OIDC is active. Parse and
canonicalize the explicit base URL at startup; reject credentials, query strings,
fragments, and non-HTTPS origins, except an explicit loopback HTTP URL in
tests/local development. Validate the configured/default issuer as an HTTPS URL.

The OIDC audience is the normalized `FEATURE_REC_BASE_URL`; the action derives
the same value from its `api-url` input. Put one canonical URL-normalization
function in `@feature-rec/core` and call it from both sides. Do not add a second
implementation or an audience override in beta. Production and staging therefore
have different audiences because they have different public base URLs. If a
future non-URL audience is needed, add the backend setting and matching action
input together.

The service obtains OIDC discovery and JWKS only from the configured issuer; it
must never select an issuer, discovery URL, or JWKS URL from unverified token
data.

Create and reuse one in-memory remote JWKS resolver. Key selection may use the
JWT's `kid`, and cache refresh handles key rotation. No JWKS key ID or token is
written to PostgreSQL.

### Secrets removed after cutover

- `FEATURE_REC_RUNNER_TOKEN`
- `SLACK_BOT_TOKEN`
- `FEATURE_REC_GITHUB_TOKEN` and the `GITHUB_TOKEN` fallback. Remove both from
  the service in deploy B; all service GitHub access must use a tenant's GitHub
  App installation. Local rendering does not need a service-side direct token.

Keep `SLACK_SIGNING_SECRET`, `GITHUB_APP_ID`, and `GITHUB_PRIVATE_KEY`; they are
app-level credentials shared across installations, not tenant credentials.

## Trust boundaries and request authorization

### OIDC verification boundary

Add `packages/service/src/oidc.ts` with a single verifier interface. It returns a
small verified identity object only after signature and claims validation:

```typescript
type RunnerIdentity = {
repositoryId: string;
repositoryOwnerId: string;
eventName: string;
};
```

Verification requirements:

1. Require a `Bearer` token.
2. Verify signature with the configured issuer's cached JWKS.
3. Require the exact configured `iss` and `aud`.
4. Allow only the expected signing algorithm.
5. Require and validate `exp` and `iat`, using a small clock tolerance.
6. Require decimal-string `repository_id` and `repository_owner_id`; preserve
 their exact string values.
7. Require `event_name = pull_request` for the beta workflow.
8. Do not parse `sub` for identity and do not authorize from unverified claims.

Return `401` for malformed, expired, wrong-signature, wrong-issuer, or
wrong-audience tokens. Treat discovery/JWKS availability failures as temporary
service failures rather than claiming that a valid caller is unauthenticated.

### Tenant and installation authorization

After OIDC verification:

1. Look up `github_installations.github_account_id` using the verified
 `repository_owner_id`.
2. Join its tenant and require `tenants.enabled = true`.
3. Mint fresh installation access scoped to the verified repository ID:

 ```http
 POST /app/installations/{installation_id}/access_tokens

 { "repository_ids": [<verified repository_id>] }
 ```

4. Require the token response's repository metadata to contain exactly the
 requested repository ID, and cross-check its owner ID against the verified
 owner ID.
5. Use the returned current `full_name` only as the coordinates for GitHub REST
 calls made during that operation.

The repository-ID conversion used in the JSON request must fail closed on
precision loss. Keep the canonical ID as a string; if the HTTP serializer needs
a JavaScript number, require a safe-integer and exact decimal round trip rather
than silently rounding it.

Return a generic `403` for valid identities that have no enabled tenant,
installation, or repository grant. Detailed internal logs may distinguish the
reason but must not reveal another tenant's metadata to the caller.

### Runner result endpoints

Every runner endpoint receives a freshly requested OIDC token. For
`/accepted`, `/failed`, and `/video`:

1. Verify OIDC.
2. Load the cycle.
3. Require its `tenant_id` and `repository_id` to equal the authenticated
 identity's resolved tenant and repository.
4. Keep requiring the existing random `attemptId`.
5. Include tenant, repository, attempt, and status predicates in the guarded
 transition so a check-then-update race cannot bypass the binding.

OIDC establishes repository identity; `attemptId` establishes ownership of the
currently active execution. Neither replaces the other.

## End-to-end flows

### Start a review cycle

Change the public start payload to stop accepting repository names as identity.
The minimal body should be:

```typescript
{
prNumber: number;
headSha: string;
}
```

The action still reads the event's base SHA locally for diff generation, but it
does not need to send it to the service.

`POST /api/runs/start` performs:

1. Verify OIDC and resolve the enabled tenant/GitHub installation.
2. Mint repository-scoped installation access and obtain current repository
 metadata.
3. Fetch the PR through that scoped token.
4. Require the PR to be open, non-draft, and have the requested `headSha`.
   Closed, converted-to-draft, and changed-head races all return the same
   successful no-op response with a machine-readable reason. These states are
   no longer actionable by the runner and must not turn the workflow red.
5. Derive `pr_title` and `pr_author` from GitHub instead of the request body.
6. Build the cycle key from tenant ID, repository ID, PR number, and confirmed
 head SHA.
7. Call `startCycle` with authenticated internal identity fields.
8. Preserve existing duplicate, failed-takeover, supersession, and attempt-token
 behavior.
9. Create or restore the GitHub check run using the already authorized current
 repository coordinates.
10. Resolve onboarding against the tenant's Slack workspace, not a global bot
  token.

During the rollback window, new code may continue filling legacy `owner` and
`repo` columns from the current `full_name`, but runtime identity and lookups
must never use those values.

### Accept, fail, or upload video from the runner

- The action requests a fresh OIDC JWT immediately before each backend call so
a long render does not reuse an expired start token.
- The backend verifies and binds the JWT to the cycle before mutating state.
- GitHub operations obtain repository-scoped installation access from the cycle's
tenant and repository.
- `/video` obtains the tenant's Slack workspace, decrypts that workspace's token,
and resolves only its channels/settings.
- Keep the current transition-first and stale-runner behavior.
- When the action catches a rendering/backend error, a failure-reporting error
must not overwrite the original exception; log the reporting failure and
rethrow the original cause.

### GitHub calls after Slack approval

Slack approval has no OIDC token. Its authority comes from a valid Slack
signature, the payload workspace, channel approver settings, and the cycle
binding:

1. Load the cycle from the signed action value.
2. Resolve the cycle tenant's Slack workspace.
3. Require the signed payload `team.id` to equal that workspace's `team_id`.
4. Resolve approver settings and authorize the Slack user.
5. Mint GitHub installation access scoped to the cycle's repository before the
 status transition.
6. Perform the existing atomic status transition.
7. Use the authorized current GitHub coordinates for the comment/check update.
8. Finalize the already-posted Slack message with the same team-bound client.

This prevents a correctly signed interaction from workspace A from acting on a
cycle belonging to workspace B, even if a cycle ID or block payload leaks.

### Slack events, commands, and interactivity

- Verify the shared Slack signing secret before trusting `team_id`.
- For normal events/commands/interactivity, resolve a workspace row and enabled
tenant from the signed `team_id`.
- Create a Slack client bound to that row's decrypted bot token.
- Remove every fallback to the process-wide bot identity.
- Unknown/deleted workspaces must not fall back to another token.
- For `member_joined_channel`, resolve the workspace from the signed envelope
  `team_id` and compare `event.user` with the row's stored `bot_user_id` before
  decrypting a token or calling Slack. Provisioning/reinstallation refreshes
  `bot_user_id` from `auth.test`; normal join events do not call `auth.test`.
- `resolveChannel` receives an explicit tenant/workspace-bound Slack client and
never discovers tenancy itself.
- `tenantHasChannels` takes `tenant_id` and uses only that tenant's workspace.
- Commands keep the current fast acknowledgement and use their signed team ID
for all later settings/API calls.
- Approval/view submissions cross-check the cycle workspace before dedupe or
state transition.

Handle lifecycle events idempotently:

- For `app_uninstalled` and `tokens_revoked`, resolve the current credential by
  signed envelope `team_id` and check it using `auth.test`. Only a definitive
  revoked/inactive token permits deletion. A valid current token makes the
  lifecycle event stale; provider/crypto uncertainty returns `503` for retry.
  Treat `invalid_auth` as uncertain because Slack also uses it for IP allowlist
  rejection.
- Conditional deletion must compare the checked ciphertext under the provisioning
  lock. Provisioning writes fresh randomized ciphertext, fencing a reinstall
  during the credential check even if its bot user ID stays the same.
- In the same transaction, delete that team's `channel_settings` explicitly,
  delete the workspace row, and set the owning tenant's `enabled` flag to
  `false`. Keep the explicit settings delete after the FK is added: it is
  harmless then and makes deploy B correct before cascade exists.
- Reinstallation/provisioning validates both integrations before re-enabling the
  tenant.
- Process these two deletion events after signature verification even when the
tenant is disabled; lifecycle cleanup must not depend on product entitlement.
- The tenant and historical review cycles remain. From deploy C onward, the FK
  cascade is a database backstop in addition to the explicit delete.
- Late/reordered deliveries are safe because cleanup verifies the current token and conditionally deletes that exact credential.

User-visible Slack text must not require persisted repository names. At initial
video/validation posting, pass the current `full_name` obtained from GitHub.
Finalization can use generic PR-number text and the existing message coordinates,
so losing GitHub access does not prevent removing live Slack buttons.

## GitHub client refactor

Replace `tokenForRepo(owner, repo)` with repository-ID operations. A useful
ephemeral result is:

```typescript
type RepositoryAccess = {
token: string;
repositoryId: string;
owner: string;
repo: string;
fullName: string;
};
```

This is a meaningful authorization boundary, not a persisted model.

Add a method conceptually equivalent to:

```typescript
authorizeRepository(installationId: string, repositoryId: string)
-> Promise<RepositoryAccess>
```

Then make check-run/comment methods accept `RepositoryAccess` rather than
looking up a token from stored names. Remove the name-keyed installation-token
cache and mint fresh repository-scoped access for each logical operation. The
token response supplies current repository metadata for validation and REST
coordinates. After potentially long Slack delivery, reacquire cycle-bound
repository access before the failure-path check update: even a newly minted
token can expire during delivery. Keep Slack cleanup independent if that fresh
authorization fails. Never automatically replay a comment POST when recovering
credentials.

Keep the token opaque: GitHub installation-token formats may change, and code
must not inspect length or prefix.

## Slack client refactor

Change `SlackClient` from an environment-bound singleton to a client bound to
one decrypted bot token. Keep `verifySlackSignature` independent because the
signing secret is app-wide.

Add one request-level resolver in the service layer:

```typescript
slackForTeam(teamId: string) -> Promise<{ tenantId: string; client: SlackClient }>
slackForTenant(tenantId: string) -> Promise<{ teamId: string; client: SlackClient }>
```

The resolver performs the DB lookup, enabled check, and token decryption. Do not
introduce a wrapper that merely carries the token; the resolver owns the actual
tenant/isolation invariant.

Update every Web API method, including file upload and modal opening, to use the
bound token. `respondEphemeral(responseUrl, ...)` remains tokenless, but only
signed Slack payloads may supply that URL.

## Storage API changes

Extend the store with explicit tenant/integration lookups:

- GitHub installation plus enabled tenant by `github_account_id`.
- GitHub installation by `tenant_id`.
- Slack workspace plus enabled tenant by `team_id`.
- Slack workspace by `tenant_id`.
- Atomically delete a Slack workspace by `team_id` and disable its tenant.
- Operator provisioning/upsert methods used by scripts.

Change cycle methods:

- `startCycle` receives authenticated `tenantId` and `repositoryId` as internal
fields, not as request-body fields.
- `rowToCycle` maps PostgreSQL bigint repository IDs to strings.
- `transitionRunnerStatus` receives authenticated tenant/repository identity and
includes both in its `WHERE` clause with `attempt_id` and status.
- `transitionSlackStatus` includes the expected cycle tenant after the signed
workspace-to-tenant check.
- Advisory lock and supersession predicates change together.
- Channel route reads/writes move to `slack_workspaces.selected_channel_id`.
- Preserve the per-team advisory lock around selected-channel initialization and
guarded setting updates.

Do not add a repository model or generic provider abstraction. The verifier and
GitHub client boundaries are enough for the accepted beta scope.

## Operator-assisted beta provisioning

Add a `provision-tenant` subcommand to the compiled service admin CLI described
below. It is the temporary onboarding control plane for development and internal
testing until the separate invite-only OAuth onboarding page is built before
beta launch.

Inputs:

- optional existing tenant UUID, otherwise generate one;
- a Slack bot token read from a non-echoing prompt/stdin, never a command-line
flag or log line;
- a GitHub installation ID as a decimal string;
- optional selected Slack channel ID.

Before writing:

1. Call Slack `auth.test`; take `team_id` and `user_id` from Slack, not operator
 input. Persist `user_id` as `bot_user_id`.
2. If a selected channel is supplied, verify bot membership.
3. Fetch the GitHub installation using the app JWT; take
 `installation.account.id` from GitHub.
4. Mint a scoped token for at least one selected repository as an end-to-end
 installation check, or explicitly allow an empty installation that remains
 unusable until a repository is selected.
5. Check that team, tenant, installation, and account uniqueness will not re-pair
 an existing customer accidentally.
6. Encrypt the Slack token with `team_id` as AAD.
7. In one DB transaction, insert/update the tenant and both installation rows.
8. Set `enabled = true` only after both integrations validate and write.
9. Print identifiers and readiness only; never print tokens/ciphertexts.

Reinstallation behavior:

- Same GitHub account and tenant with a new installation ID updates the existing
installation after validation.
- Same Slack team and tenant replaces its ciphertext after validation.
- Moving an existing GitHub account or Slack team to another tenant requires an
explicit operator-only replacement mode and a clear audit log; default is to
refuse.

The invite-only onboarding follow-up will add Slack OAuth and GitHub post-install
callbacks. They must call the same validated provisioning operations. The GitHub
setup callback must not trust its query-string `installation_id` without user or
webhook-backed verification.

### Production admin command

Add `packages/service/src/admin.ts` as a second `tsup` entry and ship
`dist/admin.js` in the production image. It exposes explicit subcommands for
provisioning, backfill, contract validation, migration status, and
`migrate-to <migration-name>`. This is an operational boundary with named
commands, not a generic SQL executor.

Run data-changing commands inside Railway's private network against the intended
environment, normally with:

```bash
railway ssh -- node dist/admin.js <subcommand>
```

This avoids depending on `tsx` or development dependencies, which are absent
from the production image. `railway run` executes locally and merely injects
variables, so a private `*.railway.internal` database URL may not resolve there.
For an emergency where the target application image never becomes healthy, run
the retained release's compiled admin command from a checkout through
`railway connect postgres --tunnel-only`, overriding `DATABASE_URL` with the
tunnel URL. Do not expose PostgreSQL publicly for this workflow.

Provisioning and backfill also need the Slack encryption key and GitHub App
credentials. Prefer the in-container SSH path where the deployed service already
has them. Never assume sealed Railway variables can be fetched by `railway run`.
The migration-status and `migrate-to` commands need only database access.

## Migration and release plan

### PR/deploy A — expand and prepare

Add migration `0008_multitenant_expand`:

1. Create `tenants`, `slack_workspaces`, and `github_installations`.
2. Add nullable `review_cycles.tenant_id` and `repository_id`, including the
 tenant FK.
3. Drop `NOT NULL` from legacy `review_cycles.owner` and `repo` so a later
 compatibility-free image can stop writing them before they are dropped.
4. Add the composite review-cycle lookup index.
5. Do not add the `channel_settings` FK yet because parent workspace rows do not
 exist until application-assisted backfill.
6. Do not drop legacy columns or tables.

Also add:

- token encryption code and its tests;
- the compiled production admin command with provisioning, backfill, validation,
  migration-status, and targeted rollback subcommands;
- compatibility route writes: while `team_channel_routes` still exists, selected
channel changes update both the old route and
`slack_workspaces.selected_channel_id` when the workspace row exists;
- read preference for the new selected-channel field with an old-table fallback
only during this release;
- new environment parsing without removing old variables.

Deploy A with the old application behavior still accepted. Do not provision a
second tenant yet because runner auth is still shared.

### Backfill current production data

Add `backfill-multitenancy` to the compiled admin command. It is idempotent and
supports `--dry-run` plus `--apply`.

It must:

1. Enumerate distinct legacy `owner/repo` values and all route/settings team IDs.
2. Call `auth.test` for the current `SLACK_BOT_TOKEN` and require every existing
 Slack row to belong to that one team.
3. Encrypt the bot token and create the singleton Slack workspace.
4. Resolve each legacy repository through the GitHub App, recording repository,
 installation, and account IDs.
5. Require the current data to resolve to one GitHub account/installation. If it
 does not, stop and emit a mapping report rather than guessing.
6. Create the singleton tenant and integration rows with `enabled = false` while
 backfill is incomplete.
7. Copy `selected_channel_id` from `team_channel_routes`.
8. Fill every resolvable cycle's tenant/repository IDs. During the initial live
 backfill, calculate and validate the future cycle key but do not write it while
 deploy A can still create legacy-format keys.
9. Detect prospective cycle-key collisions before updating. Stop and report the
 colliding cycle IDs; never silently select a winner.
10. Report missing/deleted/transferred repositories separately. Contract cannot
  proceed until each row is resolved or explicitly exported and removed under
  an operator-approved data-retention decision.
11. Validate row counts, FK candidates, unique constraints, non-null candidates,
  and ciphertext decryption.
12. Enable the tenant only after the full validation succeeds.

Because the old service can still write null review-cycle IDs after the first
backfill, rerun it immediately before cutover after runner traffic is paused and
old workflows are drained. Only in this no-writer window rebuild every cycle key,
then deploy B before accepting another run.

### PR/deploy B — OIDC and multitenant cutover

Implement the target runtime:

1. Add `jose` to the service and `@actions/core` to the action using pnpm so the
 lockfile changes with package manifests.
2. Add OIDC verifier/discovery/JWKS code and dependency injection for tests.
3. Change the action to request a fresh audience-bound OIDC token per request.
4. Remove `owner/repo`, title, author, and base SHA from the public start identity;
 send PR number and head SHA only.
5. Refactor the GitHub client to installation/repository-ID authorization.
6. Refactor the Slack client to team-bound tokens from PostgreSQL.
7. Change store types, cycle identity, locks, supersession, and guarded
 transitions atomically.
8. Change all runner, Slack, check-run, comment, onboarding-probe, and channel
 resolution paths to explicit tenant context.
9. Keep writing legacy owner/repo and route columns for the rollback window, but
 never read them as identity.
10. Remove shared runner-token acceptance from the deployed service.
11. Delete the service-side `FEATURE_REC_GITHUB_TOKEN`/`GITHUB_TOKEN` fallback;
  the only GitHub client path uses repository-scoped installation tokens.
12. Keep old columns/tables and old hosted runner/Slack secrets temporarily for
  a qualified rollback only.

Cutover runbook:

1. Verify a current PostgreSQL backup and restore drill.
2. Inventory every beta workflow. If any consumes the action from `@main`, pin
 it to the pre-cutover commit before merging code that changes the protocol.
3. Add and verify `permissions: id-token: write` in every beta workflow. Prepare
 the new pinned action revision; do not rely on a moving `@main` for cutover.
4. Set the Slack encryption key and OIDC issuer in Railway and verify the public
 base URL that both sides normalize as the audience.
5. Pause new runner traffic, then drain or cancel every in-flight workflow that
 still uses the shared runner token.
6. Rerun backfill, rebuild cycle keys in the no-writer window, and require a
 clean validation report.
7. Deploy B with no mixed old/new request handling.
8. Switch each workflow to the pinned OIDC action revision and remove its dead
 `FEATURE_REC_RUNNER_TOKEN` reference.
9. Provision the second test tenant and run the two-tenant smoke matrix below.
10. Resume runner traffic.

The cycle-key builder, unique lookup, advisory lock, and supersession predicate
must switch in the same deploy. There must be no period where two instances use
different per-PR lock identities.

### Observation window

Keep the rollback columns/table and old hosted secrets sealed but unused for a
defined observation period. During it:

- compare old/new selected-channel values after every write;
- assert all new review cycles have tenant/repository IDs;
- confirm no request authenticates via the legacy runner token;
- confirm Slack calls use the expected team-specific token;
- test repository rename handling;
- test GitHub repository deselection and Slack uninstall failure behavior;
- inspect logs for unknown tenant, identity mismatch, decrypt, JWKS, and
installation-token errors;
- rerun the contract-readiness validator.

Deploys A and B both register migrations through `0008`, so a B-to-A rollback
does not need a Kysely migration down. It is nevertheless a qualified product
rollback, not a generic binary swap: before a second tenant exists, the admin
command may rebuild legacy cycle keys and validate the singleton route, then the
operator can redeploy A and re-enable the old secrets. Once additional tenants
or C-written rows exist, deploy A cannot represent the data safely; use a B
hotfix/roll-forward or restore the pre-cutover backup instead.

### PR/deploy C — enforce and stop legacy dependency

Only after the first observation window and a fresh backup, add:

`0009_multitenant_enforce`:

1. Abort if any review cycle has null tenant/repository IDs.
2. Abort if channel settings refer to an absent Slack workspace.
3. Set both review-cycle columns `NOT NULL`.
4. Add `channel_settings.team_id -> slack_workspaces.team_id ON DELETE CASCADE`.

Its `down()` must drop the named channel-settings FK and drop `NOT NULL` from
both review-cycle identity columns. This is intentionally non-destructive and
makes a C-to-B rollback possible after the migration record is removed.

In the same application release:

1. Remove old-table read fallback and selected-channel dual writes.
2. Stop writing legacy `review_cycles.owner` and `review_cycles.repo`.
3. Verify the shared runner token, global Slack token, and direct GitHub token
 remain absent from runtime code. The direct GitHub fallback was deleted in B;
 sealed runner/Slack environment values exist only for the qualified A rollback.
4. Keep the physical legacy columns and `team_channel_routes` table untouched.

Deploy C can safely migrate while deploy B serves because deploy B already writes
valid tenant/repository IDs and installed-workspace channel settings. After C is
healthy, run a short second observation window and confirm no SQL or runtime path
references the legacy fields/table.

### PR/deploy D — contract

Only after deploy C is serving, the second observation window is clean, and a
fresh backup exists, add:

`0010_multitenant_contract`:

1. Drop `team_channel_routes`.
2. Drop `review_cycles.owner` and `review_cycles.repo`.
3. Drop `review_cycles.config_hash` and `review_cycles.config_json`.

Its `down()` must recreate empty `team_channel_routes` plus nullable `owner`,
`repo`, `config_hash`, and `config_json` columns. Deploy C does not read or write
any of them, so recreating empty compatibility schema is sufficient for D-to-C;
do not fabricate historical values.

Then delete the sealed hosted `FEATURE_REC_RUNNER_TOKEN`, `SLACK_BOT_TOKEN`, and
any hosted direct GitHub token. Update migration comments to state that
pre-cutover binaries are no longer rollback-compatible.

The old deploy C process can continue serving while deploy D runs because deploy
C does not read or write the schema being dropped. A fresh C process cannot
start while the database records `0010`, however; Kysely rejects an executed
migration missing from that binary's static provider. D-to-C therefore requires
rolling the database back to `0009` with deploy D's admin command before
redeploying C.

Do not put migrations 0008 through 0010 into one automatically deployed artifact.
With `migrateToLatest()`, that would collapse expand and contract before the
application-assisted backfill and observation steps can occur.

### Migration-aware rollback runbook

Kysely 0.29.3 validates that every executed migration is registered by the
running binary. `allowUnorderedMigrations` does not relax that check. Therefore
never redeploy an older artifact first when the database has a newer migration:
it will fail startup before the health endpoint listens.

Each release migration has a tested `down()` and every release artifact is
retained. To roll back:

1. Pause runner and Slack mutation traffic, drain requests, and verify a fresh backup.
   Disable automatic deploys and stop all current service instances through deployment controls so
   the always-restart policy cannot recreate them. A process kill alone is insufficient.
2. Use the currently applied/newer artifact's admin command from a separate maintenance process
   over the private database connection to print migration status. Do not downgrade via a live
   service's SSH shell: a restart would automatically reapply its latest migration.
3. Run `node dist/admin.js migrate-to <target> --environment production --expect-current <current>
   --service-stopped --traffic-paused --confirm` there. These acknowledgements do not stop the
   platform automatically. The current-migration check and migration share a lock with startup. Inspect
   `MigrationResultSet.error` and every result; exit nonzero on any failure.
4. Verify the migration table and schema at the target. Do not edit Kysely's
   migration table manually.
5. Only then redeploy the pinned older application artifact and run its smoke test. Resume traffic,
   and restore autodeploys only after checking their target is safe for the chosen schema.

Targets:

- A to the pre-A image: migrate to `0007_mention_modes`; `0008.down()` first
  refuses if legacy `owner/repo` cannot be made non-null, then removes the new
  index, columns, and integration tables.
- B to A: no migration down because both register through `0008`; apply the
  singleton/data qualification described above.
- C to B: migrate to `0008_multitenant_expand` using artifact C.
- D to C: migrate to `0009_multitenant_enforce` using artifact D.
- D to B: migrate to `0008_multitenant_expand` using artifact D. Rolling farther
  back to A requires the singleton reverse-data validator or a backup restore.

PostgreSQL transactional DDL and Kysely's migration lock/bookkeeping make each
step atomic. Give constraints stable explicit names so `down()` can target them,
and use `if exists` on destructive drops where Kysely supports it. A later
roll-forward reruns `up()` normally after the corresponding migration record was
removed. Test every forward/down/forward path; do not treat `down()` as ceremonial.

### Autodeploy and PR topology

Use four PRs because each merge autodeploys:

1. PR A: expand migration, compatibility behavior, compiled admin tooling.
2. PR B: OIDC/multitenant cutover, with legacy writes retained for its observation
   window.
3. PR C: enforce constraints and stop every legacy read/write.
4. PR D: contract migration and final cleanup.

Do not put a later wave's migration in an earlier PR. In particular, C and D
must be separate because C must be healthy and observed before D drops schema.
Two PRs would only be possible by shipping dormant cutover/stop-legacy paths in
PR A, controlling them with production feature flags, and manually observing
each flag transition before PR D. That adds rollout state and rollback cases
solely to reduce PR count, so it is rejected for beta.

Consumer workflows must also be pinned away from `@main`; otherwise merging a PR
changes their action protocol independently of the staged backend release.

## File-by-file implementation map

### `packages/core`

- Add the canonical backend-URL-to-OIDC-audience normalization function and use
  it from both the action and service.
- Change `RunStartRequestSchema` to PR number plus head SHA.
- Add a successful no-op response and reason for closed, draft, or changed-head
  PRs.
- Add tenant/repository IDs to `ReviewCycleSchema`; remove owner/repo after the
compatibility window.
- Change `buildCycleKey` inputs and tests.
- Keep GitHub/Slack user-facing constants independent of stored repository names.

### `packages/action`

- Add `@actions/core` and request `getIDToken(audience)` per backend call.
- Make authorization-header construction asynchronous.
- Stop reading `FEATURE_REC_RUNNER_TOKEN`.
- Stop sending owner/repo/title/author/base SHA to `/start`.
- Continue using event owner/repo/base/head locally for checkout/diff work only.
- Treat stale and duplicate starts as clean exits.
- Preserve the original processing error if `/failed` reporting also fails.
- Update action selftests with an injected/fake token provider.

### `packages/service/src/oidc.ts`

- Add trusted discovery, cached remote JWKS, JWT verification, claim narrowing,
stable error categories, and tests.
- Keep the issuer/JWKS configuration outside token data.

### `packages/service/src/env.ts`

- In deploy B, require explicit `FEATURE_REC_BASE_URL`, validate it, and derive
  the audience through `@feature-rec/core`. Keep the default GitHub issuer while
  validating any override. A missing/invalid base URL fails startup.
- Keep old runner/Slack token parsing in deploy A.
- Remove those runtime fields in deploy B; retain the hosted values, sealed and
unused, only for the validator-gated singleton rollback to deploy A. They do not
make A a general binary rollback target. Delete the hosted values after deploy D.

### `packages/service/src/github.ts`

- Expose app-JWT-backed installation lookup for provisioning.
- Add repository-scoped installation-token minting.
- Validate returned repository and owner IDs.
- Add PR fetch/validation.
- Pass ephemeral repository access to check/comment methods.
- Remove runtime mutable-name discovery and installation-token caching.
- Remove the direct `FEATURE_REC_GITHUB_TOKEN`/`GITHUB_TOKEN` fallback outright.
- Keep comment POST retry behavior unchanged: do not retry a possibly successful
non-idempotent comment write.

### `packages/service/src/slack.ts`

- Bind clients to one token rather than `ServiceEnv`.
- Retain signature verification as an app-level function.
- Remove global identity fallback.
- Use persisted `bot_user_id` to filter membership events; reserve `auth.test`
  for provisioning and token replacement.
- Accept current `full_name` as display input only where needed.
- Make finalization independent of a live GitHub lookup.

### `packages/service/src/channels.ts`

- Take an explicit team-bound Slack client/team ID.
- Read/write the selected channel on `slack_workspaces`.
- Preserve current zero/one/many membership and initialization-race behavior.

### `packages/service/src/storage/*`

- Add table types and migration registrations.
- Add integration lookup/provision/delete methods.
- Move route methods to `slack_workspaces` with deploy-A dual writes.
- Make lifecycle deletion atomically remove the team's channel settings and
  workspace row and disable its tenant, before and after the cascade FK exists.
- Add tenant/repository predicates to cycle methods.
- Preserve bigint IDs as strings.
- Add dry-run/apply backfill, rollback-readiness, contract validators, and tested
  migration-down paths.

### `packages/service/src/admin.ts` and build

- Add the compiled admin subcommands described above; do not leave production
  operations under `scripts/*.mts` only.
- Add `src/admin.ts` as a second `tsup` entry so `pnpm deploy --prod` includes
  `dist/admin.js` without `tsx` or development dependencies.
- Require explicit environment selection and `--confirm` for writes; print no
  secret values.
- Document the Railway SSH path and the database-tunnel emergency fallback.

### `packages/service/src/http.ts`

- Replace `runnerAuthorized` with async OIDC authentication/authorization.
- Centralize start and existing-cycle authorization helpers.
- Use current PR data from GitHub.
- Thread explicit tenant context through all GitHub and Slack side effects.
- Cross-check signed Slack team against cycle tenant before approval.
- Handle Slack uninstall/token-revocation events.
- Map invalid authentication, forbidden tenant/install, and temporary provider
failures consistently without leaking tenant existence.

### Documentation and deployment files

- Remove runner-secret setup from `README.md`, `docs/setup-and-operations.md`,
`.env.example`, the example workflow, and hosted deployment docs.
- Document `id-token: write`, issuer/audience, token encryption, operator
provisioning, and multi-workspace Slack installation.
- Replace consumer `@main` examples with a version tag or immutable commit and
  add a per-beta-repository cutover checklist.
- Update `docs/multitenancy-notes.md` so historical singleton assumptions are
explicitly superseded.
- Update CI/Docker smoke variables. The health smoke must not require live GitHub
or Slack network access; discovery/JWKS fetching stays lazy until an OIDC call.

## Test plan

### OIDC verifier tests

Use an in-process JWKS/discovery server and generated RSA keys:

- deploy-B environment parsing refuses a missing, localhost-defaulted, or invalid
  `FEATURE_REC_BASE_URL`; explicit loopback HTTP is allowed only in local/test;
- the default GitHub issuer and a valid explicit issuer override both parse;
- valid signature/issuer/audience/claims;
- missing bearer token;
- malformed JWT;
- wrong signature;
- wrong issuer or audience;
- expired/not-yet-valid token and clock tolerance;
- missing or non-decimal repository/account IDs;
- wrong event type;
- disallowed algorithm;
- a new `kid` refreshes JWKS and verifies without DB state;
- token-provided issuer/JWKS/header URLs never redirect verification;
- discovery/JWKS outage maps to temporary failure without logging the token.

### Database and migration tests

- Start from a migration-0007 fixture and apply only expand.
- Prove an older static migration provider rejects a database that records a
  later migration, freezing the Kysely behavior the rollback runbook addresses.
- Backfill one valid singleton tenant and verify all row counts/keys.
- Dry-run performs no writes.
- Repeated apply is idempotent.
- Multiple account/installation discovery aborts.
- Unresolvable repository aborts contract readiness.
- Rebuilt cycle-key collision is reported, not overwritten.
- Unique tenant/team/account/installation constraints reject invalid pairings.
- Selected-channel dual writes cannot drift under concurrent updates.
- Enforce migration refuses null/orphan rows.
- Contract migration succeeds only after readiness and leaves the expected schema.
- Exercise `0008`, `0009`, and `0010` in forward/down/forward order and verify
  both schema and Kysely migration-table state after each step.
- Verify the compiled admin command exits nonzero on migration error or an
  unexpected current migration and never deploy the older fixture first.
- Slack workspace deletion explicitly removes channel settings before `0009`
  and remains idempotent with the cascade after `0009`; tenant/cycles remain and
  the tenant becomes disabled.

### Runner HTTP tests

- Valid repo A token creates only tenant A cycles and uses installation A.
- Repo A token cannot start or mutate a tenant B cycle.
- Valid token plus wrong attempt ID is a stale no-op.
- Invalid OIDC is `401`; unknown/disabled/uninstalled authorization is generic
`403`; provider outage is retryable.
- Installation without access to the signed repository creates no cycle.
- OIDC owner ID and returned repository owner mismatch fails closed.
- Closed, draft, and stale-head PR races each exit cleanly without a check run.
- PR metadata is derived from GitHub, not request-controlled fields.
- Same-head duplicate, failed takeover, newer-head supersession, and check-run
attachment races preserve their existing semantics.
- Two tenants with the same repository ID cannot collide historically.
- Per-PR advisory locking uses tenant/repository/PR, with no owner/repo predicate.
- Result endpoints require fresh repo-bound identity and attempt ownership.

### GitHub behavior tests

- Scoped-token request contains only the requested repository ID.
- Every authorization mints a fresh token, including repeated calls for the same
  installation/repository pair; a previous grant cannot hide a later rejection.
- Grant denials, provider outages, rate limits, and malformed responses retain
  their safe error mapping, including after an earlier successful grant.
- Video failure cleanup obtains fresh access after a long Slack upload; failed
  reauthorization leaves the stored failure and independent Slack cleanup intact.
- Current full name is used for REST coordinates.
- Repository rename between operations uses the new name.
- Transfer to an unauthorized owner fails; later authorization under a different
tenant creates a distinct cycle key.
- Repository removed from installation fails authorization.
- GitHub access-token strings remain opaque.
- Comment POST remains single-shot; idempotent check PATCH retains bounded retry.

### Slack multitenancy tests

Create two tenant/workspace/token stubs:

- `/video` for tenant A only polls/posts with token A and channel A.
- Tenant B commands/settings cannot read or change tenant A.
- A signed workspace-A interaction carrying a cycle-B ID cannot approve it.
- Unknown workspace never falls back to a global client.
- A non-bot `member_joined_channel` event is filtered using stored `bot_user_id`
  without decrypting the token or calling `auth.test`.
- Selected-channel initialization remains first-writer-wins per team.
- Mention/approver settings stay isolated by team/channel.
- `app_uninstalled` and bot `tokens_revoked` delete only the signed team row and
disable only its tenant; both events are idempotent in either delivery order.
- Reinstallation of the same team accepts the new token; old ciphertext no
longer authenticates calls.
- Slack token ciphertext cannot be moved to another team because AAD validation
fails.
- Finalization can remove buttons even when GitHub access has since disappeared.

### Action tests

- The action and backend import the same audience-normalization function.
- A token is requested for every backend call, including after rendering.
- The runner token environment variable is neither read nor required.
- Start payload contains no tenant or repository-name authority.
- Duplicate/stale starts exit before rendering.
- OIDC fetch/backend auth failures retain actionable messages and original errors.

### Deployment/runbook tests

- Build the production image and run `node dist/admin.js --help`; no `tsx` or
  development dependency is present or required.
- In staging, rehearse C-to-B and D-to-C by running `migrate-to` before starting
  the older artifact; also prove the reversed order crashloops as expected.
- Rehearse the Railway SSH execution path and the `railway connect
  --tunnel-only` fallback without enabling public database access.
- Inventory beta workflows, reject moving `@main` references, require
  `permissions: id-token: write`, and confirm the shared runner secret is absent
  after cutover.

### End-to-end beta smoke matrix

With two real test tenants:

1. Install the GitHub App on one repository per tenant.
2. Install the Slack app in two workspaces and select different channels.
3. Confirm both workflows use a pinned action revision and grant
 `permissions: id-token: write`, then run them simultaneously.
4. Confirm check runs, videos, messages, settings, approvals, comments, and
 finalization stay within their tenant.
5. Attempt cross-tenant cycle IDs and confirm no mutation.
6. Rename one repository and repeat without a data edit.
7. Deselect a repository from its installation and confirm authorization fails.
8. Re-enable it and confirm the next run succeeds.
9. Uninstall Slack from one workspace and confirm the other tenant is unaffected.
10. Reinstall/reprovision and confirm normal operation returns.

### Required verification commands

```bash
pnpm --filter @feature-rec/core run selftest
pnpm --filter @feature-rec/action run selftest
pnpm --filter @feature-rec/service run selftest
pnpm typecheck
pnpm lint
pnpm selftest
docker build --tag feature-rec-service:oidc-multitenant .
```

The CI image smoke supplies a test encryption key, public base URL, and OIDC
issuer but does not need live provider credentials to answer `/health`.

## Observability and operational safeguards

Log structured, non-secret fields:

- request route and result category;
- tenant ID after successful resolution;
- repository/account/installation IDs after successful authorization;
- Slack team ID after signature verification;
- OIDC/JWKS/GitHub/Slack failure category;
- cycle ID and attempt/stale outcome.

Never log JWTs, authorization headers, bot tokens, ciphertext, private keys,
OAuth response bodies, or Slack payload bodies. Avoid logging tenant identifiers
on generic unauthenticated responses.

Before contract, add a read-only validator that reports:

- null tenant/repository cycle identities;
- duplicate future cycle keys;
- tenant cardinality violations;
- channel-setting orphans;
- selected-channel old/new divergence;
- ciphertexts that cannot be decrypted by their team AAD;
- enabled tenants missing either integration.

The command exits nonzero on any contract blocker and prints no secrets.

## Acceptance criteria

- At least two tenants work concurrently from one backend and database.
- No runner request relies on a shared secret or caller-provided tenant/repository
name for identity.
- Every runner mutation is bound to verified tenant, repository, and attempt.
- A GitHub App installation's live repository grant is checked before work.
- Repository rename requires no database update.
- Slack API calls always use the token belonging to the signed/cycle workspace.
- A signed Slack interaction cannot cross tenant boundaries.
- New cycles, locks, and supersession use tenant/repository IDs exclusively.
- Slack tokens are encrypted at rest and never logged.
- JWKS rotation requires no database write.
- Deploy B refuses to start without an explicit valid `FEATURE_REC_BASE_URL`, so
  it cannot silently expect a localhost OIDC audience.
- Legacy data is backfilled and validated before constraints/deletion.
- Deploy B can roll back to A only after the singleton/data rollback validator;
  once multiple tenants exist, A is not a supported target without restoring the
  pre-cutover backup.
- Deploy C can roll back to B only after artifact C migrates the database down to
  `0008`; deploying B first is a tested startup failure.
- Deploy D can roll back to C only after artifact D migrates the database down to
  `0009`; deploying C first is a tested startup failure.
- Contract runs only after deploy C has removed legacy reads/writes, its
observation window is clean, and a backup is verified.
- `team_channel_routes`, legacy repository names/config, shared runner token, and
shared Slack bot token are gone after contract.
- Full typecheck, lint, selftests, image build, and two-tenant smoke pass.

Completing this plan makes the backend ready for multitenant/OIDC testing; it does
not by itself authorize beta launch. The separate invite-only onboarding
requirement below must also be complete.

## Required before beta launch, outside this implementation

Build an invite-only onboarding page that lets an invited customer connect Slack
through OAuth and install/connect the GitHub App. Its callbacks reuse the
validated tenant-provisioning operations built here rather than duplicating
integration-writing logic. Invite authorization, page UX, OAuth state handling,
and the exact onboarding persistence belong in a separate reviewed plan.

The page may provide manual workflow-installation instructions. Automatically
opening workflow PRs remains deferred.

## Future cardinality evolution

The beta schema deliberately enforces one workspace and one GitHub installation
per tenant. It does not pretend that routing is already many-to-many:

- One tenant to many Slack workspaces or GitHub installations starts by removing
the relevant `unique (tenant_id)` constraint. Before doing so, add the routing
rule that decides which integration a repository/cycle uses.
- Many tenants sharing one workspace or GitHub account cannot be represented by
the child-table `tenant_id` alone. If the product ever needs that model, move
ownership into explicit tenant/integration association tables while preserving
`team_id`, `installation_id`, and `github_account_id` as provider identities.
- Many-to-many is the same association-table migration plus an explicit routing
table at the chosen product boundary. Do not add those abstractions before the
sharing semantics exist.

Nothing in cycle identity depends on a Slack workspace, so historical cycles do
not need rewriting when those future routing tables are introduced.

## Explicitly deferred follow-ups

- GitHub App installation/repository webhook synchronization; live scoped-token
authorization remains the beta source of truth.
- Automated PRs that add the workflow to selected repositories.
- More than one Slack workspace or GitHub account per tenant. When required,
remove the appropriate `unique (tenant_id)` constraint and add an explicit
routing rule at the product-chosen granularity.
- Provider/issuer rows for shared multi-GitHub-host support.
- Token-encryption key rotation/KMS beyond the versioned ciphertext seam.
- Durable outbox/reconciliation of post-transition GitHub/Slack side effects.

## References

- [GitHub OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub App setup URL security warning](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
- [Slack OAuth installation flow](https://docs.slack.dev/authentication/installing-with-oauth/)
- [Slack `app_uninstalled` event](https://docs.slack.dev/reference/events/app_uninstalled/)
- [Slack `tokens_revoked` event](https://docs.slack.dev/reference/events/tokens_revoked/)
- [`jose` remote JWKS behavior](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md)
- [Railway SSH commands](https://docs.railway.com/cli/ssh)
- [Railway local `run` behavior](https://docs.railway.com/cli/run)
- [Railway database tunnel](https://docs.railway.com/cli/connect)

## Safety issues found during plan review

- Activating multitenant GitHub routing before OIDC would let the shared runner
secret address whichever installed repository is named in a request.
- Authenticating only `/start` would leave result endpoints cross-tenant; every
mutation must bind OIDC identity to the stored cycle.
- Trusting request owner/repo, tenant ID, PR title/author, or an unchecked PR head
would make authenticated repository workflows able to target unintended data.
- Adding review-cycle columns as non-null before backfill would fail migration or
force fabricated identities.
- Old application instances can write new null/drifting rows during backfill;
final reconciliation requires paused runner traffic or compatibility writes.
- Switching cycle keys without locks and supersession in the same release can
create two active cycles for one PR.
- Caching GitHub access by mutable full name can misroute after rename; caching
full-name metadata needs explicit invalidation or should be omitted for beta.
- A global Slack client or bot-identity fallback can route one tenant through
another workspace's token.
- A valid Slack signature alone does not bind a leaked cycle ID to the payload's
workspace; the cycle tenant/team cross-check is mandatory.
- Copying `selected_channel_id` once while legacy writes continue can lose a later
channel change; dual-write/final reconciliation is required.
- Shipping expand and contract migrations together is unsafe because
`migrateToLatest()` applies all registered migrations before health while the
old Railway image may still be serving the shared database.
- Removing legacy fields in deploy B would eliminate binary rollback; first stop
every legacy read/write in deploy C, then delete only after another observation
and backup in deploy D.
- Dropping legacy fields while the previously serving deploy still dual-writes
them would break requests during Railway health-gated handoff; the no-legacy
deploy must become healthy before the contract migration is present.
- Treating a single PR as four deployable checkpoints is unsafe under the current
  merge-triggered autodeploy. Use four PRs, and no earlier PR may register a later
  migration.
- Cutting over while old-token workflows are still rendering would make their
result callbacks fail authentication; pause, drain or cancel them first.
- Deleting a revoked Slack workspace without disabling its tenant leaves an
enabled but unroutable customer; lifecycle cleanup must update both atomically.
- Treating every Slack `tokens_revoked` event as bot revocation is safe only while
Feature-Rec stores no user tokens; adding user OAuth changes that event rule.
- The beta child-table foreign keys do not directly model many-to-one or
many-to-many integration sharing; those futures require explicit association
and routing tables rather than weakening current isolation constraints.
- Backfill can encounter renamed, transferred, deleted, or duplicate historical
repositories; it must report and stop rather than guess or silently delete.
- Persisting or logging raw bot/OIDC/access tokens would turn tenant compromise
  into a database/log compromise; encryption, redaction, and opaque token handling
  are release blockers.
- Kysely 0.29.3 rejects an executed migration absent from an older binary's
  static provider. The earlier C-to-B and D-to-C binary-only rollback claims were
  false; migrate down with the newer artifact before starting the older one.
- Deleting `slack_workspaces` in deploy B does not cascade because the FK arrives
  in `0009`. Explicitly delete that team's `channel_settings` in the same
  lifecycle transaction in every release.
- Calling `auth.test` for every delivered member-join event adds avoidable API
  traffic. Persist the verified Slack `bot_user_id` and refresh it whenever the
  token is provisioned or replaced.
- A PR can close, become draft, or change head between the GitHub event and
  `/start`; all three races need a clean no-op contract rather than a red CI run.
- OIDC cutover fails in any consumer workflow missing `id-token: write`; inventory
  and verify the permission before traffic resumes.
- Duplicating audience normalization across the action and service invites an
  authentication outage from trivial URL differences; share the function in
  `@feature-rec/core`.
- Retaining a direct GitHub-token fallback would bypass installation/repository
  authorization. Remove it outright from the service in deploy B.
- Production operator scripts implemented only as TypeScript source cannot run
  in the `pnpm deploy --prod` image because it has no `tsx`; ship a compiled admin
  entrypoint and rehearse its Railway execution path.
- Rebuilding cycle keys during a live deploy-A backfill races the old key builder
  and can create duplicate same-head cycles. Calculate early, but write keys only
  after traffic is paused and old workflows are drained.
- Even without a Kysely migration mismatch, A cannot safely serve arbitrary
  post-B multitenant data. B-to-A is limited to a validated singleton or a
  pre-cutover restore, not an unconditional binary rollback.
- Consumer workflows tracking `@main` bypass staged release sequencing when the
  plan PR merges. Pin the old action before cutover and move to a pinned OIDC
  revision deliberately.
- Allowing deploy B to default `FEATURE_REC_BASE_URL` to localhost would turn one
  missing Railway variable into a healthy-looking service that rejects every
  correctly audience-bound runner token. Require and validate it at startup.
- Calling deploy A an unconditional binary rollback target contradicts the
  validator-gated singleton limitation. All summaries and file maps must use the
  qualified rollback wording.
- With merge-triggered autodeploy, PR boundaries are deployment boundaries. The
  four safe A/B/C/D artifacts therefore require four PRs; compressing them into
  two would require additional runtime rollout flags and manual transition state.
- Describing onboarding UI/OAuth as deferred beyond beta contradicts the launch
  scope. The invite-only page is a separate pre-beta requirement, while this
  implementation deliberately stops at temporary operator provisioning.

## Plan caveats from PR B review validation (2026-09-05)

- The statement that late/reordered lifecycle deliveries are safe solely because
  deletion is idempotent is incomplete. Re-provisioning the same team between an
  old uninstall/revocation and its delivery lets the old event delete the new
  workspace. Event-ID deduplication alone cannot reject a never-successfully-
  processed old event or the distinct companion lifecycle event. The lifecycle
  design needs a reliable way to distinguish events predating the current
  installation; any dedupe bookkeeping and deletion must commit atomically.
  Resolved in the review follow-up: live current-token verification plus atomic
  compare-and-delete under the provisioning lock. No event-ID-only dedupe or new
  migration is needed; provider uncertainty leaves the row intact for retry.
- The workflow cutover instructions assume existing active consumers. The user
  clarified that no Feature-Rec runner workflow is currently active, so pinning
  an existing pre-cutover workflow is presently inapplicable. Removing the dead
  runner-secret reference from the example is still required. Resolved in the
  user-approved follow-up: keep the development example on `@main` for now and
  remove the retired secret. Immutable consumer rollout remains a separate step.

## PR B lifecycle review follow-up (2026-09-07)

- Resolved: `invalid_auth` is not conclusive revocation; it can indicate an IP
  allowlist rejection. Only `token_revoked` and `account_inactive` permit
  lifecycle deletion. Ambiguous errors preserve the workspace for retry.
- Open operational limitation: synchronous lifecycle verification and deletion
  can exceed Slack's three-second acknowledgement window under provider latency
  or provisioning-lock contention. Retries are safe, but immediate successful
  acknowledgement needs a durable event queue and retrying worker. Event-ID
  deduplication with in-memory background work alone would lose cleanup on a
  crash and suppress Slack's retries after a verification or database failure.

## PR B token-cache and delivery follow-up (2026-09-07)

- Superseded by the later simplification decision below: the user initially
  requested keeping scoped tokens cached by installation ID and repository ID
  until one minute before expiry, with live metadata checks on reuse.
- Resolved: a supersession racing failed Slack message attachment could leave
  the locally captured post with live buttons. The stale error branch now
  finalizes that post when the stored cycle is superseded and preserves other
  decisions; regressions cover cleanup retries and failure.
- Resolved: settled video responses now have explicit regression assertions for
  the `502` branch and the `503` `Retry-After` value.
- Resolved: the operations guide's Slack acknowledgement citation uses the
  verified `#responding` anchor.

## PR B token and long-delivery simplification (2026-09-07)

- User decision: remove the installation-token cache. Its live metadata lookup
  replaced a mint with another GitHub request and introduced expiry and eviction
  handling. Each logical operation now mints fresh repository-scoped access.
- Resolved: video failure cleanup previously reused access obtained before an
  unbounded Slack upload. It now reacquires access for the cycle before updating
  the check; regression coverage simulates expiry during delivery and failed
  reauthorization without blocking independent Slack cleanup.
- Coverage follows the remaining paths: repeated grants, rejection after prior
  success, safe provider failures, and recovery. Cache-listing `total_count` and
  post-eviction cases no longer exist. Same-request content-mismatch reminting
  and concurrent duplicate-mint optimization are explicitly out of scope.
