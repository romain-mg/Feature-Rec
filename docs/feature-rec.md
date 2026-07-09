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

## GitHub App

Create a GitHub App with:

- Checks: read/write
- Pull requests: read
- Issues: read/write
- Contents: read
- Metadata: read

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
- `examples/feature-rec-workflow.yml` to `.github/workflows/feature-rec.yml`

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
