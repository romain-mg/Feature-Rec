# Feature-Rec

Feature-Rec turns product-visible pull request changes into a Slack approval flow.

When a PR is opened, marked ready for review, or updated, the GitHub Action checks whether the diff
changes user-facing UI. Backend-only, docs-only, test-only, dependency-only, and CI-only changes are
accepted automatically. If the PR changes the product experience, Feature-Rec renders a short
Remotion MP4, posts it to Slack, and keeps the `Feature-Rec` check pending until an approved
reviewer chooses `Good to merge` or `Needs changes`.

The video renderer is part of Feature-Rec. It reads changed UI source, recreates the relevant
interface as Remotion components, animates the smallest before-to-after change, and renders a
deterministic no-audio MP4 without launching the target app.

## What This Project Does

- Classifies PR diffs to decide whether product review is needed.
- Auto-accepts PRs with no frontend-visible product change.
- Generates a short visual demo for frontend-visible changes.
- Sends the demo to Slack with product approval buttons.
- Maps the Slack decision back to GitHub Checks and PR comments.
- Provides a standalone local renderer pipeline for generating demo videos from fixtures or git diffs.

## How It Works

```text
ready PR event
  -> GitHub Action
  -> diff classifier
     -> no frontend-visible change: accept the Feature-Rec check
     -> frontend-visible change: render demo MP4
  -> Slack review message
     -> Good to merge: accept the check
     -> Needs changes: post PR feedback and mark the check action required
```

The repository is a pnpm monorepo with these main pieces:

| Path | Purpose |
| --- | --- |
| `packages/action` | GitHub Action entrypoint. It reads the PR event, classifies the diff, invokes the video renderer when needed, and calls the backend. |
| `packages/service` | Fastify backend for Slack uploads, Slack button handling, GitHub Check Runs, PR comments, and SQLite-backed review state. |
| `packages/core` | Shared schemas, config parsing, template helpers, and action/service contracts. |
| `packages/cli` | Renderer CLI: analyze a UI change, generate or reuse a Remotion scene, render video, and write release artifacts. |
| `packages/video` | Remotion project used to render the generated scenes. |
| `fixtures` | Example before/after UI changes that can render locally without external setup. |
| `apps/web` | Small Next.js sample app whose UI code is used by the fixtures. It is not part of the pnpm workspace. |
| `examples` | Example Feature-Rec config and GitHub Actions workflow for a target repository. |

Feature-Rec is configured in the target repository with `.github/feature-rec-config.yaml`. The
config chooses the GitHub check name, Slack channel, Slack product group, approver usergroups, and
the PR comments posted after approval or rejection. See
[`docs/feature-rec.md`](docs/feature-rec.md) for the full GitHub App, Slack App, and target
repository setup.

## Install

Requirements:

- Node.js 20 or newer
- pnpm 11.9.0 or compatible
- GitHub CLI only if you use `pnpm publish --post`

From the repository root:

```bash
pnpm install
```

Optional local environment:

```bash
cp .env.example .env
```

`ANTHROPIC_API_KEY` enables live scene generation. Without it, the bundled fixtures use known-good
offline scenes so the local demo still works.

## Run the Renderer Locally

Render the bundled fixture demos:

```bash
pnpm demo
```

This runs the full renderer pipeline and writes:

- `out/demo.mp4`
- `out/CHANGELOG.md`
- `out/pr-comment.md`
- `out/plan.json`

Useful variants:

```bash
pnpm demo --feature invite-members
pnpm generate --feature dark-mode-toggle
pnpm generate --git HEAD~1
pnpm render
pnpm publish
pnpm studio
```

`pnpm studio` opens Remotion Studio for previewing and editing generated scenes.

## Run Feature-Rec Locally

Start the backend:

```bash
cp .env.example .env
# Fill FEATURE_REC_RUNNER_TOKEN, GitHub credentials, and Slack credentials in .env.
pnpm feature-rec:service
```

Expose the backend with a tunnel such as ngrok or cloudflared, then set these values in the target
repository:

```text
FEATURE_REC_API_URL=https://<public-tunnel-host>
FEATURE_REC_RUNNER_TOKEN=<same shared secret as the backend>
ANTHROPIC_API_KEY=<optional, but needed for live AI scene generation>
```

Copy the example files into the target repository:

```text
examples/feature-rec-config.yaml -> .github/feature-rec-config.yaml
examples/feature-rec-workflow.yml -> .github/workflows/feature-rec.yml
```

Configure the Slack app interactivity URL:

```text
https://<public-tunnel-host>/api/slack/interactivity
```

Then require the `Feature-Rec` Check Run in branch protection. Open or update a ready PR in the
target repository to start the review loop.

## Commands

| Command | Description |
| --- | --- |
| `pnpm demo` | Generate, render, and publish local demo artifacts from fixtures. |
| `pnpm generate` | Convert fixtures or a git diff into generated Remotion scenes and `out/plan.json`. |
| `pnpm generate --git <range>` | Generate scenes from changed TSX/JSX files in a git range. |
| `pnpm render` | Render the current `out/plan.json` to `out/demo.mp4`. |
| `pnpm publish` | Write local changelog and PR-comment artifacts. |
| `pnpm publish --post` | Post the generated PR comment with the GitHub CLI. |
| `pnpm studio` | Open the Remotion Studio. |
| `pnpm typecheck` | Type-check all workspace packages. |
| `pnpm feature-rec:service` | Start the local Feature-Rec backend on `PORT` or `3000`. |
| `pnpm feature-rec:selftest` | Run self-tests for core, service, and action packages. |

## Validate

Run the project checks from the repository root:

```bash
pnpm typecheck
pnpm feature-rec:selftest
```

For detailed Feature-Rec setup, permissions, and smoke checks, read
[`docs/feature-rec.md`](docs/feature-rec.md).

## Roadmap

Remotion will be replaced with an in-house solution we are currently building.

make something that people want
