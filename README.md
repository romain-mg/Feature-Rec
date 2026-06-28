# Feature-Rec

> **A GitHub Action that turns ready PRs into Slack product validation.**

When a PR is opened or updated in **ready for review**, Feature-Rec checks whether the diff contains
a frontend-visible change. Backend-only, docs-only, test-only, dependency-only, and CI-only changes
are accepted automatically. If the change affects product UX, Feature-Rec generates a Remotion MP4
of the change, posts it to Slack, tags the configured product group, and keeps the `Feature-Rec`
Check Run pending until a business reviewer approves or requests changes.

The video generation layer is **AutoDemo**: it reads changed UI code, reproduces the interface as
Remotion components, and renders a clean screen-recording-style MP4 without launching the app.

<sub>Hackathon MVP · GitHub Actions · Slack · Remotion · Claude · pnpm monorepo</sub>

---

## Table of contents

- [What you get](#what-you-get)
- [The product loop](#the-product-loop)
- [Why this is different](#why-this-is-different)
- [How it works](#how-it-works)
- [AutoDemo video engine](#autodemo-video-engine)
- [Quickstart](#quickstart)
- [Commands](#commands)
- [Project structure](#project-structure)
- [Core concepts](#core-concepts)
- [The UI Replication Agent](#the-ui-replication-agent)
- [Screen-style rendering & design system](#screen-style-rendering--design-system)
- [Configuration](#configuration)
- [Extending: add your own feature](#extending-add-your-own-feature)
- [Hard constraints](#hard-constraints)
- [Project status & roadmap](#project-status--roadmap)
- [Troubleshooting / FAQ](#troubleshooting--faq)
- [Tech stack](#tech-stack)

---

## What you get

Install Feature-Rec on a repository and every ready PR gets a product-aware gate:

| PR diff | Feature-Rec behavior | Check Run result |
| --- | --- | --- |
| No frontend-visible product change | LLM classifier accepts the PR without bothering product. | `accepted` / success |
| Frontend-visible product change | AutoDemo renders an MP4, the bot posts it to Slack, and configured reviewers choose what happens. | `pending` / in progress |
| Product clicks **All good, merge** | Feature-Rec accepts the Check Run and posts the configured merge-ready comment to the PR author. | `accepted` / success |
| Product clicks **Request changes** | Slack requires a comment, then Feature-Rec posts it to GitHub as the configured `{mention} make the following changes: ...` PR Conversation comment. | `rejected` / action required |

The Slack message has exactly the two decisions product needs:

- **All good, merge**
- **Request changes**

When changes are requested, Claude can iterate on the PR, push a follow-up commit, and the next
`synchronize` event starts the same loop again.

For the video engine by itself, run:

```bash
pnpm demo
```

That produces **`out/demo.mp4`** — a 1920×1080 · 30fps · **no-audio** video that shows:

1. the **changed UI reproduced 1:1** from the source code (real React/Remotion, not a screenshot),
2. the **before state** held briefly,
3. the **minimal interaction or transition** that reveals the change,
4. the **after state** held for review.

Plus `out/CHANGELOG.md` and `out/pr-comment.md` ready to publish.

Two example features ship in the repo and render out of the box:

| Fixture | Change | Hero animation |
| --- | --- | --- |
| `dark-mode-toggle` | a dark-mode toggle added to a Settings card | toggle **slides** on |
| `invite-members` | an "Invite" button added to a Members panel | button **pops** in |

---

## The product loop

Feature-Rec is designed for the gap between code review and product validation:

1. A PR is opened, marked ready for review, or updated with a follow-up commit.
2. The Feature-Rec GitHub Action starts a `Feature-Rec` Check Run.
3. An LLM reads the PR diff and decides whether a product or business counterpart needs to look.
4. If the change is not frontend-visible, the Check Run is accepted automatically.
5. If the change is frontend-visible, the LLM understands the feature from the diff and AutoDemo
   renders a Remotion video of the UI change.
6. The backend uploads the video to the configured Slack channel and tags the configured group from
   `.github/feature-rec-config.yaml`.
7. A product reviewer clicks **All good, merge** or **Request changes**.
8. Approval posts the configured PR Conversation comment and accepts the Check Run.
9. Rejection requires a Slack comment, forwards that comment to GitHub as
   the configured `{mention} make the following changes: ...` PR Conversation comment, and marks
   the Check Run as action required.

This keeps product validation inside the merge gate without asking product to read diffs or pull a
branch locally.

---

## Why this is different

Feature-Rec is not a demo-video toy bolted onto CI. It is a merge gate for product-visible changes:
the action decides when product needs to be involved, gives product a short visual artifact in
Slack, and maps the decision back to GitHub branch protection.

The "AI demo video" market (Synthesia, HeyGen, Supademo, Arcade…) turns *docs/scripts → video* or
relies on *manual capture*. Open-source tools (e.g. git-glimpse) **film** the app with Playwright
and drop a GIF in the PR. **AutoDemo films nothing** — it **regenerates the UI from its own code**,
triggered by the real change, so Feature-Rec can produce deterministic review media from CI.

|                | Playwright capture | **1:1 reproduction (AutoDemo)** |
| -------------- | ------------------ | ------------------------------- |
| Quality        | screen-record, compression | **vector-crisp, deterministic** |
| Reliability    | flaky (selectors, timeouts) | **no browser to drive, repeatable** |
| Zoom           | needs real bounding boxes | **trivial: we place the hero, so we know its center** |
| Speed          | needs a live deploy | **just reads the diff** |
| Trade-off      | — | **fidelity capped on very complex UIs** → screenshot fallback |

**The key to fidelity:** Tailwind is enabled *inside* Remotion, so the agent **reuses the exact
`className`s** from the source component → near-free 1:1 reproduction. (No Tailwind in the source?
The agent inlines the hex/px values extracted from the code.)

---

## How it works

```
 ready PR event
      │
      ▼
 ┌──────────────┐    ┌──────────────┐
 │ GitHub Action│───►│ LLM classifier│
 └──────────────┘    └──────────────┘
      │                     │
      │                     ├─ no frontend-visible change ──► accept Check Run
      │                     │
      │                     ▼
      │              ┌──────────────┐    ┌──────────────┐
      └─────────────►│ AutoDemo MP4 │───►│ Slack review │
                     └──────────────┘    └──────────────┘
                                              │
                 ┌────────────────────────────┴────────────────────────────┐
                 ▼                                                         ▼
          All good, merge                                      Request changes + comment
                 │                                                         │
                 ▼                                                         ▼
          accept Check Run                         GitHub comment + action required Check Run
```

Feature-Rec has three runtime parts:

1. **Action** (`packages/action`) — runs on `pull_request` events for opened, ready-for-review, and
   synchronized PRs. It reads `.github/feature-rec-config.yaml`, starts a review cycle, classifies
   the diff, renders the video when needed, and uploads the MP4 to the backend.
2. **Backend** (`packages/service`) — owns the long-lived review cycle: GitHub Check Run lifecycle,
   Slack video upload, Slack buttons, request-changes modal, reviewer authorization, and GitHub PR
   comments.
3. **Shared config** (`packages/core`) — validates the GitHub and Slack configuration, templates
   comments, and keeps action/backend payloads aligned.

The target repository controls the product routing:

```yaml
version: 1

github:
  checkName: Feature-Rec
  mention: "@claude"
  acceptComment: "@{pr_author} validation passed; you can merge."
  rejectComment: "{mention} make the following changes:\n\n{review_comment}"

slack:
  channel: "C0123456789"
  mention: "<!subteam^S0123456789|@product-team>"
  approverUsergroups: ["S0123456789"]
```

---

## AutoDemo video engine

AutoDemo is the Remotion engine Feature-Rec uses when the classifier finds a frontend-visible
change. Its standalone pipeline is:

```
 UI diff
   │
   ▼
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ analyze  │──►│  agent   │──►│ compose  │──►│  render  │
└──────────┘   └──────────┘   └──────────┘   └──────────┘
 read diff +    Claude         DemoPlan +     Remotion
 design tokens  reproduces     scene          bundle +
                UI 1:1 &       registry       renderMedia
                shows the                        │
                change                           ▼
                                             out/demo.mp4
```

Each video stage is a module in `packages/cli/src/`:

1. **`analyze`** (`analyze.ts`) — collects *features*. A feature = a changed UI component
   (`before` + `after` source) + PR metadata + the project's design tokens
   (`apps/web/tailwind.config.ts` + `globals.css`). Source: a fixture in `fixtures/<id>/` **or** a
   live `git diff` range (`--git HEAD~1`).
2. **`agent`** (`agent/`) — the **UI Replication Agent**. Sends Claude the 5-section prompt with the
   before/after code + tokens; Claude returns one Remotion scene that reproduces the changed markup
   with its **exact classNames** and shows the smallest before-to-after interaction. The
   output is validated; if there's no API key or it fails, a **known-good** scene is used so a scene
   is never empty. → [details](#the-ui-replication-agent)
3. **`compose`** (`compose.ts` + `scenes.ts`) — writes the scene to
   `packages/video/src/scenes/generated/<id>.tsx`, **regenerates the scene registry**
   (`scenes/index.ts`), and builds the serializable **DemoPlan** (`out/plan.json`).
4. **`render`** (`render.ts`) — `@remotion/bundler` bundles the project (Tailwind webpack override)
   and `@remotion/renderer` `renderMedia` renders the `ReleaseDemo` composition, passing the
   DemoPlan as `inputProps`. Output: `out/demo.mp4`, local & headless, **muted** (no audio track).
5. **`publish`** (`publish.ts`) — prepends `out/CHANGELOG.md` and writes `out/pr-comment.md`
   (`--post` posts it via the `gh` CLI).

The composition (`ReleaseDemo.tsx`) is a `<Series>` of generated scenes only. There is no branded
intro, outro, spotlight, caption, or cinematic zoom. The registry holds the (non-serializable)
components; the DemoPlan holds only ids + props, so it can be passed to Remotion as `inputProps`.

---

## Feature-Rec setup

Feature-Rec is configured in the target repository and by the local demo backend:

The workflow has three packages plus one AutoDemo adapter:

| Package | Purpose |
| --- | --- |
| `@feature-rec/core` | Shared config, schemas, cycle keys, and template helpers. |
| `@feature-rec/action` | Composite GitHub Action entrypoint: reads the PR event, classifies the diff, renders video, and calls the backend. |
| `@feature-rec/service` | Local Fastify backend with SQLite storage, GitHub Check Run updates, Slack upload, buttons, and request-changes modal handling. |
| `@autodemo/cli/feature-rec` | Exported adapter that converts extracted PR TSX/JSX sources into the existing AutoDemo render pipeline. |

The intended demo setup is:

1. Run the backend locally with `pnpm feature-rec:service`.
2. Expose it with a tunnel and set `FEATURE_REC_API_URL` plus `FEATURE_REC_RUNNER_TOKEN` in the
   target repository.
3. Copy `examples/feature-rec-config.yaml` and `examples/feature-rec-workflow.yml` into the target
   repository under `.github/`.
4. Configure the Slack app, GitHub App, and `ANTHROPIC_API_KEY`.
5. Require the `Feature-Rec` Check Run in branch protection.

See [`docs/feature-rec.md`](docs/feature-rec.md) for the complete setup, permissions, and smoke
checks.

---

## Quickstart

**Requirements:** Node ≥ 20 and pnpm. Google Chrome / a headless shell is downloaded automatically
by Remotion on first render.

Start the local Feature-Rec backend:

```bash
pnpm install
cp .env.example .env   # fill GitHub, Slack, and shared runner-token values
pnpm feature-rec:service
```

Expose that backend with a tunnel, then copy the example config and workflow into the target repo:

```text
.github/feature-rec-config.yaml
.github/workflows/feature-rec.yml
```

The target repo sets `FEATURE_REC_API_URL`, `FEATURE_REC_RUNNER_TOKEN`, and `ANTHROPIC_API_KEY`.
From there, every opened, ready-for-review, or synchronized PR runs the product validation loop.

To smoke-test the AutoDemo video engine locally:

```bash
pnpm demo         # generate -> render -> publish on the bundled fixtures
```

That produces `out/demo.mp4` (no API key required — it uses the known-good scenes).

Step by step, or target one feature:

```bash
pnpm generate --feature invite-members   # reproduce one diff -> scene + plan
pnpm render                              # bundle (Tailwind) + render -> out/demo.mp4
pnpm publish                             # write changelog + PR comment
```

Preview / live-edit scenes in the Remotion Studio:

```bash
pnpm studio
```

With an API key, the agent generates scenes from any real diff instead of using the fallback:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm generate --git HEAD~1               # detect changed UI components from a git range
pnpm render
```

> **Node not found?** On some setups Node lives under nvm and isn't on `PATH` by default. Run
> `nvm use` (or prefix commands with the nvm bin dir) before `pnpm`.

---

## Commands

All run from the repo root. Arguments after the command are forwarded to the CLI.

| Command | What it does |
| --- | --- |
| `pnpm demo` | Full pipeline (generate → render → publish) on **all** fixtures |
| `pnpm demo --feature <id>` | Full pipeline on a single fixture |
| `pnpm generate` | Reproduce diffs into scenes + build `out/plan.json` |
| `pnpm generate --feature <id>` | …for one fixture only |
| `pnpm generate --git <range>` | …from a git diff range (e.g. `HEAD~1`, `main...HEAD`) |
| `pnpm generate --offline` | Skip the API; use known-good scenes only |
| `pnpm render` | Bundle + render the current plan → `out/demo.mp4` |
| `pnpm publish` | Write `out/CHANGELOG.md` + `out/pr-comment.md` |
| `pnpm publish --post` | …and post the comment via the `gh` CLI (needs a PR number) |
| `pnpm studio` | Open the Remotion Studio for live preview |
| `pnpm typecheck` | `tsc --noEmit` across all workspace packages |
| `pnpm feature-rec:service` | Start the local Feature-Rec backend on `PORT` or 3000 |
| `pnpm feature-rec:selftest` | Run self-tests for core, service, and action packages |

> If a flag doesn't seem to take effect through `pnpm <script> --flag`, use the explicit form:
> `pnpm <script> -- --flag` (both work — a stray `--` is stripped by the CLI).

---

## Project structure

```
agora/
├─ apps/web/                          # "the product" whose UI changes (Next.js + Tailwind)
│  ├─ app/                            #   settings & members pages, globals.css (design tokens)
│  ├─ components/
│  │  ├─ SettingsCard.tsx             #   gained the dark-mode toggle
│  │  └─ MembersCard.tsx              #   gained the Invite button
│  └─ tailwind.config.ts             #   tokens read by the agent
│
├─ fixtures/                          # the diffs the pipeline reads (before/after + metadata)
│  ├─ dark-mode-toggle/{before,after}.tsx + meta.json
│  └─ invite-members/{before,after}.tsx + meta.json
│
├─ packages/
│  ├─ core/   (@feature-rec/core)      # Feature-Rec schemas, config parsing, helpers
│  ├─ action/ (@feature-rec/action)    # composite GitHub Action runner
│  ├─ service/(@feature-rec/service)   # Fastify + Slack/GitHub integration backend
│  ├─ video/  (@autodemo/video)       # the Remotion project
│  │  ├─ remotion.config.ts           #   enables Tailwind for the Remotion CLI/Studio
│  │  └─ src/
│  │     ├─ index.ts                  #   registerRoot + imports index.css
│  │     ├─ Root.tsx                  #   the <Composition> (1920×1080@30fps)
│  │     ├─ schema.ts                 #   DemoPlan / Brand / SceneRef zod schemas + totalFrames()
│  │     ├─ tokens.ts                 #   design system (colors + motion presets)
│  │     ├─ font.ts                   #   Inter via @remotion/google-fonts
│  │     ├─ components/               #   screen helpers + legacy chrome components
│  │     ├─ compositions/             #   ReleaseDemo (scene timeline), MissingScene
│  │     └─ scenes/
│  │        ├─ index.ts               #   the registry (AUTO-GENERATED)
│  │        └─ generated/             #   scenes land here (agent output / known-good)
│  │
│  └─ cli/   (@autodemo/cli)          # analyze · agent · compose · render · publish
│     ├─ src/
│     │  ├─ index.ts                  #   commander entry (generate/render/publish/demo)
│     │  ├─ analyze.ts                #   load features (fixtures or git) + project tokens
│     │  ├─ compose.ts                #   build/read/write the DemoPlan
│     │  ├─ scenes.ts                 #   write scene files + regenerate the registry
│     │  ├─ render.ts                 #   bundle + renderMedia (muted)
│     │  ├─ publish.ts                #   changelog + PR comment
│     │  ├─ feature-rec.ts            #   Feature-Rec adapter into the render pipeline
│     │  ├─ stills.ts                 #   dev helper: render frames to PNG for QA
│     │  └─ agent/
│     │     ├─ index.ts               #   replicate(): API path → offline fallback
│     │     ├─ prompt.ts              #   the 5-section prompt + integration contract
│     │     ├─ anthropic.ts           #   Claude call (model, max_tokens, stop_reason check)
│     │     ├─ validate.ts            #   extract code block + invariant checks
│     │     └─ offline.ts             #   the known-good scene set
│     └─ scripts/validate-selftest.mts#   self-test for the validation logic
│
├─ docs/
│  └─ feature-rec.md                  # Feature-Rec setup guide
├─ examples/
│  ├─ feature-rec-config.yaml         # target repo config
│  └─ feature-rec-workflow.yml        # target repo GitHub Actions workflow
└─ out/                               # demo.mp4, plan.json, CHANGELOG.md, frames/  (gitignored)
```

> `apps/web` is intentionally **not** a pnpm workspace member — it is read as *text* (diff + tokens),
> not installed or built by the monorepo. Run it standalone with `cd apps/web && pnpm install && pnpm dev`.

---

## Core concepts

| Term | Meaning |
| --- | --- |
| **DemoPlan** | The serializable spine of a video: `{ brand, scenes[] }`. Built by the CLI, passed to Remotion as `inputProps`. JSON-only (no components/functions). |
| **Scene** | One generated Remotion component reproducing a change. Exports a default component + a named zod `schema`. |
| **Hero** | The new/changed element (the toggle, the button…). The clip starts from the before state, shows the minimal interaction/change, then holds the after state. |
| **Registry** | `scenes/index.ts` — maps `scene id → { Component, schema }`. Auto-regenerated so the bundle picks up new scenes. |
| **ScreenFrame / Cursor** | Neutral helpers for making partial components look like a clean screen recording without adding presentation copy. |

---

## The UI Replication Agent

Lives in `packages/cli/src/agent/`. For each feature:

1. **Prompt** (`prompt.ts`) — a system prompt (role + hard rules) plus a user prompt asking for **5
   sections**: ① visual specs *extracted from the code*, ② video config, ③ data & props (zod), ④
   animation logic (diff before/after → find the hero), ⑤ the self-contained Remotion component.
   It includes an **integration contract** so the output drops straight into the project (see below).
2. **Call** (`anthropic.ts`) — `@anthropic-ai/sdk`, model `claude-sonnet-4-6` (configurable). It
   **fails fast on `stop_reason: "max_tokens"`** so a truncated response can't be written as a
   broken scene.
3. **Validate** (`validate.ts`) — extracts the last fenced code block (any language label; throws on
   a truncated/unterminated fence), then enforces the invariants:
   - must `export default` a component **and** `export const schema`,
   - **no `<Audio>` / audio utils, no `fetch` / `XMLHttpRequest` / WebSocket / remote imports**,
   - every **top-level schema field has a `.default()`** (so the scene renders with sparse props).
4. **Write + fallback** (`index.ts`) — on success, writes the scene and regenerates the registry.
   On any failure (or no `ANTHROPIC_API_KEY`), falls back to a **known-good** scene listed in
   `offline.ts`. This is the "demo safety net": the pipeline never emits an empty scene.

**Integration contract** (what a generated scene may rely on):

- Saved to `packages/video/src/scenes/generated/<id>.tsx`; frames are **scene-relative**.
- May import: `{ ScreenFrame, Cursor }` from `../../components`,
  `{ SPRING_SMOOTH, SPRING_POP }` from `../../tokens`,
  `{ fontFamily }` from `../../font`, plus `remotion` and `zod`.
- Root scene should look like a clean app screen or neutral app/window viewport.
- `export default function Scene(props: Partial<z.infer<typeof schema>>)`, starting with
  `const { ... } = schema.parse(props ?? {})`.

---

## Screen-style rendering & design system

Generated scenes should look like a simple screen recording of the changed UI. They can use
`ScreenFrame` for a neutral viewport and `Cursor` for the minimal interaction, but should not add
title cards, release labels, spotlights, captions, or cinematic zooms.

The reproduced UI still uses the target repo's own classNames/colors — fidelity comes from the
source code, never from AutoDemo's tokens.

**Motion presets:**
- `SPRING_SMOOTH` `{ damping:200, mass:0.6, stiffness:100 }` — cursor moves, row expansion, zero bounce.
- `SPRING_POP` `{ damping:13, mass:0.8, stiffness:200 }` — clicks, buttons, short UI reveals.
- Fades: `interpolate` + `Easing.out(Easing.cubic)`, clamped.

**Typical choreography** (scene-relative frames): `[0-24]` before state →
`[24-70]` minimal interaction/change → `[70-end]` after state hold.

---

## Configuration

AutoDemo environment variables (optional — copy `.env.example` or just `export`):

| Var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Enables the live agent. Without it, known-good scenes are used. |
| `AUTODEMO_MODEL` | `claude-sonnet-4-6` | Model used for replication. |
| `AUTODEMO_MAX_TOKENS` | `16000` | Output token ceiling for the agent. |

Feature-Rec service and action variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `FEATURE_REC_API_URL` | — | Public URL of the Feature-Rec backend, used by the GitHub Action. |
| `FEATURE_REC_BASE_URL` | `http://localhost:3000` | Backend base URL used when constructing Slack/GitHub links. |
| `FEATURE_REC_DB_PATH` | `./data/feature-rec.sqlite` | SQLite database path for review cycles. |
| `FEATURE_REC_RUNNER_TOKEN` | — | Shared secret between the action and backend. |
| `FEATURE_REC_GITHUB_TOKEN` | — | Local testing fallback for GitHub writes. Prefer a GitHub App for the demo path. |
| `GITHUB_APP_ID` | — | GitHub App id for Check Runs and PR comments. |
| `GITHUB_PRIVATE_KEY` | — | GitHub App private key. Escaped `\n` sequences are supported. |
| `SLACK_BOT_TOKEN` | — | Slack bot token for uploads, messages, and modals. |
| `SLACK_SIGNING_SECRET` | — | Slack request signing secret for interactivity verification. |
| `FEATURE_REC_OFFLINE` | — | Set to `1` to force offline AutoDemo rendering from known-good scenes. |
| `FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER` | — | Set to `1` to allow filename-based classification when no Anthropic key is available. |

---

## Extending: add your own feature

**1. Drop a fixture:**

```
fixtures/<my-feature>/
  before.tsx     # the component before the change
  after.tsx      # the component after the change
  meta.json      # { id, file, prTitle, prNumber, releaseTag, productName, description, caption }
```

**2. Generate + render** (needs `ANTHROPIC_API_KEY`):

```bash
pnpm generate --feature <my-feature>
pnpm render
```

**3. (Optional) Make it work offline** — for a guaranteed demo without a key, add the id to the
`KNOWN_GOOD` set in `packages/cli/src/agent/offline.ts` and ship a hand-checked scene in
`packages/video/src/scenes/generated/<my-feature>.tsx` (follow the integration contract above).

To QA a render frame-by-frame, edit the frame list in `packages/cli/src/stills.ts` and run
`pnpm --filter @autodemo/cli exec tsx src/stills.ts` → PNGs in `out/frames/`.

---

## Hard constraints

These are enforced by design and by validation:

- **No audio.** No TTS, no narration, no `<Audio>`. The render is `muted` (no audio track at all).
- **No presentation chrome.** No intro, outro, spotlight, caption pill, or cinematic zoom.
- **Reproduce from code, never capture.** The UI is re-rendered in React/Remotion (no Playwright).
- **No network** inside generated scenes.
- **Local render only** (no Lambda in the MVP).
- **Landscape 1920×1080 @ 30fps.**
- **Colors/typography come from the code**, never invented.

---

## Project status & roadmap

**Working & verified today:**
- Full pipeline (`analyze → agent → compose → render → publish`), end-to-end.
- Two mocks render correctly (toggle slide + button pop); typecheck clean; agent validation
  self-tested; reviewed by a multi-agent adversarial pass (6 findings, all fixed).
- All hard constraints hold (audio-track probe confirms zero audio).
- Feature-Rec GitHub Action, Slack validation service, SQLite-backed cycle storage, GitHub Check Run
  lifecycle, request-changes modal, and smoke self-tests.

**Not wired yet:**
- **Screenshot fallback** for UIs too complex to reproduce (today the net is `MissingScene`, which
  guarantees a frame is never empty).
- Hosted Feature-Rec backend; the current demo path expects a local service exposed through a tunnel.

---

## Troubleshooting / FAQ

- **`node: command not found` / `env: node: No such file or directory`** — Node is installed via
  nvm and not on `PATH`. Run `nvm use` (or add the nvm bin dir to `PATH`) before `pnpm`.
- **pnpm: "Ignored build scripts: esbuild"** — `tsx` needs esbuild's binary. The root
  `package.json` allow-lists it via `pnpm.onlyBuiltDependencies`; run `pnpm rebuild esbuild` if
  needed.
- **First render is slow / "Downloading Chrome Headless Shell"** — Remotion downloads a headless
  browser once (~90 MB), then caches it.
- **`<w> [webpack.cache...] Caching failed for pack`** — harmless webpack cache warning; the render
  still succeeds.
- **No video / "No known-good scene" error** — you generated a new fixture without an API key and
  without registering an offline scene. Set `ANTHROPIC_API_KEY`, or add the offline scene (see
  [Extending](#extending-add-your-own-feature)).
- **Feature-Rec action fails with missing API URL** — set repository variable
  `FEATURE_REC_API_URL` to the public tunnel URL for the local backend.
- **Feature-Rec cannot post Check Runs or PR comments** — configure the GitHub App credentials
  (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`) on the backend, or use `FEATURE_REC_GITHUB_TOKEN` for
  local-only smoke testing.
- **Slack buttons do nothing** — set the Slack Interactivity Request URL to
  `<FEATURE_REC_BASE_URL>/api/slack/interactivity`, expose that URL publicly, and make sure
  `SLACK_SIGNING_SECRET` matches the app.
- **A `--flag` is ignored** — use `pnpm <script> -- --flag` (or the explicit
  `pnpm --filter @autodemo/cli exec tsx src/index.ts <cmd> --flag`).

---

## Tech stack

TypeScript · Node 20+ · pnpm workspaces · **Remotion 4** (`@remotion/bundler`, `@remotion/renderer`,
`@remotion/tailwind-v4`, `@remotion/google-fonts`) · React 19 · Tailwind v4 ·
**`@anthropic-ai/sdk`** (model `claude-sonnet-4-6`) · `zod` · `commander` · Fastify · SQLite ·
Slack Web API · GitHub Checks API. Test app: Next.js 15.

<sub>Feature-Rec — product validation from PR diff to Slack decision.</sub>
