# Feature-Rec

Feature-Rec turns frontend-visible PR changes into a Slack validation flow:

1. A ready PR opens, becomes ready, or receives a follow-up commit.
2. The GitHub Action runs an LLM classifier on the full PR diff.
3. If no frontend-visible change is found, the `Feature-Rec` Check Run is accepted.
4. If a frontend-visible change is found, the action reuses AutoDemo to render a Remotion MP4.
5. The local Feature-Rec backend uploads the video to Slack and posts validation buttons.
6. `Good to merge` accepts the Check Run.
7. `Needs changes` opens a required Slack modal, then posts the configured PR Conversation comment, including `github.mention`, and rejects the Check Run.

For this hackathon run, Feature-Rec intentionally ignores backend-only product changes. If the classifier says a change is frontend-visible but the action cannot extract TSX/JSX source to reproduce, the Check Run fails clearly instead of sending a non-UI summary video.

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
| `SLACK_SIGNING_SECRET` | Required for Slack review | Slack interaction verification |

Configuration is injected at runtime. Do not put secrets in the Dockerfile or image. The backend
uses no persistent filesystem or container volume; review state is stored in PostgreSQL, logs go to
stdout/stderr, and uploaded videos are forwarded to Slack rather than persisted locally.

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

## Slack App

Create a Slack App with bot scopes:

- `chat:write`
- `files:write`
- `views:write`
- `usergroups:read`

Configure:

```text
Interactivity Request URL: https://<ngrok-host>/api/slack/interactivity
```

Set local env vars:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

Invite the bot to the configured channel. If `slack.approverUsergroups` is set in the config, only users in one of those Slack usergroups can approve or mark changes as needed.

## Demo Repo Setup

Copy:

- `examples/feature-rec-config.yaml` to `.github/feature-rec-config.yaml`
- `examples/feature-rec-workflow.yaml` to `.github/workflows/feature-rec.yaml`

Set the LLM secret used by the action:

```text
ANTHROPIC_API_KEY=...
```

Without `ANTHROPIC_API_KEY`, Feature-Rec only auto-accepts diffs that do not look frontend-visible. To use the conservative filename-based fallback for frontend-looking diffs, set `FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER=1`.

Set branch protection to require the `Feature-Rec` Check Run, not the GitHub Actions workflow job.

## Smoke Checks

Run:

```bash
pnpm typecheck
pnpm feature-rec:selftest
pnpm --filter @autodemo/cli exec tsx scripts/validate-selftest.mts
```
