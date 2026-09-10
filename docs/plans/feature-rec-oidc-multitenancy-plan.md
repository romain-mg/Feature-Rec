# Feature-Rec OIDC and Multitenancy Dev Plan

Status: PR A/B complete and deployed; PR B2 milestone 1 SDK/configuration implemented, hosted installation pending; PR C implemented but release gated on B2 and two-workspace validation; PR D contract pending

Date: 2026-09-03

Last reviewed: 2026-09-04

Sequencing amended: 2026-09-08 — add PR B2 before releasing PR C; use
OAuth endpoints on the existing backend, superseding the local-helper proposal.

Installation entry simplified: 2026-09-09 — expose one fixed public OAuth start
URL per deployment; retain protected sessions and operator-controlled activation.

PR B implemented: 2026-09-05. The action and service use OIDC and tenant/repository
identity, with workspace-bound Slack clients and compatibility writes retained.
The PR B artifact registers no migration after `0008_multitenant_expand`. Local verification
passed typecheck, lint, the full selftest suite, the production image build, and
compiled-admin/health smoke tests against isolated PostgreSQL. Production
backfill/cutover and the real two-tenant smoke remain operator release steps.

PR C implemented: 2026-09-08, preserved in commit `cb34cc8` on
`feat/oidc-multitenancy-pr-c`. Its current migration
`0009_multitenant_enforce` must be renamed to `0010_multitenant_enforce` when
integrating B2, which now owns additive migration `0009`. That source rename is
not part of this plan-only amendment. The existing enforcement migration refuses null
cycle identity and orphan channel settings, sets both review-cycle identity
columns `NOT NULL`, and adds the named `channel_settings_team_id_fkey` cascade;
its `down()` reverses only those constraints. The release stops every legacy
read/write: `startCycle` no longer persists `owner`/`repo`, the selected-channel
dual write and the lifecycle `team_channel_routes` delete are removed, and
`owner`/`repo` left `ReviewCycleSchema` and the Kysely table types. Because
backfill and A-rollback are provably inapplicable once enforcement runs, the deploy-C
artifact also removes `backfill-multitenancy`, `prepare-rollback-to-a`,
`buildLegacyCycleKey`, the validator's route-drift check, and the backfill-only
`AdminProviders.resolveRepository` seam; those tools live on in the retained A/B
artifacts. Physical legacy columns and `team_channel_routes` stay untouched for
the PR D contract. Deploying C and the second observation window remain operator
release steps. PR C development may continue in parallel, but its merge/deploy
must wait for PR B2 and the first observation/readiness gate below.

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

This plan uses expand/backfill/cutover/hosted-installation/stop-legacy/contract.
Because merging a PR autodeploys its artifact, release in order A, B, B2, C, D.
B2 adds hosted installation handling and its own additive session table; it must
not ship C's enforcement migration or legacy-removal changes.
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
- This implementation uses operator-assisted onboarding. PR B2 supplies the
  public hosted Slack OAuth installation flow needed to obtain additional
  workspaces' bot tokens and test isolation before deploying C. Installation
  requires Slack approval; tenant pairing and activation remain operator-only.
  The full invite-only customer
  onboarding page and GitHub App connection UI remain a separate pre-beta
  follow-up. Automated workflow PR creation remains deferred.

## Non-goals

- Multiple Slack workspaces or GitHub accounts per tenant.
- Many-to-many GitHub-to-Slack routing.
- A repositories table or repository synchronization subsystem.
- Persisting repository names merely to call GitHub APIs.
- Full GHES or multi-issuer support. A custom issuer remains a configuration
seam, not a support claim.
- Building the full invite-only customer onboarding page in this
  implementation. It is a separate pre-beta requirement; hosted Slack OAuth
  with public installation initiation and operator-controlled activation in PR B2
  is in scope.
- Full self-serve tenant signup/activation, subscription, and billing UI. The
  fixed public OAuth start route and minimal completion/error responses are in scope.
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
  expiresAt: number;
  repositoryId: string;
  repositoryOwnerId: string;
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
coordinates. Retain the response's validated expiry as epoch milliseconds in
the request's access object. Before the video failure-path check update, reuse
that access if more than 60 seconds remain; otherwise reacquire cycle-bound
access. The margin covers bounded GitHub retries after a potentially long Slack
upload. Reuse does not refresh installation status or repository metadata during
the request, and expiry alone does not establish non-revocation. Keep Slack
cleanup independent if fresh authorization fails. Never automatically replay a
comment POST when recovering credentials.

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
testing until the separate invite-only onboarding page is built before beta
launch. PR B2 automatically exchanges Slack installation codes and stores
verified tokens encrypted on the existing backend. This command consumes a
pending installation by ID; the operator does not copy or pass its plaintext token.

Inputs:

- optional existing tenant UUID, otherwise generate one;
- either a B2 pending Slack installation ID, or a legacy/manual bot token read
  from a non-echoing prompt/stdin; reject ambiguous combinations and never accept
  plaintext secrets in command-line flags or log lines;
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

PR B2 handles Slack OAuth approval, code exchange and encrypted pending-token
storage on the hosted backend through the fixed public `/api/slack/oauth/start`
URL.
Starting OAuth requires no operator-issued invitation or application account;
successful installation alone grants no Feature-Rec tenant access. The operator
confirms the verified workspace and supplies the final GitHub/channel pairing.
The later invite-only onboarding follow-up reuses that exchange/validation logic
and the same provisioning operations, and adds the customer-facing flow and
GitHub post-install callback. The GitHub setup callback must not trust its
query-string `installation_id` without user or webhook-backed verification.

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
9. Verify the existing tenant's complete OIDC-to-Slack-to-GitHub cycle.
10. Resume that tenant's runner traffic. Finish PR B2 and the two-tenant smoke
 matrix below before declaring the first observation window complete or
 merging/deploying C.

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

### PR B2 — hosted Slack OAuth installation

Purpose: install the same Slack app in any additional workspace and obtain its
workspace-specific bot token automatically on the existing backend. After the
user approves in Slack, the callback exchanges and stores the token without an
operator running a helper process, setting up a local tunnel, or handling a token
file. Two real tenants are the minimum live isolation test before C, not a
supported-tenant limit. No workspace, tenant, GitHub owner or installation is
hardcoded. One Slack workspace and one GitHub account/installation per tenant
remain the beta cardinality rules; load capacity is a separate validation concern.

Implementation choice for B2: use `@slack/oauth` on the existing Fastify backend.

- Use `InstallProvider` for installation redirects, OAuth state-cookie checks and
  the `oauth.v2.access` exchange. Set `directInstall: true` so the public start
  route redirects directly to Slack, without an SDK landing page. Keep OAuth v2,
  state verification enabled and legacy cookie-less verification disabled.
- Supply small PostgreSQL `StateStore` and `InstallationStore` adapters using the
  single additive table below. The state store generates unpredictable state,
  persists only its hash and atomically claims unexpired sessions. The installation
  store stages only verified, encrypted pending credentials; SDK memory/file stores
  and its runtime `authorize()` path are not used for pending installations.
- Retain a separate unpredictable browser-binding cookie, independent of OAuth
  state, with Secure/HttpOnly/SameSite=Lax and matching expiry. The callback route
  verifies its hash against the matching session before entering the SDK handler;
  `StateStore.verifyStateParam` then atomically claims that session before exchange.
  Do not defer browser-binding validation to `beforeInstallation`, which runs
  after state verification. Keep per-attempt data in request/session context, never
  mutable shared installer fields. The SDK has no SameSite setting: the thin HTTP
  response adapter adds `SameSite=Lax` to its state-cookie header before headers
  are sent, preserving the independent cookie and both cookie-deletion headers.
- Use `afterInstallation` to validate the SDK's normalized `Installation` before
  storage, including the existing `SlackClient.botIdentity()` team/bot-user
  cross-check. Reuse existing encryption and provisioning operations. Any metadata
  used to associate storage with the claimed session is generated by the backend
  and recovered from the state store; it cannot come from installer query inputs.
- Configure a bounded network timeout and
  `clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true }`.
  Supply a logger that drops raw SDK arguments/errors and logs only allowlisted
  safe categories, plus minimal success/failure callbacks and the route-level
  query redaction and response headers specified below. Disabling debug logging
  alone is insufficient. Do not reuse error formatting that includes provider bodies.
- Keep this a thin integration with the existing service. Use supported SDK hooks
  and stores; no Bolt migration, SDK fork, Slack-response body interception or generic
  OAuth framework is required. Add the dependency and lockfile during B2
  implementation and verify the selected version against this contract.

Accepted SDK behavior: one outstanding installation per browser cookie context;
starting a second tab or a callback that clears the state cookie can require a
fresh start. Different browsers and database records remain isolated. Validation
uses the normalized installation object: reject exposed refresh/expiry fields and
enterprise-wide installs, with token rotation disabled in Slack configuration.
The SDK can omit an isolated malformed raw refresh/expiry field during
normalization, so B2 does not promise exhaustive validation of Slack's raw response
envelope. This is an explicit boundary of using the SDK without interception.

Romain selected the SDK on 2026-09-09 after the behavior/guarantee comparison,
superseding the earlier native-HTTP choice. Basis:
[official SDK documentation](https://docs.slack.dev/tools/node-slack-sdk/oauth/),
[configuration options](https://docs.slack.dev/tools/node-slack-sdk/reference/oauth/interfaces/InstallProviderOptions/),
[callback hooks](https://docs.slack.dev/tools/node-slack-sdk/reference/oauth/interfaces/CallbackOptions/)
and [installer source](https://github.com/slackapi/node-slack-sdk/blob/main/packages/oauth/src/install-provider.ts),
checked on 2026-09-09. This selects the implementation approach; it does not
implement or release B2.

One-time app/backend configuration:

- Enable unlisted Slack distribution; Marketplace listing is unnecessary for
 these tests. Keep using the same Slack app and app-level signing secret.
- Configure `SLACK_APP_ID`, `SLACK_CLIENT_ID`, and `SLACK_CLIENT_SECRET` on the
 existing backend. OAuth client credentials are distinct from the signing secret;
 reuse the existing stable token-encryption key and its key-verifier checks.
- Register `https://<backend-host>/api/slack/oauth/callback` in Slack's OAuth
 redirect URLs. Derive the exact redirect URI from the validated public
 `FEATURE_REC_BASE_URL` and this fixed path; use it for authorization and exchange.
 No additional server or callback-hosting service is needed.
- OAuth is disabled when its optional configuration is absent; existing runtime
 flows continue. Partial/invalid configuration fails explicitly. Normal health
 and startup must not require a live Slack call. Do not assume `railway run`
 can retrieve sealed credentials.

Hosted flow and authorization boundary:

1. Expose `GET /api/slack/oauth/start` publicly on the running backend when
 OAuth is configured. Its URL is `FEATURE_REC_BASE_URL` plus this fixed path and
 is the same for every installer in that deployment. A user opens this URL in
 their browser; sharing it directly or linking an Add to Slack button is optional.
 No per-customer URL generation, invitation command, invitation secret or separate
 installation landing page is required. Public access permits starting OAuth
 without an application login or operator invitation; it does not grant Slack
 permissions or pair or activate a tenant.
2. On each start request, create an expiring OAuth session bound to that browser
 with a Secure/HttpOnly/SameSite=Lax cookie, then redirect to Slack's approval flow
 with unpredictable single-use state. The entry URL is fixed; the session secrets
 and Slack authorization redirect are generated for each attempt. Persist only
 hashes of state/browser-binding secrets. For this hosted flow, users begin at
 the start route; callbacks without a valid matching backend-created session are
 rejected. Rate-limit starts and bound
 abandoned-session storage through expiry and cleanup.
3. Request the required bot scopes: `chat:write`, `files:write`, `usergroups:read`,
 `channels:read`, `groups:read`, and `commands`. The user selects the intended
 workspace and approves access. No user-token scopes or GitHub OAuth are added.
4. `GET /api/slack/oauth/callback` validates state, browser binding and expiry,
 rejects denial/missing code and repeated callbacks, and atomically claims the
 session before exchanging the code through `oauth.v2.access`. Use the configured
 client credentials and exact registered redirect URI. OAuth callbacks use state
 and browser binding, not the signature check for Slack event/command requests.
 Never blindly retry an ambiguous exchange; an interrupted/uncertain attempt
 requires fresh authorization rather than replaying a potentially spent code.
5. Validate the SDK's successful normalized installation: configured app ID,
 workspace identity, bot token type, bot user ID and granted scopes; cross-check
 the returned team and bot user identity with `auth.test`. There is no
 invitation-bound expected team: derive the team ID from verified Slack responses,
 never callback parameters or an optional workspace-selection hint. The operator
 confirms this workspace before provisioning. Require token rotation disabled;
 reject refresh/expiry fields exposed by the SDK, unexpected user tokens and
 enterprise-wide installations. Do not silently treat these as workspace bot
 installations. The normalized-response boundary above applies; B2 does not
 independently parse the raw exchange response.
6. Encrypt the verified pending bot token in PostgreSQL using the existing
 stable key and verified team ID as AAD. The existing backend serves a minimal
 sanitized completion page stating that the Slack app is installed and Feature-Rec
 activation is pending operator provisioning. Include the opaque pending
 installation ID and verified workspace ID for operator handoff. This completion
 response requires no separate frontend application or onboarding website.
 These identifiers grant no token access or provisioning authority. Bot tokens, ciphertext,
 client secrets and OAuth response bodies never appear in browser output, URLs,
 normal CLI output or logs. OAuth necessarily carries code/state in protocol
 redirect/callback URLs; never display them on completion pages, log them or
 persist their raw values. Redact full query strings on start/callback routes;
 use no-store/no-referrer responses and no third-party content on these pages.
7. The operator confirms the pending record's verified workspace, invites the bot
 to the intended channel, then calls existing
 `provision-tenant` with a new `--slack-installation-id` token source plus GitHub
 installation/repository and channel inputs. Fetch/decrypt the pending token
 internally and reuse existing Slack/GitHub validation, encryption, uniqueness
 and re-pairing guards. Only successful provisioning enables the tenant; callback
 parameters cannot choose tenant IDs, GitHub pairings, channels or replacement
 mode. Keep the existing manual-token input path for compatibility.
 Pending tokens are available only to installation validation and provisioning;
 runtime handlers continue to require an enabled, paired tenant and must not use
 staged credentials to run reviews, change tenant settings or access GitHub.
8. Consume the pending installation and clear its staged ciphertext in the same
 transaction as final integration writes and tenant activation. Concurrent
 provisioning attempts must not consume it twice. Validation/transaction failure
 leaves a bounded, retryable pending installation and existing tenants unchanged;
 a lost success response is recoverable by inspecting the sanitized record status.
 Reinstallation must not replace an active tenant's token before its explicit
 provisioning validation succeeds.
 Keep environment/confirmation checks on provisioning writes. Provide read-only
 admin inspection of installation ID, verified team/bot IDs, expiry, lifecycle
 status and consumed result identifiers for pairing and lost-response recovery;
 do not expose a public installation listing or token-retrieval endpoint.

Persistence and release boundaries:

- Add `0009_slack_oauth_installations`, containing a narrowly scoped pending
 installation/session table: opaque ID, hashed state/browser binding,
 expiry and lifecycle/claim fields, verified workspace/bot IDs,
 encrypted pending token, and consumed result identifiers. These are temporary
 OAuth-session states, not generic lifecycle columns on active integrations.
- Use the shared database for atomic session claims and consumption across replicas.
 Normal restarts preserve unexpired unclaimed sessions and completed exchanges.
 A crash during a claimed external exchange must surface a fresh-authorization
 path; never imply exactly-once execution of Slack's external API.
- Enforce expiry during every claim/provisioning operation; expired records may
 be inspected only as sanitized status and may never be consumed. Provide bounded
 cleanup for expired/consumed records and ciphertext, and rate-limit the public
 OAuth entry points to bound session/pending-record growth. Installations in
 different browser cookie contexts and database records stay independent. Invalid
 callbacks must not claim or mutate an unrelated database session. Within one
 browser cookie context, accept the SDK restart behavior described above.
- B2 retains all B legacy reads/writes and registers only through its new additive
 `0009`. It does not include C's enforcement or D's contract migration. Since C
 is unshipped, rename its enforcement migration to `0010_multitenant_enforce` and
 reserve `0011_multitenant_contract` for D when integrating the implementation.
 Update static providers, fixtures, rollback tests and runbooks together. Do not
 renumber already applied production migrations; verify the deployed version
 before applying this sequence.
- B2's down migration removes only its pending-installation storage. Before
 B2-to-B rollback, stop new installations, back up and explicitly cancel pending
 sessions, then migrate down using B2 before redeploying B. Active provisioned
 tenants/tokens remain in the existing tables. C-to-B2 retains OAuth storage.

Acceptance and release gate:

- Test that the same fixed start URL redirects directly to Slack for different
 installers without invitations, application login or an SDK landing page, with
 independent records and unpredictable state for each attempt. Test rate
 limiting/cleanup, expiration, denial, missing code, wrong app or inconsistent
 workspace/bot identities across the normalized installation and `auth.test`,
 missing scopes, malformed normalized fields, exposed refresh/expiry fields,
 unexpected user tokens, enterprise-wide installs and secret-free output/logging.
- Verify that possession of callback code/state and a reconstructed SDK state
 cookie alone cannot claim a session without the independent browser secret.
 Exercise actual SDK handler ordering, cookie attributes and clearing; a failed
 browser check must occur before the atomic claim. Cover same-browser second-tab
 and invalid-callback restart behavior without affecting other database records.
- Verify that transient/network and rate-limit failures do not retry code exchange,
 and that SDK errors/debug paths cannot log raw URLs, credentials or responses.
 Pin the normalized-response validation boundary in coverage; do not claim to
 inspect fields the SDK discards.
- Verify sanitized completion/status exposes the installation ID and verified
 workspace for operator handoff. Unpaired installations and forged callback
 tenant/GitHub/channel/replacement inputs must never activate service access,
 trigger product workflows or replace an active integration.
- Test simultaneous independent installations, duplicate callback races, replica
 handoff and restart, ambiguous code-exchange failure, pending-token expiry,
 failed provisioning/retry, atomic consumption, and same-team reinstall isolation.
- Include at least three distinct workspace/GitHub-owner pairs in automated
 coverage. Adding another tenant uses the same routes and configuration; no
 special first/second-tenant path or total-tenant cap is introduced.
- Verify migration forward/down/forward and older-artifact ordering, compiled
 admin commands, and backend startup/health with OAuth configured and disabled.
- Install the same app in at least two real workspaces through hosted callbacks,
 provision distinct tenants, and complete the end-to-end smoke matrix below.
- Complete B's observation checks, require a clean
 `validate-contract-readiness --require-future-cycle-keys` report, and retain a
 fresh backup before merging/deploying C. Record evidence rather than relying
 only on elapsed time.

Deliverables are backend routes, shared-database session/token persistence,
compiled provisioning/status operations, focused tests and the one-time Slack configuration /
install / provisioning runbook. Full customer onboarding UI, public signup,
GitHub setup callbacks and automatic tenant activation remain outside B2.
No separate installation landing page or Add to Slack button UI is required;
keep the minimal backend-served callback completion/error responses.

Preserve the already implemented C work on its own branch. Prepare B2 from the
deployed B baseline, then integrate it into C and update the unshipped migration
names above. C development/review can continue in parallel; its merge/deploy is
gated on B2 and the first two-workspace observation/readiness gate.

#### B2 development milestones

These seven milestones build on earlier completed work; each has its own
verification gate. The later reliability milestone adds cross-cutting coverage
rather than postponing checks for earlier work. Follow the detailed B2 contract
above throughout.

1. **SDK setup and configuration (implemented 2026-09-09).** Add `@slack/oauth` to the existing backend,
   configure client credentials and the fixed redirect URI, and establish safe
   logging, bounded timeouts and disabled retries.
   **Verify:** the service builds; startup/health needs no live Slack call; absent
   OAuth configuration disables the feature and partial/invalid configuration fails.
2. **Persistent installation storage.** Add B2 migration `0009` and storage
   operations for hashed session secrets, atomic claims, encrypted pending tokens,
   expiry, consumption and bounded cleanup.
   **Verify:** seeded database tests pass for duplicate/expired claims, encryption
   and ciphertext cleanup; migration forward/down/forward preserves active tenants.
   Keep C/D migration renumbering within the integration boundary specified above.
3. **Public installation start.** Implement the fixed start route using the SDK's
   direct redirect, fresh state, independent browser binding, the cookie-header
   adapter and rate limiting.
   **Verify:** HTTP tests observe the Slack redirect, required scopes and both
   cookies' security attributes; attempts get distinct state and excess starts
   are limited without modifying existing sessions.
4. **OAuth callback and pending installation.** Verify browser binding, let the
   SDK claim state and exchange the code, validate its normalized installation,
   cross-check Slack identity, and stage the encrypted token with a safe completion
   response.
   **Verify:** actual SDK handlers against fake Slack endpoints produce one pending
   record on success; invalid, expired or replayed callbacks cannot stage tokens;
   identity/scope/token-model checks, cookie cleanup and secret redaction pass.
5. **Operator provisioning and status.** Extend `provision-tenant` with
   `--slack-installation-id` and add sanitized status inspection. Reuse existing
   pairing checks and atomically activate the tenant, consume the installation and
   clear its staged ciphertext; retain manual-token input.
   **Verify:** compiled CLI tests cover successful activation, unchanged tenants
   after validation/transaction failures, retryable pending records, status-based
   recovery and the existing manual-token path.
6. **Concurrency, recovery and tenant isolation.** Exercise the complete flow
   across replicas/restarts, concurrent callbacks/provisioning, reinstalls and
   interrupted exchanges, including the accepted SDK browser-restart behavior.
   **Verify:** tests with at least three workspace/GitHub pairs prove single
   consumption, no automatic exchange retries, no cross-tenant effects or staged
   token use by runtime handlers, and safe recovery without secret leakage.
7. **Live verification and release readiness.** Complete the configuration and
   operations runbook, packaged-image checks, rollback rehearsal and hosted
   installation/provisioning in two real workspaces.
   **Verify:** both tenants pass the end-to-end smoke matrix; record migration/
   rollback and observation evidence, a clean contract-readiness report and a
   fresh backup before allowing C to merge/deploy. Keep C's existing work separate
   and verify its migration renumbering when integrating B2.

### PR/deploy C — enforce and stop legacy dependency

Only after PR B2, the real two-workspace smoke, the first observation window,
a clean readiness report, and a fresh backup, release:

`0010_multitenant_enforce`:

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

`0011_multitenant_contract`:

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
start while the database records `0011`, however; Kysely rejects an executed
migration missing from that binary's static provider. D-to-C therefore requires
rolling the database back to `0010` with deploy D's admin command before
redeploying C.

Do not put migrations 0008 through 0011 into one automatically deployed artifact.
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
- B2 to B: cancel pending installations and migrate to
  `0008_multitenant_expand` using artifact B2 before starting B.
- C to B2: migrate to `0009_slack_oauth_installations` using artifact C.
- C to original B: after the pending-installation precautions, migrate to
  `0008_multitenant_expand` using artifact C; this also removes B2 session storage.
- D to C: migrate to `0010_multitenant_enforce` using artifact D.
- D to B2: migrate to `0009_slack_oauth_installations` using artifact D.
- D to original B: after the pending-installation precautions, migrate to
  `0008_multitenant_expand` using artifact D. Rolling farther
  back to A requires the singleton reverse-data validator or a backup restore.

PostgreSQL transactional DDL and Kysely's migration lock/bookkeeping make each
step atomic. Give constraints stable explicit names so `down()` can target them,
and use `if exists` on destructive drops where Kysely supports it. A later
roll-forward reruns `up()` normally after the corresponding migration record was
removed. Test every forward/down/forward path; do not treat `down()` as ceremonial.

### Autodeploy and PR topology

Use five PRs because each merge autodeploys:

1. PR A: expand migration, compatibility behavior, compiled admin tooling.
2. PR B: OIDC/multitenant cutover, with legacy writes retained for its observation
   window.
3. PR B2: hosted Slack OAuth and additive `0009_slack_oauth_installations`;
   obtain pending workspace tokens automatically and complete the first
   two-tenant validation gate using existing controlled provisioning.
4. PR C: enforce constraints and stop every legacy read/write after B2 passes.
5. PR D: contract migration and final cleanup.

Do not put a later wave's migration in an earlier PR. In particular, C and D
must be separate because C must be healthy and observed before D drops schema.
B2 must also exclude C's migration and legacy-removal changes. Rebase/integrate
the already prepared C work after B2 without collapsing their release gates.
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

### PR B2 hosted Slack OAuth and runbook

- Add installation-start and callback routes to the existing Fastify service
 with `@slack/oauth` and validated optional configuration. Follow the B2
 implementation choice above: thin Fastify integration, PostgreSQL state and
 pending-installation stores, independent browser binding, safe logging and
 responses, and disabled exchange retries. Reuse existing Slack identity checks,
 encryption and provisioning code.
- Add `0009_slack_oauth_installations`, storage claim/consume/expiry operations,
 and integration with existing token encryption/key verification.
- Extend existing `provision-tenant` to consume an installation ID atomically and
 provide sanitized read-only installation inspection in the compiled admin CLI.
 Opening the fixed public start URL needs no admin command. Reuse the provisioning
 transaction/guards; do not create a second integration-writing implementation.
- Add provider-fake HTTP/storage/admin tests for B2 acceptance and image smoke.
- Update `docs/setup-and-operations.md` with backend client credentials, exact
 Slack redirect URL, fixed public start URL, pending-installation ID handoff,
 cleanup and migration-aware rollback. No local callback server/tunnel/token file.
- When integrating C, rename its unshipped enforcement to `0010` and update
 providers/test fixtures/runbooks; leave D's contract for `0011`.

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
- Exercise `0008`, B2 `0009`, C `0010`, and D `0011` in forward/down/forward
  order and verify
  both schema and Kysely migration-table state after each step.
- Verify the compiled admin command exits nonzero on migration error or an
  unexpected current migration and never deploy the older fixture first.
- Slack workspace deletion explicitly removes channel settings before `0010`
  and remains idempotent with the cascade after `0010`; tenant/cycles remain and
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
- Video failure cleanup reuses request-local access above the 60-second expiry
  margin even if minting is unavailable, and obtains fresh access at/below the
  margin. Failed reauthorization leaves the stored failure and independent
  Slack cleanup intact.
- Grant expiry must be a valid future timestamp; missing/malformed/expired
  expiry responses produce a safe provider error.
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
2. Open the same fixed B2 start URL for each additional Slack workspace and
 complete Slack approval and the callback. Provision by pending installation ID
 and select different channels.
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

- PR B2 accepts public installation initiation without invitation issuance;
 protected OAuth sessions and Slack approval remain required. It automatically
 exchanges each installation code and stores the verified
 workspace bot token encrypted on the existing backend. Existing provisioning
 consumes an opaque installation ID without operator plaintext-token handling.
- There is no fixed total-tenant cap or per-tenant backend code/configuration
 change; two real tenants are the minimum live isolation test.
- At least two tenants work concurrently from one backend and database before
 C is merged/deployed; C implementation alone does not satisfy this gate.
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
- Deploy C can roll back to B2 only after artifact C migrates to B2's `0009`;
  rollback to original B requires removal of pending OAuth storage too, down to
  `0008`. Deploying either older artifact first is a tested startup failure.
- Deploy D can roll back to C only after artifact D migrates the database down to
  `0010`; deploying C first is a tested startup failure.
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
integration-writing logic. Reuse B2's hosted OAuth routes, durable state, and
encrypted pending-installation handling. Customer-facing invite management, page
UX, GitHub connection and the orchestration of final provisioning belong in a
separate reviewed plan; the basic hosted Slack callback is delivered in B2.

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
  migration. The 2026-09-08 B2 amendment adds a fifth PR; the original four
  schema/runtime waves remain separate.
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
  Updated 2026-09-08: B2 adds an operator-tooling PR between B and C.
- Describing onboarding UI/OAuth as deferred beyond beta contradicts the launch
  scope. The invite-only page is a separate pre-beta requirement, while this
  implementation deliberately stops at temporary operator provisioning. Updated
  2026-09-08: B2 includes the operator Slack OAuth helper; the full UI remains
  separate.

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
- Resolved, then refined below: video failure cleanup previously reused access
  obtained before an unbounded Slack upload. The initial fix reacquired access
  for the cycle before updating the check; regression coverage simulated expiry
  during delivery and failed reauthorization without blocking Slack cleanup.
- Coverage follows the remaining paths: repeated grants, rejection after prior
  success, safe provider failures, and recovery. Cache-listing `total_count` and
  post-eviction cases no longer exist. Same-request content-mismatch reminting
  and concurrent duplicate-mint optimization are explicitly out of scope.

## PR B request-local expiry refinement (2026-09-07)

- User decision: avoid unconditional token minting during video failure cleanup.
  Retain the grant's validated expiry within the request, reuse access while more
  than 60 seconds remain, and reacquire otherwise. There is no shared token cache.
- Accepted tradeoff: reuse does not recheck installation status or refresh
  repository metadata during delivery. It avoids making cleanup depend on a
  fresh mint while the original access still has sufficient remaining lifetime.
- Regression coverage includes healthy-token reuse during a mint outage, both
  sides of the expiry margin, expiry during delivery, invalid grant expiry, and
  failed reacquisition with independent Slack cleanup.

## PR B2 sequencing amendment (2026-09-08)

Historical first proposal: the local-helper topology below is superseded by the
hosted B2 revision that follows. The B2-before-C and many-tenant requirements remain.

- User decision: add the minimal Slack OAuth installation helper as PR B2 before
 releasing C; the full invite-only onboarding UI remains a separate pre-beta task.
- Resolved plan gap: the earlier B smoke assumed a second workspace token was
 already available while all OAuth handling was deferred. B2 now covers the
 installation approval/code exchange and secure operator token handoff.
- Resolved sequencing gap: C is implemented but must not autodeploy before B2,
 the real two-workspace smoke, observation/readiness, and fresh backup. Preserve
 the existing C work and integrate it after B2; no C migration ships in B2.
- Resolved scope ambiguity: the helper is a one-shot operator process, not a
 public callback that displays tokens or automatically provisions arbitrary
 tenants. Installation handling does not grant Feature-Rec service access.

- User clarification: support arbitrary additional tenants through the same
 repeatable B2 flow; two is only the minimum live isolation test. Added automated
 three-or-more-tenant coverage, explicit absence of hardcoded identities or a
 two-tenant cap, and the distinction between manual onboarding and load capacity.


## PR B2 hosted OAuth revision (2026-09-08)

Historical revision: its operator-issued installation-link requirement is
superseded by the 2026-09-09 simplification below; hosted OAuth and controlled
tenant activation remain.

- User decision: use the already running backend for OAuth. Replace the temporary
 local helper with hosted start/callback routes, one-time Slack configuration,
 automatic code exchange and encrypted token storage. No additional server,
 per-install helper process, local tunnel or token file is needed.
- Resolved persistence gap: callback state and pending tokens must survive normal
 restarts and replica changes. Add B2 migration `0009_slack_oauth_installations`;
 the earlier no-migration promise is superseded. Rename the unshipped C/D
 migrations to `0010`/`0011` during implementation integration; this amendment
 does not rename or otherwise modify the existing C code.
- Resolved authorization gap: operator-issued expiring installation links and
 browser-bound single-use state authorize OAuth; callback parameters never pair
 GitHub, overwrite another tenant or activate service access.
- Resolved token-handoff gap: the backend retains only encrypted pending tokens;
 the existing provisioning transaction consumes them by opaque ID and validates
 both integrations before enabling the tenant. A failed/repeated request cannot
 lose another tenant's token or double-consume the pending installation.
- Resolved rollback gap: B2-to-original-B cancels pending installs and migrates
 down before restoring B; C-to-B2 retains OAuth storage. Historical C `0009` and
 D `0010` references in earlier review notes describe the superseded numbering.
- Many-tenant support, at least three automated tenants, the real two-workspace
 test before C and the later full onboarding UI remain unchanged in scope.

- Resolved review wording issue: OAuth protocol URLs necessarily carry temporary
 code/state. Prohibit their display, logging and raw persistence, with callback
 query redaction and no-store/no-referrer responses; bot tokens and client
 secrets remain prohibited in URLs and browser output entirely.

## PR B2 public installation simplification (2026-09-09)

User decision: simplify installation initiation to a public Add to Slack link for
now. Remove operator-issued invitations while retaining protected OAuth,
encrypted pending tokens and explicit operator pairing/activation. This updates
the design only; it does not implement or release B2 or alter C's existing work.

Resolved issues from checking the simplification:

- The prior flow required invitation issuance, redemption and hashed invitation
  storage. Removed those requirements and the invitation-issuing admin command;
  the public start route now creates the OAuth session directly.
- Expected workspace validation depended on the removed invitation. The callback
  now verifies the configured app and cross-checks Slack-returned workspace/bot
  identities; the operator confirms the intended workspace before pairing.
- The operator previously received the record ID at invitation creation. The
  sanitized completion page now supplies the pending installation ID and verified
  workspace, with read-only admin inspection for pairing and recovery.
- Public initiation needs bounded resource use. Retained session/pending expiry
  and cleanup, added rate-limiting acceptance coverage, and kept independent
  sessions and atomic callback claims across replicas.
- A pending Slack token already carries Slack permissions. Explicitly restricted
  staged-token use to validation/provisioning; unpaired installs cannot activate
  product workflows, select GitHub pairings or mutate active tenant settings.
- Reinstallation and concurrent provisioning must not overwrite active tokens or
  consume a pending installation twice. Retained the existing provisioning guards,
  atomic activation/consumption, retry behavior and manual-token compatibility.
- Updated active scope, persistence, deliverables and acceptance wording together;
  marked the previous invitation requirement as historical. The later full
  customer onboarding UI and existing release gates are outside this amendment.

## PR B2 installation wording clarification (2026-09-09)

User requested precise design wording after “publish a reusable Add to Slack
link” suggested a generated invitation or separate webpage. This is a wording
clarification of the accepted public-initiation design, with no behavior change.

Resolved wording issues:

- “Publish a reusable link” implied a separate publishing or link-generation task.
  The flow now specifies one fixed public backend start URL per deployment;
  sharing that URL or adding a button is optional.
- A fixed entry URL could be confused with reusable OAuth state. The start route
  generates a fresh protected session and Slack authorization redirect for each
  attempt; callbacks still require the matching session.
- “Public” could imply permission to use Slack or Feature-Rec immediately. The
  text distinguishes starting OAuth from Slack approval and operator-controlled
  pairing/activation.
- “No separate webpage” could contradict the completion response. No installation
  landing page or separate frontend is required; the existing backend still
  serves the sanitized completion page with the installation ID and activation
  status. Scope wording now distinguishes these minimal responses from the
  deferred self-serve tenant signup/activation UI.

## PR B2 minimal implementation choice (2026-09-09)

Historical decision: superseded by the SDK adoption below. This section records
why native HTTP was originally proposed; it is not the active B2 approach.

User direction: “It should be as simple as possible.” For the current service,
choose two Fastify routes and a small direct OAuth exchange module, reusing the
existing Slack client, database, encryption and tenant provisioning. This is a
design decision; no B2 implementation or dependency change is made by this edit.

Resolved implementation-selection issues:

- The plan named a focused OAuth module without selecting a concrete approach.
  It now specifies the existing native-HTTP stack and no `@slack/oauth` dependency
  for B2; the library was an evaluated option, not an earlier accepted choice.
- Assuming the SDK removes all custom handling would hide adaptation work. Its
  custom state/store hooks remain necessary for durable claims and staging; its
  callback normalizes token responses, exposes only part of its identity check,
  and has different cookie cleanup behavior. A small direct flow keeps these
  required checks in one place without interception or overrides.
- The existing Slack error formatter may include provider detail. The OAuth
  module must sanitize errors at its boundary while reusing identity validation,
  encryption and provisioning; standardizing unrelated Slack calls is outside
  this change.
- Simplicity must not accidentally remove the accepted activation boundary.
  Public initiation, protected single-use sessions, encrypted pending tokens,
  operator pairing and atomic activation remain as specified above.

## PR B2 library complexity reassessment (2026-09-09)

Historical review: resolved by the SDK adoption below.

Review issue at the time: the native-HTTP choice above was justified by preserving
every specified implementation detail, not by a comparison demonstrating the simplest
way to meet the product requirements. Custom pending storage and provisioning
are needed with either approach and do not themselves count against the SDK.

Assessment: `@slack/oauth` would probably simplify the standard OAuth portion if
we accept its supported session and normalized-response behavior, while retaining
database-backed single-use state, encrypted pending tokens and operator activation.
Matching every current raw-response/cookie requirement would add adaptation work.
The SDK recommendation is an estimate from source inspection, not a measured
implementation comparison. Reconsider the native-HTTP choice; a switch would
need to update the affected requirements explicitly. No switch is made by this
review note.

## PR B2 SDK behavior and guarantee comparison (2026-09-09)

Historical comparison: the subsequent SDK adoption below records the accepted
behavior and retained protections.

Review issue at the time: adopting stock SDK browser behavior is not solely an
internal refactor. Its cookie contains OAuth state itself. If this replaces the planned
independent browser-binding secret, a holder of a valid full callback URL could
reconstruct the expected cookie and attempt to claim the session from another
client (inference from the inspected SDK implementation). Atomic single-use state
would still allow only one claim, and completion still exposes no token or tenant
activation. Keep independent browser binding through route/hook logic if retaining
the stronger URL-leakage guarantee.

Other explicit tradeoffs if using stock SDK behavior:

- One state cookie per browser means starting another installation can invalidate
  an earlier tab; an invalid state callback can also clear the ongoing cookie.
  The user may need to restart. This does not require weakening cross-tenant or
  database-consumption guards.
- Validating only the normalized installation object cannot enforce rejection of
  every malformed raw expiry/refresh-token shape. Normal supported response fields
  remain checkable; a standalone expiry field can be lost during normalization.
- Keep Secure/HttpOnly and an explicit SameSite policy, safe logging/response
  headers, disabled exchange retries (including rate-limit retries), verified
  app/team/bot/scopes and the auth.test cross-check. These can be retained with
  configuration and application integration rather than accepted as losses.
- Keep database-backed atomic state claims, encrypted pending storage, expiry,
  operator-only pairing and atomic activation/consumption through the SDK's custom
  state/installation-store hooks and existing provisioning operations. Defaults
  alone do not implement these guarantees.

This comparison records possible behavior changes; it does not approve relaxing
any guarantee or switch the implementation choice. Basis: official SDK source
and documented customization options inspected on 2026-09-09.

## PR B2 SDK adoption (2026-09-09)

User decision: “Yeah let's use the sdk then.” Use `@slack/oauth` for B2's hosted
OAuth flow. This supersedes the native-HTTP implementation choice; the fixed
public start URL and operator-controlled tenant activation remain the product flow.
This amendment changes the design only, not dependencies, runtime code or release
status.

Resolved issues from reviewing the switch:

- The active implementation and deliverables still prohibited the SDK. They now
  select `InstallProvider`, `directInstall: true`, supported hooks and small
  PostgreSQL adapters; previous choices/reviews are explicitly historical.
- SDK state alone does not preserve independent browser binding. Retain the
  separate secret and validate it before the SDK's state-store claim; the
  `beforeInstallation` hook is too late for that check. Keep request/session data
  isolated and preserve both cookies' policy and cleanup headers.
- Stock cookie behavior conflicts with the previous blanket promise that all
  concurrent installations stay usable. Accept same-browser restarts while
  retaining isolation across browser contexts and database records.
- Normalized installation objects cannot expose every malformed raw token field.
  Validate their supported fields and cross-check app/team/bot/scopes, reject
  exposed refresh/expiry and user tokens plus enterprise-wide installs, and require
  rotation disabled. Explicitly narrow exhaustive raw-envelope validation instead
  of adding a fork or response interception to reproduce it.
- Default SDK stores, retries, logging and completion pages do not implement this
  application's contract. Specify encrypted pending storage, atomic state claims,
  both no-retry settings, safe logger/callbacks, query redaction and response headers.
- SDK installation completion must not activate tenants or replace active tokens.
  Keep operator provisioning and its existing validations, uniqueness/re-pairing
  guards, pending expiry and transactional activation/consumption. Scope acceptance
  checks to the retained guarantees and explicitly accepted SDK behavior.
- The SDK has no SameSite option. Clarify that the HTTP response adapter adds
  `SameSite=Lax` to its outgoing cookie header before transmission and preserves
  both cookies during creation/cleanup. This does not intercept Slack's response
  body or require an SDK fork.

## PR B2 development milestones (2026-09-09)

At Romain's request, break B2 into seven sequential milestones with independent
verification gates: SDK/configuration, storage, public start, callback/staging,
operator provisioning/status, concurrency/recovery/isolation, and live release
readiness. This organizes the accepted design; it does not change scope or mark
implementation complete.

Resolved planning clarifications:

- Each milestone verifies its own deliverable; the sixth adds cross-cutting
  coverage instead of deferring earlier tests.
- Storage includes bounded cleanup and ciphertext removal; cookie integration
  includes both setting and clearing headers through actual SDK handlers.
- Live verification retains the existing B2-before-C release gates and migration
  integration boundaries.


## PR B2 milestone 1 implementation (2026-09-09)

Restored the B2 planning amendment saved in the branch-setup stash; the stash is
retained. Implemented only SDK setup/configuration on `feat/oidc-multitenancy-pr-b2`.

- Added `@slack/oauth` 4.0.0 through pnpm with the lockfile. The installer factory
  requires state/installation adapters, uses OAuth v2 with direct installation and
  state-cookie checks, and sets a ten-second network timeout with ordinary and
  rate-limit retries disabled. Its logger drops raw SDK arguments and emits fixed
  warning/error categories.
- Added all-or-none `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
  validation and callback derivation from the normalized backend URL. Absent/all-empty
  credentials disable configuration; partial/invalid credentials fail without
  including supplied values. Updated environment examples and operations guidance.
- Verified workspace typecheck and lint, service build, existing PostgreSQL-backed
  service selftests, and the focused real-SDK selftest. The latter covers direct
  redirects/scopes, custom stores, state-cookie rejection, no exchange retries for
  network/503/429 failures, timeout cancellation, and secret-free logging.
- Built the production image and checked packaged SDK import, compiled admin help,
  startup/health with OAuth absent and configured, and rejection of partial config
  against an isolated local database. Focused tests assert no network calls during
  SDK construction and health checks.

Public OAuth routes, independent browser binding, persistent storage, callback
validation/staging, and provisioning remain subsequent milestones. No migration
was added, no C changes were integrated, and B's legacy compatibility writes remain.
No production configuration, installation, or release was performed.
