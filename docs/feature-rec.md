# Feature-Rec

Feature-Rec turns frontend-visible PR changes into a Slack validation flow:

1. A ready PR opens, becomes ready, or receives a follow-up commit.
2. The GitHub Action runs an LLM classifier on the full PR diff.
3. If no frontend-visible change is found, the `Feature-Rec` Check Run is accepted.
4. If a frontend-visible change is found, the action reuses AutoDemo to render a Remotion MP4.
5. The Feature-Rec backend uploads the video to the workspace's Slack review channel and posts validation buttons.
6. `Good to merge` accepts the Check Run.
7. `Needs changes` opens a required Slack modal, then posts the PR Conversation comment mentioning the PR author, and rejects the Check Run.

For this hackathon run, Feature-Rec intentionally ignores backend-only product changes. If the classifier says a change is frontend-visible but the action cannot extract TSX/JSX source to reproduce, the Check Run fails clearly instead of sending a non-UI summary video.

## Onboarding a Repository

Three actions, no configuration file:

1. Install the Feature-Rec GitHub App on the repository.
2. Copy `examples/feature-rec-workflow.yaml` to `.github/workflows/feature-rec.yaml`, set the
   `FEATURE_REC_API_URL` repository variable, and add the `FEATURE_REC_RUNNER_TOKEN` and
   `ANTHROPIC_API_KEY` secrets.
3. Invite `@Feature-Rec` to the Slack review channel.

Opening a PR with a frontend-visible change then posts the validation video and buttons in that
channel. Legacy `.github/feature-rec-config.yaml` files are ignored; delete them at leisure.

## Channel Routing

All repos in a Slack workspace share one review channel: the channel where the bot was first
introduced. If the bot is in several channels, the oldest introduction wins; removing it from the
active channel promotes the next oldest, and the promoted channel is notified. Rejoining a channel
puts it at the back of the queue. The channel is resolved when each validation is posted — never
from cached configuration — and externally shared or pending Slack Connect channels are excluded
so PR titles and videos cannot leak outside the organization. Every message identifies its repo as
`owner/repo#N`.

When the bot joins a channel it greets with its rank: the active channel gets "Connected,
validation requests will appear in this channel"; later channels are told where validations
currently go and how to change that. If no channel is available when a validation is ready, the
Check Run fails with "Invite @Feature-Rec to your Slack review channel, then re-run."

## Slash Commands

`/feature-rec` configures the channel it is typed in; every reply is ephemeral:

| Command | Effect |
| --- | --- |
| `/feature-rec mention @here\|@channel\|@usergroup\|@user…\|off` | Who validation requests mention. Default `@here`; several targets are allowed; `off` disables the mention. No target shows the current value. |
| `/feature-rec approvers @usergroup\|@user…\|everyone` | Restrict who may use the approval buttons. Default: everyone in the channel. `everyone` clears the restriction. No argument shows the current list. Unauthorized clicks are answered ephemerally with "Only … can approve." |
| `/feature-rec status` | Show the routing channel, mention, approvers, and the fallback queue. |

## Local Demo Backend

Start the backend (it needs a reachable Postgres and fails startup without `DATABASE_URL`):

```bash
make db     # local Postgres in docker (idempotent)
make dev    # injects DATABASE_URL and runs the service on :3000
```

Or without make: export `DATABASE_URL` yourself and run `pnpm feature-rec:service`. Either way, set `FEATURE_REC_RUNNER_TOKEN` in `.env` — runner calls are rejected with 401 without it.

Expose it:

```bash
ngrok http 3000
```

Set the demo repository variable:

```text
FEATURE_REC_API_URL=https://<ngrok-host>
FEATURE_REC_RUNNER_TOKEN=<shared secret matching the backend env>
```

## Production Image

Build the backend-only image from the repository root:

```bash
docker build -t feature-rec-service:local .
```

The root build context is required because `packages/service` imports `packages/core`. The image
contains compiled JavaScript and production dependencies only; it runs as a non-root user with Node
24 and starts with `node --enable-source-maps dist/index.js`.

The runtime contract is:

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `PORT` | Platform supplied | Fastify listener; defaults to `3000` locally |
| `DATABASE_URL` | Required | PostgreSQL connection string |
| `FEATURE_REC_BASE_URL` | Required when hosted | Stable public HTTPS origin |
| `FEATURE_REC_RUNNER_TOKEN` | Required | Bearer token shared with the GitHub Action |
| `GITHUB_APP_ID` | Required for GitHub App mode | GitHub App identifier |
| `GITHUB_PRIVATE_KEY` | Required for GitHub App mode | GitHub App signing key |
| `FEATURE_REC_GITHUB_TOKEN` | Optional | Local/demo fallback for GitHub authentication |
| `SLACK_BOT_TOKEN` | Required for Slack review | Slack Web API authentication |
| `SLACK_SIGNING_SECRET` | Required for Slack review | Slack interaction, event, and command verification |

Configuration is injected at runtime. Do not put secrets in the Dockerfile or image. The backend
uses no persistent filesystem or container volume; review state and channel routing are stored in
PostgreSQL, logs go to stdout/stderr, and uploaded videos are forwarded to Slack rather than
persisted locally.

## Railway Deployment

1. Create a Railway backend service connected to this repository and protected production branch.
2. Keep its root directory at `/`; `railway.json` selects the root Dockerfile and limits deploy
   triggers to the backend, core package, and relevant root build files.
3. Add Railway PostgreSQL as a separate service in the same project and region.
4. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}` on the backend so it uses private project
   networking.
5. Add the remaining runtime variables from the table above. Railway injects `PORT` automatically.
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
FEATURE_REC_BASE_URL=https://feature-rec.example.com
Slack Interactivity Request URL=https://feature-rec.example.com/api/slack/interactivity
Slack Events Request URL=https://feature-rec.example.com/api/slack/events
Slack Slash Command URL=https://feature-rec.example.com/api/slack/commands
Target repository FEATURE_REC_API_URL=https://feature-rec.example.com
```

Use one strong value for `FEATURE_REC_RUNNER_TOKEN` in both Railway and the target repository. Seal
GitHub and Slack secrets in Railway where available. The backend does not consume GitHub webhooks.

### Backup, rollback, and migration

Railway runs PostgreSQL separately from the stateless backend. Verify the database version and backup
policy, then perform at least one `pg_dump`/`pg_restore` drill before the state becomes critical.
Application rollback redeploys the previous healthy image; schema migrations must remain backward
compatible because automatic down migrations are not used.

Moving to another provider requires no application changes: restore the PostgreSQL backup, configure
the same environment variables, deploy the same OCI image, wait for migrations and `/health`, test
GitHub and Slack against a staging hostname, and then switch DNS. A custom domain keeps integration
URLs stable across that move.

## GitHub App

Create a GitHub App with:

- Checks: read/write
- Pull requests: read/write
- Issues: read/write
- Contents: read
- Metadata: read

Pull request write access is required for the approval and rejection comments that Feature-Rec posts
to the PR conversation. If you add or increase permissions after installing the App, approve the
updated permissions on the existing installation (or reinstall the App), then restart the backend so
it mints an installation token with the new grants.

Set local env vars:

```bash
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----...'
```

Feature-Rec is driven by the GitHub Action. The backend does not consume GitHub webhooks.

For quick local testing, `FEATURE_REC_GITHUB_TOKEN` can be used as a fallback, but the intended demo path is the GitHub App.

## Slack App Setup

Create a Slack App with bot scopes:

- `chat:write` — post validation messages, greetings, and notices
- `files:write` — upload the demo video
- `views:write` — open the request-changes modal
- `usergroups:read` — resolve usergroup handles and expand approver groups
- `channels:read` — list the bot's public-channel memberships (routing)
- `groups:read` — same for private channels
- `commands` — added automatically with the `/feature-rec` slash command; must be
  listed explicitly in the OAuth scopes when the app is distributed

Configure, replacing `<host>` with the public backend origin (or the ngrok host locally):

```text
Interactivity Request URL: https://<host>/api/slack/interactivity
Event Subscriptions Request URL: https://<host>/api/slack/events
Slash command: /feature-rec -> https://<host>/api/slack/commands
```

- Subscribe the events URL to the `member_joined_channel` and `member_left_channel` bot events and
  enable **Delayed Events**: after Slack's immediate/1 min/5 min retries, delivery retries hourly
  for 24 hours, and apps below 1,000 events per hour are exempt from auto-disable, so a temporarily
  down backend cannot lose the subscription. Missed events only affect greetings, promotion
  notices, and ordering detail — routing itself is re-polled before every validation post.
- On the `/feature-rec` slash command, enable **Escape channels, users, and links sent to your
  app** so user mentions arrive as `<@U…>` ids.
- Reinstall the app after changing scopes. When upgrading a live install, update the Slack app
  first and deploy the service second: the new grants sit unused until the deploy, so no
  `missing_scope` window exists. If deployed backwards, `missing_scope` surfaces through the same
  check-run error path until the reinstall happens.

Set local env vars:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

Interactivity, events, and commands all use the same signing secret; no other environment
variables are needed. Finally, invite the bot to the review channel.

## Demo Repo Setup

Copy `examples/feature-rec-workflow.yaml` to `.github/workflows/feature-rec.yaml`.

Set the LLM secret used by the action:

```text
ANTHROPIC_API_KEY=...
```

Without `ANTHROPIC_API_KEY`, Feature-Rec only auto-accepts diffs that do not look frontend-visible. To use the conservative filename-based fallback for frontend-looking diffs, set `FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER=1`.

Set branch protection to require the `Feature-Rec` Check Run, not the GitHub Actions workflow job.

Teams that previously restricted approvers through the removed YAML config run
`/feature-rec approvers @<usergroup>` once in the review channel; until then, approval falls open
to everyone in the channel, not closed.

## Smoke Checks

Run:

```bash
pnpm typecheck
pnpm feature-rec:selftest
pnpm --filter @autodemo/cli exec tsx scripts/validate-selftest.mts
```
