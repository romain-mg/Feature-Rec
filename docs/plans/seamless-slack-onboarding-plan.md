# Seamless Slack Onboarding — Architecture & Dev Plan

## Goal

Onboarding a target repo takes three actions, with no YAML editing:

1. Install the Feature-Rec GitHub App on the repo.
2. Add the workflow file.
3. Invite `@Feature-Rec` to the Slack review channel.

Opening a PR then posts the validation video and buttons in that channel. There is
no config file.

**Routing: one review channel per tenant.** All repos in a Slack workspace use the
channel where the bot was first introduced. Today, the workspace behind
`SLACK_BOT_TOKEN` is the only tenant, so this means the oldest active bot channel.
Messages include `owner/repo#N` for clarity.

## Settled decisions


| Concern           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel selection | Use bot membership, scoped by tenant. If the bot is in severgal channels, the oldest introduction wins; removing it promotes the next oldest. Resolve at post time, never from cached config.                                                                                                                                                                                                                                                   |
| Join time         | `member_joined_channel` supplies the exact time. Resolution-time membership polling upserts first-seen times, reconciling missed events without corrupting known ordering.                                                                                                                                                                                                                                                                      |
| Welcome message   | Reflect the channel's rank: rank 1 → “Connected — validations appear here”; rank 2 → “validations go to #oldest — remove me from there to use this channel”; rank >2 → a generic “connected but unused” message. Notify a channel when failover promotes it. The queue is unbounded: no auto-leave or extra write scopes.                                                                                                                       |
| Mention           | Default to positional, non-personal `@here`. Allow a per-channel override with `/feature-rec mention <targets>` where targets are a usergroup, a user or list of users, `@here`, `@channel`, or `off`, stored server-side. No YAML key.                                                                                                                                                                                                         |
| Approvers         | Default to everyone in the channel: visibility is the gate, so one person's absence cannot block a merge. Optionally restrict a channel with `/feature-rec approvers @usergroup [@user …]`. Check on click and answer unauthorized clicks ephemerally with “Only @product-team can approve”; never drop them silently. `everyone` resets the setting. This is independent of mention, and replaces the former `approverUsergroups` YAML key.    |
| YAML              | None. The config file is removed entirely: the action reads no file, and `config`/`configHash` leave the runner protocol (`cycleKey` becomes `owner/repo#N:headSha`). Existing `.github/feature-rec-config.yaml` files are simply ignored.                                                                                                                                                                                                      |
| Multitenancy      | Not implemented, but routing already means “oldest active channel WHERE `team_id = tenant`.” Store `team_id`/`enterprise_id` now and put token access behind `tokenForTeam()` (the env token today). Multitenancy adds org↔workspace pairing and per-team tokens, without changing channel selection. Pairing is never user-facing: create it during Slack + GitHub OAuth on a setup page, or manage it operationally; never expose `/connect`. |


## Architecture

### Slack app setup (manual, once)

- Add `channels:read` and `groups:read` to the existing `chat:write`, `files:write`,
`views:write`, and `usergroups:read` scopes (`commands` rides along with the slash
command; list it explicitly when distributing).
- Add `/feature-rec` → `POST {base}/api/slack/commands`.
- Subscribe `{base}/api/slack/events` to `member_joined_channel` and
`member_left_channel`. Enable **Delayed Events**: after Slack's three retries
(immediate/1 min/5 min for any non-2xx, timeout, or connection failure), it retries
hourly for 24 hours. Apps below 1,000 events/hour are exempt from auto-disable, so
a down backend returning 5xx cannot disable this subscription.
- Reinstall the app after changing scopes.

### Database (two Kysely migrations)

```text
bot_channels
  team_id        text               -- PK (team_id, channel_id)
  channel_id     text
  enterprise_id  text NULL          -- reserved for Enterprise Grid
  joined_at      timestamptz NULL   -- exact event time
  first_seen_at  timestamptz        -- polling fallback
  last_seen_at   timestamptz
  left_at        timestamptz NULL   -- set on leave event or missing poll result

channel_settings
  team_id        text               -- PK (team_id, channel_id)
  channel_id     text
  mention        text NULL          -- rendered mrkdwn; NULL = @here, '' = off
  approvers      text NULL          -- JSON "S…"/"U…" ids; NULL/[] = everyone
  updated_by     text
  updated_at     timestamptz
```

Both tables use the composite primary key `(team_id, channel_id)` from day one, and
every store method takes the tenant: channel IDs are only meaningful within a
workspace, so cross-tenant collisions are structurally impossible. Order by
`coalesce(joined_at, first_seen_at)`, then `channel_id`. A channel is active
when `left_at IS NULL` and the latest membership poll contains it. Rejoining resets
its ordering timestamps, making it a new introduction that cannot steal the active
slot.

### Channel resolution (`packages/service/src/channels.ts`)

`resolveChannel(cycle)`:

1. Find the tenant. Today, use the bot token's team from cached `auth.test`. Later,
  replace only this line with repo→tenant lookup.
2. Page through `users.conversations` for public and private channels. Exclude
  externally shared or pending Slack Connect channels (`is_ext_shared` / pending):
   they must not leak PR titles or videos outside the organization. Sync the rest into
   `bot_channels`: upsert first/last seen, mark missing rows left, and reset ordering
   on rejoin.
3. Return that tenant's oldest active channel.
4. If none exists, throw `ChannelResolutionError` and write this into the check run:
  “Invite @Feature-Rec to your Slack review channel, then re-run.”

Failover follows automatically: removing the bot from A sets `left_at`, so the next
post resolves to B. In-flight cycles keep their saved `slack_channel_id` and
`message_ts`; only new cycles move.

### HTTP additions (`http.ts`)

#### `POST /api/slack/events`

Use the existing interactivity signature verification. Echo the challenge for
`url_verification`. For `event_callback`:

1. Perform the idempotent join/leave DB upsert before returning 200. It is a fast
  local write; a pre-ack crash triggers Slack's immediate/1 min/5 min retries, using
   Slack as the durability queue for ordering state.
2. After the ack, run greetings and promotion notices in a detached promise. Slack
  API latency therefore cannot consume the 3-second deadline or failure budget.

Because greeting follows the ack, a retried delivery (`x-slack-retry-num`) means the
greeting did not run; process retries normally, without deduplication. No inbound
queue is needed: volume is low, upserts are idempotent, and polling reconciles beyond
Slack's retry window.

- On `member_joined_channel` where `user` equals the cached `auth.test` bot ID, save
`joined_at` and post:
  - rank 1: “Connected, validation requests will appear in this channel.”
  - rank 2: “Connected, validations currently go to #. Remove me from that
  channel if you want reviews to happen here instead.”
  - rank >2: “Connected but currently unused, validations go to #. Remove me
  from other channels to use this one.”
- On `member_left_channel`, set `left_at`. If it was the active channel and another
remains, post there: “This channel now receives Feature-Rec validation requests.”
- Drop every other membership event at the top of the handler without logging it.

#### `POST /api/slack/commands`

Accept signature-verified, form-encoded `/feature-rec …` commands:

- `mention <target …>`: accepts one or several targets — resolve `@here`/`@channel`
literally, `@handle` through `usergroups.list`, escaped `<@U…>` users as-is, and
`off` to `''`; multiple targets (e.g. a list of users) are stored as concatenated
mrkdwn and rendered space-separated in the validation message; upsert
`channel_settings` and confirm ephemerally. With no target, show the current value.
- `approvers <@usergroup|@user …>`: resolve entries to `S…`/`U…` IDs and replace the
channel list. `everyone` or `off` clears it. With no arguments, show the current
list. Always confirm ephemerally.
- `status`: ephemerally show “validations go to #; mention: ;
approvers: ” and, when relevant, the fallback queue.
- Anything else: show ephemeral usage help.

#### `POST /api/runs/:cycleId/video`

Call `resolveChannel()` before upload. On failure, mark the cycle `failed`, put the
actionable message in the check run, and return 422. The runner's subsequent failure
call no-ops on the status guard, preserving that message.

### Behavior changes

- `postValidation` prefixes the message with the channel setting, or `<!here>` by
default.
- Approval reads settings for the cycle's saved `slack_channel_id`. With no list,
every clicker in the channel is authorized. Otherwise, expand `S…` entries through
`usergroups.users.list` (already scoped), add direct `U…` IDs, and require a match.
For both accept clicks and request-changes submissions, reply to unauthorized users
ephemerally through `response_url`; never fail silently.
- Keep all user-facing Slack copy (greetings, promotion, no-channel error) as core
constants beside the GitHub comment templates.

## Explicitly deferred (seams included)

- **Tenant pairing:** Customer setup will (a) install the GitHub App on any number of
repos, with later installation changes followed automatically, and (b) complete
Slack OAuth. Store `installation_id ↔ team_id` plus the bot token. Repo→tenant uses
the existing repo→installation lookup already used by `GitHubClient.tokenForRepo`.
Pairing remains outside Slack—no `/connect`. Until then, the bot token's workspace
is the tenant; operator-managed rows can bridge early customers.
- **Per-team tokens:** replace the internals of `tokenForTeam()`; it uses the env token
today.
- **GitHub OIDC runner auth:** replace the shared bearer token.
- **Enterprise Grid installs:** `enterprise_id` is already reserved.

## Dev plan


| #   | Step                                                                                                                                                                                                                                                                                                                   | Touches                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Remove the config system: action reads no file (delete `examples/feature-rec-config.yaml`); drop `FeatureRecConfigSchema`, `configHash`, and `config` from core and the runner protocol; `cycleKey` becomes `owner/repo#N:headSha`; add Slack copy constants; update core selftests                                    | `core/src/index.ts`, `action/src/index.ts`, core selftest |
| 2   | Add migrations, table types, and store methods, all tenant-keyed on `(teamId, channelId)`: `syncBotChannels`, `activeBotChannels`, `recordChannelJoin`, `recordChannelLeave`, `getChannelSettings`, `setMention`, `setApprovers`; make `config_json` nullable and stop reading/writing it (drop later — rollback-safe) | `service/src/storage/`*                                   |
| 3   | Add cached `auth.test`, paginated/externally-shared-filtered `users.conversations`, greetings/notices, usergroup handle resolution, and `response_url` ephemeral replies                                                                                                                                               | `service/src/slack.ts`                                    |
| 4   | Add `resolveChannel()`, video-endpoint wiring, and check-run failure reporting                                                                                                                                                                                                                                         | `service/src/channels.ts`, `http.ts`                      |
| 5   | Add events endpoint, ranked greetings, and failover promotion notice                                                                                                                                                                                                                                                   | `http.ts`                                                 |
| 6   | Add `mention`, `approvers`, and `status` commands                                                                                                                                                                                                                                                                      | `http.ts`                                                 |
| 7   | Add validation mention, channel-setting approval checks (default everyone), and ephemeral rejection                                                                                                                                                                                                                    | `slack.ts`, `http.ts`                                     |
| 8   | Add service selftests: resolver 0/1/many, ordering, failover, rejoin-to-back, shared tenant channel across repos, challenge/join/non-bot events, greeting variants, promotion, mention/approver set/off/echo/status/bad-handle, open/restricted approval, ephemeral rejection, and video failure                       | service selftest                                          |
| 9   | Rewrite README and `docs/feature-rec.md` around three-step onboarding; add Slack setup appendix                                                                                                                                                                                                                        | docs                                                      |
| 10  | Typecheck all; run core/action selftests locally and service selftest in CI; commit, push, and open PR                                                                                                                                                                                                                 | —                                                         |


Use one PR. Steps 1–7 may each be a small, independently reviewable commit.

## Rollout and compatibility

- Config files in target repos are ignored from this deploy onward — the action
stops reading them; repos delete them at leisure. Repos that pinned
`slack.channel` fall back to tenant routing. Teams that used approver restrictions
run `/feature-rec approvers @<usergroup>` once in the review channel; until then,
approval fails open to the channel, not closed.
- Deploy order: the service must be live before target workflows pick up the new
action (an old service rejects config-less start requests). Both ship from the same
merge to main; Railway autodeploys within minutes, so the window is brief — re-run
any workflow that lands in it.
- With many repos, one backend, and one workspace, every repo without an override
intentionally shares the tenant's active channel; each message identifies its repo.
- Slack app first, service second: add the scopes and reinstall the app (30 seconds,
keeps channel memberships and state), configure the events URL and slash command,
and only then deploy the service. Current production code never calls
`users.conversations`, so the new grants sit unused until the deploy and no
`missing_scope` window exists. If deployed backwards, `missing_scope` surfaces
through the same check-run error path until the reinstall happens.
- Add no environment variables. Events and commands use the existing signing secret.

## Risks and edge cases

- **Missed join events:** First-seen reconciliation may use observation order instead
of invite order, but stays deterministic.
- **Bot in an externally shared channel:** Exclude it from routing; the greeting may
explain why.
- **Enterprise membership-event privacy:** `member_joined_channel` fires for every
user entering a bot channel. Drop non-bot events immediately and never log their
payloads.
- **Enterprise event auto-disable:** Slack may disable repeatedly failing endpoints.
Polling remains authoritative, so lost events affect only greetings, promotion
notices, and invite-vs-observation ordering—not validations.
- **Enterprise app review:** `groups:read` plus public event and command URLs increase
admin-review friction; prepare onboarding documentation for it.
- **Rate limits:** One `users.conversations` sweep per validation post is well below
Slack's tier limits; the DB is sufficient cache.

