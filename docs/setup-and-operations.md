# Setup and operations

This guide covers connecting GitHub and Slack, configuring reviews, running the
backend, and operating a hosted deployment. For the product overview, repository
structure, renderer quickstart, and development checks, see the [README](../README.md).
Run repository commands below from the repository root unless stated otherwise.

- [Repository onboarding](#onboarding-a-repository)
- [GitHub App](#github-app) and [Slack App setup](#slack-app-setup)
- [Channel routing](#channel-routing) and [slash commands](#slash-commands)
- [Local backend](#local-demo-backend)
- [Production image](#production-image) and [Railway deployment](#railway-deployment)
- [Backup and rollback](#backup-rollback-and-migration)
- [OIDC cutover](#oidc-cutover-checklist) and [tenant provisioning](#provision-a-tenant)
- [Integration smoke checks](#smoke-checks)

## Onboarding a Repository

Internal testing uses operator-assisted onboarding, with no repository configuration file:

1. Install the [GitHub App](#github-app) on the repository.
2. Install the [Slack app](#slack-app-setup) in the customer's workspace and
   [provision the tenant](#provision-a-tenant) using the compiled admin command. A tenant owns exactly one connected GitHub account/installation and one Slack workspace.
3. Copy [`examples/feature-rec-workflow.yaml`](../examples/feature-rec-workflow.yaml) to `.github/workflows/feature-rec.yaml`, replace its
   `@main` action reference with a tested immutable OIDC revision when rolling out to consumers, grant `permissions: id-token: write`,
   and add the `ANTHROPIC_API_KEY` secret for live scene generation.
4. Invite `@Feature-Rec` to the Slack review channel.

Opening a PR with a frontend-visible change then posts the validation video and buttons in that
channel. Legacy `.github/feature-rec-config.yaml` files are ignored; delete them at leisure.
The action uses the hosted backend by default. Self-hosted deployments set the optional `api-url`
action input to their own public origin.

Every backend call uses a fresh GitHub Actions OIDC token. Verified repository owner and repository
IDs select the enabled tenant and a repository-scoped GitHub App token. A shared runner secret and
caller-provided repository names cannot authorize requests. The invite-only OAuth onboarding page
is a separate requirement before external beta launch.

The development example currently retains `@main`; no Feature-Rec runner workflow is active yet.
The pre-cutover pinning step applies when active consumers exist. The retired runner secret is absent
from the example.

Runner JWTs are verified before request bodies are read, so a token that expires during a long video
upload does not invalidate that upload. Live tenant/repository authorization still runs after buffering,
just before any state change. OIDC/provider authorization and PR reads make up to three attempts
on transient failures; mutation endpoints are never replayed wholesale. Provider rate-limit waits return `503`
with `Retry-After`. Invalid JWTs return `401` with a safe reason category in service logs; denied grants
return `403`, while permanent GitHub API errors return `502`.

A failed GitHub approval check leaves the cycle pending and replies to a button click ephemerally.
Modal authorization has a two-second deadline; errors and timeouts keep the comment in the modal for
retry. Timed-out preparation performs no later state change.

Every caught video-delivery error attempts to mark the owned pending cycle as failed in the backend.
Workspace/channel problems retain their specific messages; unexpected failures use a generic delivery
message with details in service logs. After the database transition, GitHub check updates and cleanup
of any known Slack validation message run independently with bounded retries. `settled: true` means
the cycle is failed even if provider cleanup could not finish; rerun the workflow to take over that
failed cycle. Concurrent approvals or supersessions are preserved. Database outages and process
crashes can still prevent settlement and require recovery.

Require the `Feature-Rec` Check Run in branch protection; the workflow job can finish
while that check waits for a Slack decision. Approval posts a PR comment mentioning
the author. `Needs changes` requires feedback in a Slack modal, posts it to the PR
Conversation mentioning the author, and concludes the check as `action_required`.
The check name, button labels, and PR comment templates are fixed.

Without `ANTHROPIC_API_KEY`, Feature-Rec only auto-accepts diffs that do not look
frontend-visible. To use the conservative filename-based fallback for frontend-looking
diffs, set `FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER=1`. A frontend-visible change with
no extractable TSX/JSX source fails clearly instead of producing a non-UI summary video.

Teams that previously restricted approvers through the removed YAML config run
`/feature-rec approvers @<usergroup>` once; until then, anyone in the channel can approve.
See [slash commands](#slash-commands) for the configuration rules.

## GitHub App

Create a GitHub App with:

- Checks: read/write
- Pull requests: read/write
- Issues: read/write
- Contents: read
- Metadata: read

Pull request write access is required for the approval and rejection comments that Feature-Rec posts
to the PR conversation. If you add or increase permissions after installing the App, approve the
updated permissions on the existing installation (or reinstall the App). The next operation mints
an installation token with the new grants; no backend restart is needed.

Set local env vars:

```bash
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----...'
```

Feature-Rec is driven by the GitHub Action. The backend does not consume GitHub webhooks.

All service GitHub calls use the tenant's GitHub App installation and a repository-scoped token.
Each logical operation mints fresh access scoped to the repository ID and validates the returned
repository ID, owner, and current name. Tokens and repository metadata are not cached across
operations; renames need no data edit or process restart. Within a video request, the service retains
the token's reported expiry. Failure cleanup reuses that access when more than 60 seconds remain,
allowing time for the bounded check-update retries, and reacquires access otherwise. Reuse avoids an
extra token request but does not refresh installation status or repository metadata during delivery.
Provider outages and rate limits remain temporary failures.

## Slack App Setup

Create a Slack App with bot scopes:

- `chat:write` — post validation messages and the first-channel greeting
- `files:write` — upload the demo video
- `usergroups:read` — resolve usergroup handles and expand approver groups
- `channels:read` — list the bot's public-channel memberships (routing)
- `groups:read` — same for private channels
- `commands` — added automatically with the `/feature-rec` slash command; must be
  listed explicitly in the OAuth scopes when the app is distributed

`channels:read` and `groups:read` also cover the `conversations.members` checks used
when changing mentions or approvers, so explicit channel selection adds no OAuth
scope and does not require reinstalling an already configured app. `im:read` and
`mpim:read` are not required because routing requests only `public_channel` and
`private_channel`; slash-command replies from DMs use their `response_url` instead
of reading the conversation. Slack's `views.open` method requires no OAuth scope.

Configure, replacing `<host>` with the public backend origin (or the ngrok host locally):

```text
Interactivity Request URL: https://<host>/api/slack/interactivity
Event Subscriptions Request URL: https://<host>/api/slack/events
Slash command: /feature-rec -> https://<host>/api/slack/commands
```

- Subscribe the events URL to `member_joined_channel`, `app_uninstalled`, and `tokens_revoked`, and
  enable **Delayed Events**: after Slack's immediate/1 min/5 min retries, delivery retries hourly
  for 24 hours, and apps below 1,000 events per hour are exempt from auto-disable, so a temporarily
  down backend cannot lose the subscription. A missed first join can be repaired automatically
  only when the bot has exactly one channel membership; otherwise use the channel command.
- On the `/feature-rec` slash command, enable **Escape channels, users, and links sent to your
  app** so channel and user mentions arrive with stable `<#C…>` and `<@U…>` ids. Plain channel
  names are intentionally not resolved.
- Reinstall the app after changing scopes. When upgrading a live install, update the Slack app
  first and deploy the service second: the new grants sit unused until the deploy, so no
  `missing_scope` window exists. If deployed backwards, `missing_scope` surfaces through the same
  check-run error path until the reinstall happens.

Set the app-level signing secret and token encryption key:

```bash
SLACK_SIGNING_SECRET=...
FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY=...
```

Install the app separately in each customer's workspace and provision each token into its tenant.
Interactivity, events, and commands use the shared app signing secret, then route by the signed
workspace ID to an enabled tenant and its decrypted token. Missing/unknown workspaces have no fallback.
Membership events compare the user with the stored bot user ID before decrypting; `auth.test` runs
when provisioning/replacing tokens and when verifying lifecycle revocation. A signed uninstall or
revocation event triggers `auth.test` against the current stored credential. A valid token preserves
the workspace; only `token_revoked` or `account_inactive` permit deletion. Slack's
[`invalid_auth` error](https://docs.slack.dev/reference/methods/auth.test/) can also mean an IP
allowlist rejection, so it leaves the workspace intact and returns `503` for Slack to retry.
Provider outages, rate limits, identity mismatches, and decryption failures also return `503`.
Deletion compares the checked ciphertext under the provisioning lock and atomically removes only
that team's workspace/settings and disables its tenant. A concurrent reinstall writes fresh randomized
ciphertext and is preserved, including when Slack reuses the same bot user ID. Cleanup also works for
disabled tenants. Reinstallation must validate both integrations before enabling it again.

Lifecycle acknowledgement waits for verification and committed cleanup. Slow Slack responses or
contention on the provisioning lock can exceed Slack's
[three-second acknowledgement window](https://docs.slack.dev/apis/events-api/#responding)
and trigger redelivery; the credential check and conditional deletion remain safe to retry.
Reliable immediate acknowledgement would require a durable event queue with retrying workers.
Acknowledging before starting in-memory background cleanup could lose the event on a process crash.

Finally, invite the bot to the review channel. Never invite it to an
externally shared (Slack Connect) channel: validation videos and PR information would be visible
to the external organization.

## Channel Routing

All repos in a Slack workspace share one explicitly selected review channel. The first channel
where the bot joins is selected automatically and receives the active greeting; later joins are
silent. Anyone in the workspace can select another channel with
`/feature-rec channel #channel-name` as long as the bot is currently a member of the target.
Removing the bot from the selected channel does not promote or notify another channel. The route is
retained, so re-inviting the bot resumes delivery there; alternatively, run the channel command from
any workspace conversation or DM to switch. The selected channel is checked against live Slack
membership when each validation is posted. Membership is honored exactly as reported by Slack, with no
shared-channel filtering. **Do not invite `@Feature-Rec` to externally shared (Slack Connect)
channels**: validation videos and PR information will be posted there, visible to the external
organization. Initial validation posts identify the current GitHub repository as `owner/repo#N`;
finalized posts use the PR number so their buttons can be removed even after GitHub access disappears.

If there is no saved route and exactly one live membership, delivery repairs a missed first-join
event by selecting it and emits the same active greeting after rechecking the live route. With
several memberships it refuses to guess and asks a user to run the channel command. If the selected
channel is unavailable when a validation is ready, no Slack message is posted and the Check Run
fails with instructions to re-invite the bot or select another channel.

`slack_workspaces.selected_channel_id` is the persistent routing source of truth, with one selected
channel per tenant workspace. Deploy B also writes `team_channel_routes` during the rollback window.
`channel_settings` is the source of truth for each channel's mention mode, custom mention
audience, and approver policy. A never-configured channel uses virtual defaults (follow approvers,
unrestricted approval) without inserting a settings row. Bot membership is read live from Slack for
selection and availability checks; it is not persisted locally.

## Slash Commands

`/feature-rec` can be run from any conversation or DM in the installed workspace; every reply is
ephemeral. Setting commands always read and update the selected review channel, not the invocation
conversation. `/feature-rec` and `/feature-rec help` return the same general help. Configuration
subcommands without arguments show the current approval/notification summary plus detailed usage.

| Command | Effect |
| --- | --- |
| `/feature-rec channel #channel-name` | Select a public or private bot channel as the workspace review destination. The target must be an escaped Slack channel mention. Switching restores that channel's settings (or the virtual defaults) without copying or rewriting them. |
| `/feature-rec mention approvers` | Mention the channel's current approvers whenever a validation is posted. This is the default. Unrestricted approval resolves to `@channel`. |
| `/feature-rec mention off` | Post validation requests without mentioning anyone. |
| `/feature-rec mention @here\|@channel\|@usergroup\|@user…` | Mention a custom audience, independently of later approver changes. `@channel` must be alone; `@here` may mix with users or groups. |
| `/feature-rec approvers @channel\|@usergroup\|@user…` | Restrict who may use the approval buttons. Default: anyone in the channel. `@channel` clears the restriction. Unauthorized clicks are answered ephemerally with "Only … can approve." |
| `/feature-rec status` | Show the selected channel, availability, and the shared approval/notification summary. |

Direct users and every member returned for a selected active usergroup must belong to the selected
channel when a custom mention or approver setting is saved. Disabled usergroups are excluded from
Slack lookups, and empty usergroups are rejected. `@here` and `@channel` do not need individual
membership validation. Membership is checked at configuration time only; later membership changes
do not rewrite stored settings or block delivery. A channel switch itself does not revalidate or
rewrite saved settings.

## Local Demo Backend

Install dependencies using the [README quickstart](../README.md#quickstart).
Create a local environment file:

```bash
cp .env.example .env
```

Fill in the [runtime variables](#runtime-configuration) for the integrations you will
use. The backend needs a reachable Postgres and an explicit `FEATURE_REC_BASE_URL`.
A local health check can use `http://localhost:3000` with `NODE_ENV=development`;
real Actions requests need a public HTTPS tunnel origin as their audience.

Start a tunnel in a separate terminal, for example:

```bash
ngrok http 3000
```

Set `FEATURE_REC_BASE_URL` in `.env` to that public origin, then start the service:

```bash
make dev
```

This loads `.env`, starts or reuses the local Docker Postgres instance, and injects
its `DATABASE_URL`. To use an existing database without Make, export the runtime
variables yourself and run `pnpm run feature-rec:service`; that command does not
load `.env` automatically.

Set the target repository variable `FEATURE_REC_API_URL` to the same tunnel origin
and pass `api-url: ${{ vars.FEATURE_REC_API_URL }}` to the action step. Follow
[repository onboarding](#onboarding-a-repository), including tenant provisioning,
before testing review traffic. Local rendering by itself does not need the backend
or its integration credentials.

## Production Image

Build the backend-only image from the repository root:

```bash
docker build -t feature-rec-service:local .
```

The root build context is required because `packages/service` imports `packages/core`. The image
contains compiled JavaScript and production dependencies only; it runs as a non-root user with Node
24 and starts with `node --enable-source-maps dist/index.js`.

To run the image against the Makefile-managed Postgres on Docker Desktop, use a
configured `.env` from the [local backend setup](#local-demo-backend):

```bash
make db
docker run --rm --name feature-rec-service -p 3000:3000 \
  --env-file .env \
  -e DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/postgres \
  feature-rec-service:local
```

On Linux, add `--add-host=host.docker.internal:host-gateway` to the Docker command.
Check the running image with `curl --fail http://localhost:3000/health` and verify the
compiled admin entrypoint with:

```bash
docker run --rm --entrypoint node feature-rec-service:local dist/admin.js --help
```

For an empty-database smoke test without live provider credentials, use the environment
and readiness loop in [CI](../.github/workflows/ci.yaml).

### Runtime configuration

The runtime contract is:

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `PORT` | Platform supplied | Fastify listener; defaults to `3000` locally |
| `DATABASE_URL` | Required | PostgreSQL connection string |
| `FEATURE_REC_BASE_URL` | Required | Explicit public HTTPS origin; shared audience normalization with the action's `api-url` input |
| `GITHUB_APP_ID` | Required for GitHub operations | GitHub App identifier |
| `GITHUB_PRIVATE_KEY` | Required for GitHub operations | GitHub App signing key |
| `SLACK_SIGNING_SECRET` | Required for Slack review | Slack interaction, event, and command verification |
| `FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY` | Required when workspace rows exist | Exactly 32 random bytes encoded as base64; encrypts each workspace's stored bot token |
| `GITHUB_OIDC_ISSUER` | Optional | Trusted HTTPS issuer; defaults to `https://token.actions.githubusercontent.com` |

Configuration is injected at runtime. Do not put secrets in the Dockerfile or image. The backend
uses no persistent filesystem or container volume; review state and channel routing are stored in
PostgreSQL, logs go to stdout/stderr, and uploaded videos are forwarded to Slack rather than
persisted locally.

Only explicit loopback HTTP base URLs are accepted in development/tests; production requires HTTPS.
Credentials, query strings, and fragments are rejected. The audience is the normalized base URL,
with no independent audience override. Discovery/JWKS access is lazy until the first OIDC request,
so a fresh-database `/health` smoke does not call GitHub or Slack. No runtime path accepts
`FEATURE_REC_RUNNER_TOKEN`, `SLACK_BOT_TOKEN`, `FEATURE_REC_GITHUB_TOKEN`, or a `GITHUB_TOKEN` fallback.

## Railway Deployment

1. Create a Railway backend service connected to this repository and protected production branch.
   Railway builds the root Dockerfile; it does not use Railpack or require a prebuilt registry image.
2. Keep its root directory at `/`; `railway.json` selects the root Dockerfile and limits deploy
   triggers to the backend, core package, and relevant root build files.
3. Add Railway PostgreSQL as a separate service in the same project and region.
4. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}` on the backend so it uses private project
   networking.
5. Add the remaining [runtime variables](#runtime-configuration). Railway injects `PORT` automatically.
6. Generate a Railway domain for initial verification or attach a stable custom domain such as
   `feature-rec.example.com`.
7. Enable GitHub Autodeploys for `main`. Keep Railway's **Wait for CI** disabled because the required
   GitHub Actions workflow runs and smoke-tests the image before merge.

The container connects to PostgreSQL and applies Kysely migrations before Fastify begins listening.
If connection or migration fails, `/health` never becomes available and Railway will not activate the
deployment. `railway.json` configures `/health`, an always-restart policy, zero deployment overlap,
and 60 seconds of graceful draining for in-flight uploads and external API calls.

After the public origin is stable, configure:

```text
FEATURE_REC_BASE_URL=https://feature-rec-production.up.railway.app
Slack Interactivity Request URL=https://feature-rec-production.up.railway.app/api/slack/interactivity
Slack Events Request URL=https://feature-rec-production.up.railway.app/api/slack/events
Slack Slash Command URL=https://feature-rec-production.up.railway.app/api/slack/commands
Hosted action default=https://feature-rec-production.up.railway.app
```

This generated Railway hostname is temporary. Before customer workflows depend on it, attach
`api.feature-rec.com` through Railway Custom Domains, change the action default to
`https://api.feature-rec.com`, and keep the Railway hostname available during the transition.

Seal app-level credentials and the Slack token encryption key in Railway where available. Slack bot
tokens live encrypted in PostgreSQL, one per workspace; provision them through the admin command's
non-echoing prompt/stdin. The backend does not consume GitHub webhooks.

### Backup, rollback, and migration

Railway runs PostgreSQL separately from the stateless backend. Verify the database version and backup
policy, then perform at least one `pg_dump`/`pg_restore` drill before the state becomes critical.
Rollback depends on both the artifact and stored tenant data; automatic down migrations are not used.

Migration `0008_multitenant_expand` adds only nullable/new schema and relaxes the legacy repository
name columns. Deploys A and B register only through `0008` and retain `team_channel_routes`.
Deploy B reads the workspace selection and dual-writes the legacy route. Its `down()` refuses to proceed
if any cycle lacks the legacy `owner`/`repo` values needed by deploy A.

The image includes the compiled `node dist/admin.js` control plane; it does not depend on `tsx` or
development dependencies. Production commands require an explicit `--environment` label, and every
write requires `--confirm`. Run them inside Railway's private network:

```bash
railway ssh -- node dist/admin.js migration-status --environment production
railway ssh -- node dist/admin.js backfill-multitenancy --environment production --dry-run
railway ssh -- node dist/admin.js backfill-multitenancy --environment production --apply --confirm
railway ssh -- node dist/admin.js validate-contract-readiness --environment production
```

Generate `FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY` once with `openssl rand -base64 32`, seal it in
the hosted environment, and keep it stable. Backfill validates the legacy Slack team, resolves every
legacy repository through the GitHub App, detects future cycle-key collisions, writes one disabled
tenant transactionally, and enables it only after validation. Run this reconciliation with the
retained deploy-A artifact before cutover; additional tenants are supported after deploy B is serving.

The first successful backfill/provisioning transaction stores an independent HMAC-SHA256 key verifier
in the singleton `slack_token_encryption_key` table; subsequent writes and startup must match it.
Startup decrypt-checks stored tokens after checking that verifier. A wrong/missing key or missing
verifier prevents startup; one corrupt token produces an error with the tenant/workspace IDs and
event `SLACK_TOKEN_DECRYPTION_FAILED`, without blocking other tenants. Investigate that alert and
repair/re-provision the affected credentials; readiness validation continues to fail until repaired.
Neither tokens nor ciphertexts are logged. Back up the verifier with the database and the key
separately. Never delete the verifier to bypass a key mismatch; restore the matching backup/key.

For the final pre-cutover reconciliation, pause new workflows and drain active runs, then use
`backfill-multitenancy --apply --confirm --rebuild-cycle-keys --traffic-paused`. To roll the database
back to the pre-expansion schema:

1. Pause runner and Slack writes, drain active requests, and verify a fresh database backup and the
   retained older release. Disable automatic deploys and stop all current service instances using
   the platform's deployment controls; killing a process is not enough with an always-restart policy.
2. From a **separate maintenance process**, run the retained newer admin artifact against the private
   database (for example via a private `railway connect postgres --tunnel-only` connection). Do not
   use `railway ssh` inside the still-running service for a schema downgrade. Check migration status.
3. Run `node dist/admin.js migrate-to 0007_mention_modes --environment production --expect-current
   0008_multitenant_expand --service-stopped --traffic-paused --confirm`. These flags acknowledge
   actual operator actions; they do not stop Railway for you. The expected-current check and migration
   are serialized with startup migrations, but a later service restart would reapply `0008`.
4. Verify migration status, start only the pinned older image, check `/health` and an existing review
   flow, then resume traffic. Restore autodeploys only once their target is safe for the chosen schema.

Do not expose PostgreSQL publicly or hand-edit Kysely's migration records. Downgrading `0008` removes
tenant integrations and the key verifier; retain the backup for recovery.

B-to-A requires no migration down, but is allowed only for a validated singleton: pause writes,
run `prepare-rollback-to-a --dry-run`, then `--apply --confirm --traffic-paused` with the explicit
environment, and redeploy the retained A image only after its report passes. Keep the old hosted
runner/Slack secrets sealed and unused during this observation window. Once a second tenant exists,
use a B hotfix or restore the pre-cutover backup instead. Deploy C and D are separate future PRs;
C-to-B must migrate down to `0008` using C's admin artifact before starting B, and D-to-C must migrate
down to `0009` using D's artifact before starting C. Kysely rejects migrations absent from the older
artifact, so reversing those steps prevents startup.

### OIDC cutover checklist

For an existing singleton installation, retain the A artifact and verify a current backup/restore
drill before merging the cutover release. Inventory every consuming repository, recording:

- Its current action commit, replacing moving `@main` references with a pinned pre-cutover revision.
- The prepared immutable OIDC action revision and `permissions: id-token: write` on its workflow job.
- Its `api-url` value, matching the backend's explicit public `FEATURE_REC_BASE_URL` audience.
- Removal of its legacy runner-secret reference when switching to the OIDC action.

Set the encryption key and issuer, pause new workflows, drain or cancel all old-token runs, and rerun
the retained A backfill with `--rebuild-cycle-keys --traffic-paused`. Require a clean
`validate-contract-readiness --require-future-cycle-keys` report, then deploy B with no mixed A/B
request handling. Switch the inventoried workflows to their pinned OIDC revision, provision the
second test tenant, run the two-tenant smoke below, and resume traffic. During observation, compare
legacy/new selected-channel values, rerun readiness validation, and inspect tenant-scoped decrypt,
OIDC/JWKS, and installation-authorization failures. Keep migrations `0009` and `0010` out of B.

### Provision a tenant

For a hosted service, run its compiled command in the intended environment:

```bash
railway ssh -- node dist/admin.js provision-tenant --environment production --confirm \
  --installation-id <GitHub-installation-id> --repository <owner/repo> \
  --selected-channel-id <Slack-channel-id>
```

For a local checkout, build the admin entrypoint and load your local environment:

```bash
pnpm --filter @feature-rec/service run build
node --env-file=.env packages/service/dist/admin.js provision-tenant \
  --environment development --confirm \
  --installation-id <GitHub-installation-id> --repository <owner/repo> \
  --selected-channel-id <Slack-channel-id>
```

Provide the Slack bot token via the non-echoing prompt or stdin. The command validates `auth.test`,
bot channel membership, and the GitHub installation's scoped repository grant before writing the
encrypted token and enabling the tenant. To replace a token or reinstall the same customer's
integrations, supply its existing `--tenant-id`; identities are checked before replacement.
Never pass tokens as command-line arguments. The temporary operator flow will be reused by the
separate invite-only onboarding page before beta launch.

Migration `0006_drop_legacy_bot_channels` permanently removes the obsolete membership snapshot after
explicit routing has completed its observation window. Before deploying it, verify every expected
workspace has a `team_channel_routes` row and retain a database snapshot or `bot_channels` export.
After it runs, rollback is limited to explicit-route service versions; queue-based binaries are no
longer supported. Restoring membership history requires the pre-cleanup snapshot, not a down
migration.

Moving to another provider requires no application changes: restore the PostgreSQL backup, configure
the same environment variables, deploy the same OCI image, wait for migrations and `/health`, test
GitHub and Slack against a staging hostname, and then switch DNS. A custom domain keeps integration
URLs stable across that move.

## Smoke Checks

Run the [development validation gate](../README.md#validation) first. The following
checks exercise real integrations in staging.

In a staging Slack workspace, also verify that the first join gets one greeting and later joins are
silent; switch from a DM and confirm there is one ephemeral reply and no channel-visible post;
confirm each channel's mention mode and approvers survive the switch; exercise `mention approvers`,
`mention off`, and a custom audience; reject a mention or approver whose usergroup contains a
non-member; and remove the selected channel to confirm delivery fails without moving to another
membership, then re-invite it and confirm delivery resumes.

Run two tenant workflows concurrently with different workspaces/channels. Confirm videos, settings,
approvals, comments, and check runs stay within their tenant. A signed interaction from workspace A
carrying a cycle-B ID must leave B unchanged. Rename one repository, remove/re-add its installation
grant, and uninstall/re-provision one workspace; each operation must leave the other tenant working.
An unrelated member-join event must not call `auth.test` or decrypt the token. Finally, confirm an
already-posted stale validation can have its buttons cleared after GitHub access has disappeared.
