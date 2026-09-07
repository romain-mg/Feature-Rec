# Follow-Approvers Mention Mode Plan

## Status

Implementation plan for the final `/feature-rec mention` PRD.

The MVP principle is: if a behavior is not required to make the three mention modes coherent, do
not add it.

## Goal

Make notification configuration optional by making mentions follow the selected channel's
approvers by default, while retaining explicit custom and off modes.

The three user-visible modes are:

| Mode | Meaning |
| --- | --- |
| `approvers` | Mention the channel's current approvers. This is the default. |
| `custom` | Mention the explicitly configured audience, independently of approver changes. |
| `off` | Post the validation request without mentioning anyone. |

When approval is unrestricted, `approvers = null` means everyone in the channel can approve. The
effective mention in follow-approvers mode is therefore `@channel`.

## Scope

This work includes:

- the new persisted mention-mode model;
- `/feature-rec mention approvers`, `off`, and custom-audience transitions;
- effective-audience resolution at validation-message delivery time;
- per-channel defaults and restoration after channel switches;
- command confirmations, status, onboarding copy, and help;
- migration, storage, command, delivery, and regression tests;
- current user-facing documentation.

This work does not include:

- a settings UI or interactive Slack modal;
- restoring the previous custom audience after switching through `off` or `approvers`;
- proactive revalidation when channel or user-group membership changes later;
- changing approval authorization semantics;
- editing historical plan documents to make them describe the new system.

## Final Product Contract

### Default behavior

A never-configured channel uses these logical defaults:

```text
mention mode: approvers
mention audience: null
approvers: null
```

This resolves to:

```text
Approvers: anyone in the channel
Notifications: following approvers — @channel
```

The defaults are virtual. Selecting or automatically resolving a channel does not create a
`channel_settings` row. The row is materialized when a setting is first changed. This keeps
`updated_by` and `updated_at` tied to real configuration changes.

### Command behavior

#### Follow approvers

```text
/feature-rec mention approvers
```

- Set the mention mode to `approvers`.
- Clear the custom mention audience.
- Do not modify the approver policy.
- Resolve the effective mention from the latest approver policy whenever a validation is posted.

#### Turn mentions off

```text
/feature-rec mention off
```

- Set the mention mode to `off`.
- Clear the custom mention audience.
- Do not modify the approver policy.
- Continue posting validation requests, without a mention prefix.

#### Set a custom audience

```text
/feature-rec mention <@user|@usergroup|@here|@channel> [...]
```

- Set the mention mode to `custom`.
- Replace the custom audience with the normalized, rendered Slack audience.
- Do not modify the approver policy.
- Later approver changes leave this audience unchanged.

### Argument rules

- `approvers` and `off` are reserved mode tokens and must be used alone.
- `@channel` must be used alone because combining it with another target is redundant.
- `@here` may be combined with users or user groups.
- Multiple users and user groups are allowed.
- Duplicate targets are deduplicated while preserving first-seen order.
- An empty or disabled user group is rejected.
- Direct users and every current member of a selected user group must belong to the selected review
  channel when the custom setting is saved.
- Membership is validated at configuration time only. A later membership change does not block
  delivery or rewrite the stored setting.
- Any invalid command fails atomically and leaves the previous setting unchanged.

### Per-channel behavior

- Mention and approver settings remain keyed by `(team_id, channel_id)`.
- Switching to a configured channel restores its settings.
- Switching to a never-configured channel uses the virtual defaults.
- Switching channels does not copy or rewrite either channel's settings.
- A validation already posted keeps its original mention text.
- Approval of a pending validation continues to consult the settings for the channel in which that
  validation was posted.

### Help and confirmation behavior

- `/feature-rec` and `/feature-rec help` return identical general help.
- The one-line onboarding tip lists only the subcommands and points to `/feature-rec help`.
- A configuration subcommand without arguments shows its current state followed by detailed help:
  - `/feature-rec channel` shows the selected channel, its approval/notification summary when one
    is selected, and detailed channel usage;
  - `/feature-rec approvers` shows the approval/notification summary and detailed approver usage;
  - `/feature-rec mention` shows the approval/notification summary, including the current mode and
    effective audience, and detailed mention usage.
- `/feature-rec status` shows the selected channel and approval/notification summary without usage
  instructions.
- Successful channel, approver, and mention changes show both approval and notification state so
  the two concepts cannot be confused.

Representative summaries:

```text
Approvers: @Michael and @Sarah
Notifications: following approvers — @Michael and @Sarah
```

```text
Approvers: @Michael and @Sarah
Notifications: custom — @Michael
```

```text
Approvers: anyone in the channel
Notifications: off
```

## Data Model

### PostgreSQL shape

Rename the existing `mention` column and add a checked text mode:

```text
channel_settings
  team_id             text        not null
  channel_id          text        not null
  mention_mode        text        not null default 'approvers'
  mention_audience    text        null
  approvers           text        null
  updated_by           text        not null
  updated_at           timestamptz not null
```

Use named constraints equivalent to:

```sql
CHECK (mention_mode IN ('approvers', 'custom', 'off'))
```

```sql
CHECK (
  (mention_mode = 'custom' AND mention_audience IS NOT NULL AND mention_audience <> '')
  OR
  (mention_mode IN ('approvers', 'off') AND mention_audience IS NULL)
)
```

Use `text` plus checks instead of a native PostgreSQL enum while the product model is still being
prototyped.

### Migration

Add and register `packages/service/src/storage/migrations/0007_mention_modes.ts`.

The up migration must:

1. Rename `mention` to `mention_audience`.
2. Add `mention_mode` as `text NOT NULL DEFAULT 'approvers'`.
3. Set every existing `mention_audience` to `NULL`, intentionally placing all existing test
   channels in follow-approvers mode.
4. Add the mode-domain and cross-column constraints after the reset.
5. Preserve `approvers`, routing, and update metadata.

The down migration must:

1. Drop the new constraints.
2. Drop `mention_mode`.
3. Rename `mention_audience` back to `mention`.

The reset is intentionally lossy. A down migration restores the old schema, not old custom mention
values. Operational recovery of those values would require the pre-migration database snapshot.

Adding migration `0007` changes the existing migration-chain test: one `migrateDown()` from latest
will revert `0007`, not `0006`. Tests that expect `bot_channels` to be recreated must explicitly
move down through both migrations or target the intended migration.

## Application Model

### Domain types

Represent mention state as a discriminated union rather than exposing nullable mode/payload pairs:

```ts
type MentionSetting =
  | { mode: "approvers" }
  | { mode: "off" }
  | { mode: "custom"; audience: string };

type ChannelSettings = {
  mention: MentionSetting;
  approvers: string[] | null;
};
```

Keep `approvers = null` as the persisted representation of unrestricted channel approval. Do not
store Slack's `@channel` token in the approver ID list.

Define one canonical logical default and reuse it everywhere:

```ts
const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = {
  mention: { mode: "approvers" },
  approvers: null,
};
```

The storage/domain boundary should return this logical default when no database row exists. Callers
must not independently interpret a missing row.

### Storage adapter

Update:

- `packages/service/src/storage/schema.ts`;
- `packages/service/src/storage.ts`;
- `packages/service/src/storage/postgres.ts`.

Replace the mention-only setters with methods that accept `MentionSetting` and atomically encode
both columns. A custom setting writes `mode = custom` and its audience; the other two modes write a
null audience.

Remove the public unguarded `setMention` and `setApprovers` methods from `CycleStore` and the
PostgreSQL implementation. Runtime configuration writes must go through:

- guarded `setSelectedChannelMentionSetting`, which atomically updates `mention_mode` and
  `mention_audience`;
- guarded `setSelectedChannelApprovers`, which updates the approver policy.

Both methods must retain the existing selected-route lock and compare the current route with the
channel for which the command started. Tests should initialize/select a route and use these guarded
methods, or seed migration fixtures directly; test convenience does not justify an unguarded public
storage API.

The private channel-settings upsert must preserve these concrete behaviors:

- If a channel has no settings row and `/feature-rec approvers @Michael` runs, create a row with
  Michael as the approver and the default follow-approvers mention state. The resulting validation
  mentions Michael.
- If a channel has no settings row and `/feature-rec mention off` or a custom mention command runs,
  create a row with that mention setting while leaving `approvers = NULL`. Anyone in the channel
  can still approve.
- On an existing row, an approver command changes only `approvers`; a mention command changes only
  `mention_mode` and `mention_audience`. For example, changing approvers must not erase a custom
  audience, and turning mentions off must not reset restricted approvers.
- If the selected channel changes before either guarded write acquires the route lock, return the
  existing guard failure and do not insert or update a settings row for the original channel.

Decode database rows defensively into the discriminated union even though PostgreSQL constraints
protect the persisted shape.

## Effective Mention Resolution

Add one pure resolver used by delivery and all user-facing descriptions:

```ts
function effectiveMention(settings: ChannelSettings): string | null
```

Its behavior is:

| Mention setting | Approvers | Result |
| --- | --- | --- |
| `off` | Any | `null` |
| `custom(audience)` | Any | Stored audience |
| `approvers` | `null` | `<!channel>` |
| `approvers` | User/user-group IDs | Rendered approver mentions |

This function resolves the latest settings immediately before posting a validation. Approver
changes therefore automatically affect follow-approvers mode without writing mention state.

Keep separate description helpers for the mode label and effective audience, but make them depend
on the same resolver.

## Slack Delivery Changes

The current Slack block builder interprets a null mention as `@here`. Remove that implicit default.

Change the Slack delivery boundary so it receives an already-resolved mention prefix:

```text
string => prepend that audience
null   => do not prepend a mention
```

The HTTP delivery path should:

1. Resolve the selected review channel as it does today.
2. Read the latest logical settings for that channel through the existing bounded retry helper.
3. Resolve the effective mention.
4. Upload the video.
5. Post the validation with that explicit prefix.
6. Persist the validation message coordinates through the bounded retry helper.

The settings read is idempotent and happens before the first Slack side effect, so an exhausted
database retry cannot leave an orphaned video. Persisting the same validation-message coordinates
is also idempotent and should retry because it happens after the Slack message exists. Do not wrap
`uploadVideo` or `postValidation` in the same generic retry; both can duplicate Slack artifacts if
the first request succeeded but its response was lost.

Ensure off mode does not leave a leading blank line in the validation block. Do not change the
message's approval buttons, finalization flow, or GitHub state transitions.

## Command Handler Changes

### Dispatch and help

Update the command dispatcher so an absent subcommand and `help` share the same general-help
renderer. Unknown subcommands may return that same help.

Split the current single usage string into:

- a one-line onboarding tip;
- general help listing subcommands;
- detailed `channel`, `mention`, and `approvers` help.

Do not add an interactive prompt or a `custom` keyword. Any audience argument directly selects
custom mode.

### Mention parser

Before resolving Slack targets:

1. Recognize `approvers` and `off` as exact, unprefixed mode tokens.
2. Reject either token when other arguments are present.
3. Detect `@channel`/`<!channel>` and reject it when any other target is present.
4. Otherwise reuse the existing user, user-group, `@here`, and `@channel` target resolution.
5. Validate concrete channel membership and persist custom mode only after all validation succeeds.

A Slack user group named `@approvers` or `@off` remains a normal custom target because the leading
`@` distinguishes it from the reserved mode tokens.

### Shared summaries

Create a shared settings-summary renderer and use it after:

- a mention-mode change;
- an approver change;
- a successful channel switch;
- `/feature-rec status`;
- `/feature-rec channel` before detailed channel usage;
- `/feature-rec approvers` before detailed approver usage;
- `/feature-rec mention` before detailed mention usage.

For follow mode, show both the mode and its current effective audience. For custom mode, show the
stored/effective custom audience. For off mode, do not invent an effective audience.

## Channel Switching

Keep the existing explicit route and per-channel settings keys.

On a successful switch:

- do not insert or modify `channel_settings`;
- read the target channel's logical settings through the defaulting storage boundary;
- include the restored/default approval and notification summary in the ephemeral confirmation.

Returning to a configured channel must restore its mode and custom audience. Returning to an
unconfigured channel must show follow-approvers mode with unrestricted approval and `@channel` as
the effective audience.

## Implementation Sequence

### 1. Schema and migration

- Add migration `0007_mention_modes`.
- Register it in the static migration provider.
- Update the Kysely `ChannelSettingsTable` shape.
- Update the migration-chain fixture and down-migration expectations.

### 2. Domain and storage

- Add `MentionSetting` and `DEFAULT_CHANNEL_SETTINGS`.
- Make settings reads return the logical default for missing rows.
- Replace mention string setters with atomic mention-setting setters.
- Remove the unguarded `setMention` and `setApprovers` APIs; route all runtime configuration writes
  through their selected-channel-guarded counterparts.
- Update upsert encoding and row decoding.
- Preserve the selected-channel write guard.

### 3. Effective mention and descriptions

- Add the pure effective-mention resolver.
- Refactor approver rendering for reuse by delivery and summaries.
- Add shared approval/notification summary rendering.

### 4. Commands and help

- Implement the two mode commands and custom transition.
- Add reserved-token and redundant-`@channel` validation.
- Implement mention status plus detailed help.
- Make empty command and `help` equivalent.
- Update approver, channel, and status responses to use shared summaries.
- Update the onboarding greeting/tip.

### 5. Delivery

- Resolve settings and effective audience immediately before validation posting.
- Wrap the logical settings read in the existing bounded retry helper.
- Remove Slack's implicit null-to-`@here` conversion.
- Treat null at the Slack boundary as no mention.

### 6. Tests

- Update migration, storage, command, routing, and delivery self-tests.
- Run the complete repository verification commands.

### 7. Documentation

- Update `docs/setup-and-operations.md` and the relevant README summary.
- Leave older implementation-plan documents as historical records.

## Test Matrix

### Migration and constraints

- Legacy `NULL`, empty, `@here`, `@channel`, and custom mention values all migrate to
  `mention_mode = approvers`, `mention_audience = NULL`.
- Existing approver JSON is unchanged.
- An unknown mode is rejected.
- `custom + NULL` is rejected.
- `custom + empty string` is rejected.
- `approvers + audience` and `off + audience` are rejected.
- The down migration restores the old column name and removes the new mode column.

### Storage

- Missing row returns the canonical logical default without inserting a row.
- A first guarded approver write creates follow-approvers mention state and makes those approvers
  the effective audience.
- A first guarded custom/off mention write leaves approval unrestricted.
- `custom -> off` clears the audience.
- `custom -> approvers` clears the audience.
- `off -> custom` requires and saves a new audience.
- Approver writes preserve all mention modes.
- Mention writes preserve approvers.
- Mention and approver route-guard failures do not insert or modify a settings row for the channel
  on which the command started.
- Settings remain isolated by team and channel.

### Commands

- Empty command and `help` return identical help.
- `channel`, `approvers`, and `mention` without arguments each show the current relevant state and
  shared settings summary before their command-specific usage.
- `status` shows the selected channel and shared settings summary without command usage.
- `mention` shows mode, effective audience, and detailed usage.
- `mention approvers` and `mention off` succeed only alone.
- `mention @channel` succeeds as custom mode.
- `mention @channel <other>` and `mention @channel @here` fail atomically.
- `mention @here <@user>` is accepted.
- Multiple users and groups are normalized and deduplicated.
- Unknown, empty, disabled, or partially out-of-channel groups are rejected.
- An out-of-channel direct user is rejected.
- Invalid changes preserve the previous setting.
- Approver changes report whether notifications follow, remain custom, or remain off.
- Channel switches report the restored/default settings.

### Delivery

- Missing settings produce `@channel`.
- Follow mode with unrestricted approval produces `@channel`.
- Follow mode with users and groups renders those approvers.
- Changing approvers before delivery changes the effective follow-mode mention.
- A transient settings-read failure is retried and still produces exactly one video upload and one
  validation message.
- Custom mode ignores later approver changes.
- Custom `@here` and `@channel` remain custom after approver changes.
- Off mode posts without any mention or leading blank line.
- A validation posted in channel A uses channel A's settings even after the active route moves to
  channel B.

### Existing behavior

- Unauthorized approval clicks remain ephemeral and unchanged.
- Channel-selection concurrency remains guarded.
- Slack command acknowledgment remains immediate.
- Video upload, message attachment, supersession, and finalization behavior remain unchanged.

## Verification Commands

Run from the repository root:

```bash
pnpm typecheck
pnpm lint
pnpm feature-rec:selftest
pnpm selftest
```

## Rollout and Rollback

There are no customers to preserve, so rollout intentionally resets all existing internal/test
mention settings to follow approvers. After deployment, manually configure at least one test
channel in each mode and verify switching among them.

The column rename is not compatible with the previous service binary. Before deploying, retain a
database snapshot. If rollback is required, migrate down before starting the previous binary; the
old custom mention values will not be reconstructed.

## Definition of Done

- Every channel behaves as follow-approvers by default without requiring a settings row.
- The three mention modes are explicit and database-valid.
- Follow mode derives from the latest approver policy and maps unrestricted approval to `@channel`.
- Custom and off modes remain stable across approver changes and channel switches.
- Command status and confirmations clearly separate approval from notification behavior.
- Slack no longer contains a hidden `@here` fallback.
- Migration, command, storage, delivery, routing, and regression tests pass.
- Current documentation matches the shipped behavior.
