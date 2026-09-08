# Explicit Slack Review Channel Selection — Development Plan

## Goal

Replace queue-based Slack channel routing with an explicit, workspace-level review
channel:

1. The first channel in a Slack workspace that `@Feature-Rec` joins becomes the
  review channel, receives the existing active greeting, and receives validation
   videos.
2. Later channel joins produce no message, write no membership state, and never
  change the review channel.
3. Any Slack user can run `/feature-rec channel #channel-name` from any
  conversation in the installed workspace, including a channel where the bot is
   absent or a direct message, to select another bot channel.
4. A channel switch sends only an ephemeral command confirmation to the invoking
  user. It does not post a greeting, queue message, promotion notice, or other
   channel-visible message.
5. Switching preserves the target channel’s existing mention and approver
  settings.
6. Changes to mention targets and approvers are rejected unless every
  concrete target is a member of the channel currently receiving videos.

The selected channel is shared by all repositories associated with the Slack
workspace, matching the current tenant-wide routing scope.

## Terminology and product assumptions

- “Anyone” means there is no admin or approver authorization check on the channel
command. Slack request-signature verification, workspace identity checks, and
target-channel membership checks still apply.
- `/feature-rec channel` accepts one escaped Slack channel mention, normally
received as `<#C…|name>` because **Escape channels, users, and links sent to
your app** is enabled. Plain channel names are not resolved because names can be
renamed or ambiguous.
- The channel command polls `users.conversations` when it runs. Only the target
channel must appear in that live bot-membership snapshot. The conversation where
the command was invoked is reply context only and does not need to contain the
bot.
- For a usergroup mention or approver target, every user returned by
`usergroups.users.list` must belong to the selected channel. Disabled
usergroups are excluded from `usergroups.list`, and a group with no users is
rejected. Direct user mentions are checked individually. `@here` and
`@channel` are channel-relative/default values and require no individual
membership check.
- Leaving the selected channel does **not** promote another channel. The explicit
selection is retained, but it is unavailable until the bot rejoins or a user
selects another bot channel. This preserves user intent and lets a rejoin resume
the selected route without allowing an unrelated join to take it over.
- A `/feature-rec channel` command targeting the already-selected channel is an
idempotent route write and leaves settings unchanged.

## Current implementation map

The change is concentrated in the service and shared Slack copy:

- `packages/service/src/channels.ts`
currently reconciles membership and selects `channels[0]`, the oldest active
membership.
- `packages/service/src/storage.ts` and
`packages/service/src/storage/postgres.ts` expose queue-oriented methods.
`syncBotChannels` and `recordChannelLeave` report a promoted channel.
- `packages/service/src/storage/schema.ts` and
`packages/service/src/storage/migrations/0002_channel_routing.ts` define
membership rows and per-channel mention/approver settings, but no explicit
selected-channel pointer.
- `packages/service/src/http.ts` sends ranked join greetings and promotion notices,
dispatches slash commands, and currently reads/writes settings for the channel
where a command was invoked.
- `packages/service/src/slack.ts` can list bot memberships and usergroups and
expands usergroup members inline during approval clicks. It does not yet expose
that expansion as a reusable helper and has no paginated channel-member lookup
for command-time validation.
- `packages/core/src/index.ts` owns the active, queued, promotion, and no-channel
Slack messages.
- `packages/service/scripts/selftest.mts` is the integration-style Postgres test
suite covering membership ordering, promotion, commands, video delivery, and
approval gates.
- `README.md` and `docs/setup-and-operations.md` document the current oldest-channel queue.

## Target data model

### Add `team_channel_routes`

Add migration `0005_explicit_channel_routing.ts` and register it in the static
migration provider.

```text
team_channel_routes
  team_id              text        primary key
  selected_channel_id  text        not null
```

Design decisions:

- One row per `team_id` gives the database a structural one-route-per-workspace
invariant.
- Do not add a foreign key to `bot_channels`. That table is retained only for
migration backfill and rollback compatibility; the new runtime does not persist
Slack membership snapshots. A route can be created or changed only after live
membership confirms the bot is present. It may remain pointing to that channel
if the bot is removed afterward, including the narrow race immediately after
validation.
- Keep `channel_settings` keyed by `(team_id, channel_id)` as the authoritative
mention/approver configuration. A workspace may have several rows, but commands
read and write only the explicitly selected channel’s row.
- Do not add separate route audit columns. Channel selection itself requires only
the selected channel ID; `channel_settings.updated_by` and `updated_at` continue
tracking mention/approver changes only.
- Approval checks continue using the validation cycle’s saved Slack channel ID, so
messages already posted in a previous channel retain that channel’s approver
policy.

### Migration backfill

For every team with at least one active `bot_channels` row, insert the currently
effective channel:

```sql
insert into team_channel_routes (...)
select distinct on (team_id)
  team_id,
  channel_id
from bot_channels
where left_at is null
order by
  team_id,
  coalesce(joined_at, first_seen_at),
  channel_id;
```

This preserves the channel receiving videos immediately before deployment.
Existing `channel_settings` rows require no data migration and retain the settings
for both the selected channel and every other channel.

Teams with no active membership get no route row. Their next observed first
membership is initialized normally.

The down migration only drops `team_channel_routes`. Existing per-channel settings
remain active. The new runtime stops writing `bot_channels`; migration `0006` in the
post-deployment cleanup phase below removes that legacy table after the rollback
window closes.

## Store and concurrency changes

### New store types and methods

Replace queue/promotion operations with explicit routing operations. Planned
`CycleStore` operations:

- `getSelectedChannelId(teamId)` returns the selected channel ID or `null`.
- `initializeTeamChannelRoute(...)` inserts the first route with
`ON CONFLICT DO NOTHING`, returns `{ initializedRoute: boolean }`, and does not
write `bot_channels` or `channel_settings`.
- `selectTeamChannel(...)` upserts only the route. Live Slack membership validation
belongs to the command handler.
- Keep `getChannelSettings`, `setMention`, and `setApprovers` semantics
tenant/channel-keyed.
- Add guarded setting mutations, such as `setSelectedChannelMention(...)` and
`setSelectedChannelApprovers(...)`, which lock the team route, verify the
expected channel is still selected, and then update that channel’s settings.
- Remove `syncBotChannels`, `activeBotChannels`, `recordChannelJoin`, and
`recordChannelLeave` from the runtime store interface once their callers are
removed. Their tables remain available to the migration and to an old binary
during rollback.

`selectTeamChannel` should conceptually perform:

```text
lock team-route:<team>
upsert team_channel_routes:
  selected_channel_id = target
commit
```

Use one per-team Postgres advisory lock, such as `team-route:${teamId}`, for first
initialization and explicit switches. A command polls Slack immediately before the
transaction. Slack membership can change after any poll, so the database does not
claim a stronger membership guarantee than the live snapshot used by the command.
If the bot leaves during that narrow race, the next delivery or command reports
the selected channel as unavailable.

Mention/approver commands validate Slack membership before entering the database
transaction. Their guarded store mutation then takes the same team-route advisory
lock and re-checks `selected_channel_id`. If the selected channel changed during
the Slack API calls, the write affects nothing and the command asks the user to
retry. A same-channel re-selection does not conflict because it preserves the
settings being changed.

### Initialization rules

- Join event for a team with no route: select that channel and initialize default
settings.
- Join event for a team with a route, active or unavailable: the route insert loses
its conflict and nothing is written.
- Later memberships are discovered transiently by `/feature-rec channel`; they are
never copied into Postgres.
- A leave does not update the route or any membership table.
- Rejoining the selected channel requires no database change; the retained route
becomes usable again when live Slack calls see the bot there.
- As resilience for a missed first join event, a delivery that finds no route may
poll Slack and initialize automatically only when the bot belongs to exactly one
channel. When delivery wins initialization, recheck the selected route and live
membership, then emit the same active greeting before continuing. Greeting failure
is logged but does not block video delivery. If several memberships exist, it must
not guess which was first; return an actionable error asking a user to run
`/feature-rec channel #channel`.

The `/start` onboarding probe is read-only. It reports a usable selected route as
onboarded and also reports a sole membership as onboarded because `/video` can use
the missed-event fallback, but it never initializes the route itself. Route writes
remain limited to join events, `/video` fallback, and `/feature-rec channel`.

Two simultaneous first joins serialize on the advisory lock. The first observed
join creates the route and the other route insert becomes a silent no-op. No
membership ordering is maintained after this change.

## Channel resolution

Delete `syncTenantChannels`; it exists to reconcile and rank persisted
memberships, neither of which is part of the target design.

Refactor `resolveChannel`:

1. Fetch the bot identity.
2. Poll `users.conversations` without persisting its result, then read the
  explicit team route so a channel command committed during the Slack poll is
  observed.
3. If a route exists, return it only when the selected channel appears in the live
  membership result.
4. If no route exists and exactly one live bot channel exists, initialize that
  channel as the missed-first-event fallback and return it.
5. If no route exists and several bot channels exist, require an explicit channel
  command instead of using response order as an implicit queue.
6. Do not inspect historical membership ordering and do not return
  `promotedChannelId`.

Use distinct user-facing failure text:

- No route and no memberships:
“Invite @Feature-Rec to your Slack review channel, then re-run.”
- No route and several memberships:
“Feature-Rec is present in multiple channels. Run
`/feature-rec channel #channel-name` to choose where videos should be sent.”
- A selected route exists but the bot is no longer present:
“Feature-Rec is not currently in the selected review channel <#…>. Invite @Feature-Rec back
or run `/feature-rec channel #another-channel` from any workspace conversation,
then re-run.”

These are not proactive Slack messages. When channel resolution fails during video
delivery:

1. Do not call `chat.postMessage` because there is no usable destination.
2. Transition the cycle to `failed`.
3. Put the actionable text in the GitHub Check Run failure summary, as the current
  no-channel path already does.
4. Return HTTP 422 to the runner with a stable error code and the same text.

When a user explicitly runs `/feature-rec status` or another slash command, the
same relevant text can be returned ephemerally through that command’s
`response_url`. This works even when the bot belongs to no channels because slash
command responses do not require a destination-channel post.

The video endpoint keeps resolving at post time. A switch made after a cycle starts
but before its video is uploaded therefore affects that video. A validation already
posted retains its recorded `slack_channel_id` and is not moved.

Remove all `announcePromotion(...)` calls from video delivery, status, and event
handling.

## Slack client additions

Add these paginated helpers to `SlackClient`:

- `listChannelMembers(channelId): Promise<string[]>`, backed by
`conversations.members`, with cursor pagination and a page size of 200.
- `listUsergroupMembers(usergroupId): Promise<string[]>`, backed by
`usergroups.users.list`.

Refactor `isApprover` to reuse `listUsergroupMembers` so membership expansion has
one implementation.

The app already requests `channels:read` and `groups:read`, which cover
`conversations.members` for the public and private channels in scope. No new Slack
OAuth scope is expected. The existing slash-command escaping setting is required
for stable channel/user IDs.

Official references:

- [Slack `conversations.members](https://docs.slack.dev/reference/methods/conversations.members/)`
- [Slack slash-command escaping](https://docs.slack.dev/interactivity/implementing-slash-commands/)

## Slash command behavior

### Shared command context

Before executing any routing/settings mutation:

1. Verify the signed form payload as today.
2. Acknowledge with an empty HTTP 200 immediately.
3. In detached command work, call `listBotChannels` and keep the result in memory
  for this command only.
4. Confirm the payload `team_id` matches the bot token’s team.
5. Do not apply a membership check to the invocation `channel_id`; slash commands
  may originate in any workspace conversation or DM.
6. Deliver success or error only with
  `respondEphemeral(response_url, text)`.

Keep unexpected failures behind the existing generic message and structured server
log. User-correctable membership, syntax, and target errors should be
`CommandError`s and should not become HTTP 500 responses.

### `/feature-rec channel #channel-name`

Add a channel-mention parser alongside `USER_MENTION_RE` and
`SUBTEAM_MENTION_RE`. Accept Slack’s escaped public/private channel forms and
extract the stable channel ID.

Validation:

- Exactly one target is required.
- The target must be in the same team and in the bot’s live membership list.
- A stale database row is insufficient; the live poll is authoritative.
- Selecting the current target is allowed and leaves settings unchanged.

Execution:

- Call the atomic `selectTeamChannel`.
- Do not invoke `postMessage`.
- Send an ephemeral confirmation such as:
  “Feature-Rec videos will now be sent to <#C123>. Existing mention and approver
  settings for that channel are unchanged.”

Error examples:

- Missing/multiple targets:
“Usage: `/feature-rec channel #channel-name`.”
- Bot absent from target:
“Invite @Feature-Rec to <#C123>, then try again.”

### Mention target changes

Keep current `mention` parsing and rendering, but change its context:

- Read and write `channel_settings` for the explicitly selected channel; the
invocation channel never selects a settings row.
- Require the selected route to be currently active.
- Resolve direct users and every user ID returned for each usergroup.
- Fetch the selected channel’s complete member set once per command.
- Reject the entire command if any resolved user is missing. Do not persist a
partial list.
- `@here` and `@channel` remain valid without expanding members.
- With no arguments, show the selected channel’s setting and identify that channel
in the response.

Example failure:

“Cannot update mentions for <#C123>: <@U456> is not a member of that channel.”

For multiple missing users, list a bounded number of mentions and report the
remaining count to keep the ephemeral response readable.

### Approver changes

Update the selected channel’s `channel_settings.approvers` after applying the same
selected-channel lookup and strict membership validation:

- Direct users must be channel members.
- Every user returned for every selected usergroup must be a channel member.
- Request only active usergroups with `include_disabled: false`.
- Empty usergroups are rejected because they would leave a validation with no
eligible approver.
- `@channel` clears the restriction without a member lookup.
- Store nothing unless every target passes.
- No arguments show the selected channel’s approvers and identify that channel.

The approval click gate keeps loading settings using the validation cycle’s saved
`slack_channel_id`. Consequently, messages already posted in a previous channel
retain that channel’s approver policy after a switch.

### Preserved-setting consequences

`/feature-rec channel` validates only that the bot currently belongs to the target
channel. It does not revalidate that channel’s saved mention or approver targets,
and it does not modify them.

- A saved mention may refer to a user who has since left the channel. This must not
block video upload or validation-message posting; the stale user may simply not
receive the intended notification. Verify the exact Slack rendering/notification
behavior in the staging smoke test.
- Saved approvers may all have left the channel. The validation still posts, but no
eligible person in that channel may be able to approve it.
- This is an accepted recoverable state. Slash commands work from any workspace
conversation, so a customer can run `/feature-rec mention ...`,
`/feature-rec approvers ...`, or `/feature-rec approvers @channel` to repair the
selected channel.
- Switching channels preserves existing settings without revalidating their
members. Membership is checked only when `/feature-rec mention` or
`/feature-rec approvers` changes a setting.

### Status and usage

Update `/feature-rec status`:

- Show the explicit selected channel and whether the bot is currently present.
- Show mention and approver settings for the selected channel.
- Remove fallback/queue copy entirely.
- If the selected channel is unavailable, explain how to re-invite or switch.
- If no route exists with no memberships, show the existing onboarding
  instruction. With exactly one membership, explain that the bot is already
  present and ask the user to select that channel explicitly. With multiple
  memberships, ask the user to choose one.

Add the channel command to `COMMAND_USAGE` and remove all queue language.

## Slack event behavior

### Join

`member_joined_channel` for the bot:

1. Attempt to initialize the route directly from the event’s `team_id` and
  `channel`; do not write `bot_channels`.
2. Commit that idempotent route insert before acknowledging.
3. Return 200.
4. Only when this join initialized the route, and only on the first event delivery,
  asynchronously poll Slack once, then read the selected route and confirm that
  the joined channel is still both selected and present.
5. Post `SLACK_GREETING_ACTIVE`.

If a route already exists, the `ON CONFLICT DO NOTHING` insert loses. Acknowledge
and stop: there is no membership write or ranked greeting for a second or later
channel.

Retain event-ID deduplication for the one non-idempotent first greeting. The route
insert itself is idempotent.

### Leave

Remove `member_left_channel` handling and remove that event from the Slack app
subscription. A leave has no state transition in the explicit-route model, so no
leave-event compatibility path is needed. Delivery, status, and commands use live
Slack state when they need to determine availability.

### Shared copy cleanup

Keep `SLACK_GREETING_ACTIVE`. Remove uses and then delete:

- `SLACK_GREETING_NEXT_IN_LINE`
- `SLACK_GREETING_QUEUED`
- `SLACK_PROMOTION_NOTICE`

Add a selected-channel-unavailable template/helper if the route failure contains a
channel mention. Update core selftests accordingly.

## Test plan

### Migration and store tests

Add coverage in `packages/service/scripts/selftest.mts` for:

- Migration backfills each team’s current oldest active membership.
- Migration ignores left memberships and leaves every existing
`channel_settings` row unchanged.
- A first route initialization returns `initializedRoute: true` without writing
channel settings.
- Second and third initialization attempts return false, do not change the route,
and create no `bot_channels` rows.
- The missed-event fallback initializes a route only from a single live membership.
- Several live memberships with no route do not cause an implicit selection.
- Leaving the selected channel requires no database write and leaves its route
unchanged.
- Rejoining the selected channel requires no database write.
- Switching preserves settings for the target and every other channel.
- Selecting the current channel is idempotent and preserves settings.
- Mention/approver updates fail their selected-route guard when a concurrent switch
selects a different channel.
- Team isolation remains intact.
- Concurrent first joins and channel switches honor the advisory-lock invariants.

### Resolver and video tests

Replace oldest/failover expectations with:

- No membership/no route returns the onboarding error.
- Exactly one membership with no route initializes the missed-event fallback.
- Multiple memberships with no route return the explicit-selection error.
- Multiple memberships with a route continue resolving to the explicit channel.
- An explicit switch changes the video upload and validation destination.
- Removing the selected channel does not fall back to another membership.
- Selected-channel absence fails the cycle with the actionable Check Run summary
and HTTP 422.
- Rejoining the selected channel resumes delivery.
- Two repositories in one team share the explicit route.
- A mid-cycle switch is observed at video-post time.
- The `/start` onboarding probe recognizes a sole membership without writing a
  route; `/video` subsequently initializes the missed-event fallback.
- When `/video` wins fallback initialization, it emits one active greeting; a
  delayed join event does not emit a duplicate.
- Route reads occur after membership polls, so switches committed during the poll
  are observed.

### Event tests

Update the current greeting/promotion block:

- First bot join posts exactly one active greeting.
- Retried first-join delivery does not duplicate the greeting.
- Second and third bot joins post nothing and write no membership rows.
- Non-bot joins remain ignored and unlogged.
- A live poll that notices the selected channel’s removal posts nothing.
- Greeting confirmation reads the selected route after its membership poll.

Assert `postMessageCalls` explicitly so the absence of queue and promotion notices
is regression-protected.

### Command tests

Add:

- Public and private escaped channel mention parsing.
- Missing target, multiple target, and malformed/plain-name errors.
- Command from a channel without the bot succeeds.
- Command from a DM succeeds.
- Target without the bot fails.
- Team mismatch fails.
- Any user can switch; no approver/admin check is consulted.
- Switch sends an empty immediate ack followed by exactly one ephemeral response.
- Switch produces no `chat.postMessage` call.
- Switch preserves mention and approvers and reports only the routing change.
- Selecting the same channel preserves settings.
- Switching to a channel with saved targets who are no longer members still
succeeds; `/feature-rec channel` does not revalidate settings.
- Status reports the explicit route and contains no fallback queue.
- Status reports an unavailable selected route clearly.
- Slow Slack lookups do not delay the three-second slash-command ack.

### Membership-validation tests

For both mention and approver commands:

- A direct user in the selected channel succeeds.
- A missing direct user returns an ephemeral error and leaves stored settings
unchanged.
- A usergroup whose complete returned membership is in the channel succeeds.
- A usergroup with one missing member fails atomically.
- An empty usergroup fails.
- Multiple targets are deduplicated before validation.
- `@here` and `@channel` retain their special behavior; `@channel` clears an
  approver restriction without member validation.
- `off` is rejected for mentions, while a previously stored empty mention remains
  readable for backward compatibility. `everyone` and `off` are rejected for
  approvers.
- Mention and approver commands always update the selected video channel’s settings, regardless of where the command is invoked.
- An unavailable selected route prevents settings changes.
- Paginated `conversations.members` responses are fully consumed.
- Slack API failures produce the generic ephemeral failure and no database write.

### Approval regression tests

Retain existing open/restricted approval and request-changes tests. Add a switch
case proving:

- New validations in the selected target use that channel’s pre-existing mention
and approver settings.
- A stale saved mention does not prevent video upload or validation-message
posting.
- A stale approver restriction can leave no eligible clicker, and
`/feature-rec approvers @channel` restores approval access.
- A validation already posted in the previous channel continues using that
channel’s approver settings.
- A later approver change in the new selected channel does not affect pending
validations in the previous channel.

## Documentation changes

Update:

- `README.md`: replace oldest-channel/failover onboarding language with explicit
selection and the new command.
- `docs/setup-and-operations.md`: update onboarding, command table, event behavior, status
output, no-channel recovery, and smoke checks.
- `docs/plans/seamless-slack-onboarding-plan.md`: add a short “superseded routing
behavior” note linking to this plan; keep the rest as historical design context.

Document that:

- Additional bot joins are intentionally silent.
- Removing the selected bot does not fail over.
- `/feature-rec channel #channel` is the only way to switch while the old channel
is absent.
- A switch preserves the target channel’s mention setting and approvers.
- All slash commands can be run from any conversation or DM in the installed
workspace; settings commands update the selected channel’s configuration and
validate targets against that channel.
- All configured users/usergroup members must belong to the selected channel.
- Slash-command escaping must remain enabled.
- The Slack app only needs the `member_joined_channel` bot event after rollout;
remove the obsolete `member_left_channel` subscription.

No Slack app reinstall should be needed because the required read scopes are
already documented and installed. Verify this in a staging workspace before
production rollout.

## Implementation sequence


| #   | Change                                                                                                                                                   | Primary files                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Add explicit team route migration, schema type, route backfill, and migration registration                                                               | `storage/migrations/0005_explicit_channel_routing.ts`, `storage/migrations/index.ts`, `storage/schema.ts` |
| 2   | Add route store methods, guarded selected-channel setting updates, settings-preserving channel switches, and remove persisted-membership runtime methods | `storage.ts`, `storage/postgres.ts`                                                                       |
| 3   | Remove membership reconciliation and resolve from the explicit route plus transient Slack polls                                                          | `channels.ts`, core Slack copy                                                                            |
| 4   | Add paginated channel-member and reusable usergroup-member Slack helpers                                                                                 | `slack.ts`                                                                                                |
| 5   | Add `/feature-rec channel`, shared command context, selected-channel settings lookup, and membership validation                                          | `http.ts`                                                                                                 |
| 6   | Make later joins silent, delete leave-event handling, and remove all queue greetings/promotion notices                                                   | `http.ts`, core constants                                                                                 |
| 7   | Replace queue/failover tests and add route, command, membership, race, and regression coverage                                                           | service/core selftests                                                                                    |
| 8   | Update README and Slack setup/operations documentation                                                                                                   | `README.md`, `docs/setup-and-operations.md`, prior plan note                                                       |
| 9   | Run formatting/lint, typecheck, full selftests, and a staging Slack smoke test                                                                           | repository-wide                                                                                           |
| 10  | After the rollback window closes, drop the legacy membership table and remove its schema type in a separate cleanup PR                                   | new cleanup migration, `storage/schema.ts`                                                                |


Steps 1–3 should land together in one deployable commit or remain on one branch:
the resolver must not depend on a route table before migration registration and
backfill exist. Later steps can be review-sized commits as long as the branch is
not deployed between them.

## Rollout and observability

1. Deploy the additive migration and service together.
2. Confirm migration counts:
  - number of active teams;
  - number of backfilled routes;
  - no team has more than one route row by primary-key construction.
3. For a staging workspace:
  - verify the existing channel remains selected after deploy;
  - invite the bot to a second channel and observe no message;
  - switch from the second channel to it and observe only ephemeral confirmation;
  - verify the target channel’s existing settings are preserved;
  - test a missing mention/approver member error;
  - remove the selected channel and verify there is no promotion;
  - switch from another bot channel and deliver a validation.
4. Emit structured logs for route initialization and switches containing
  `teamId`, old/new channel IDs, selection source, and invoking user ID. Do not log
   complete Slack event or channel-member payloads.
5. Track resolver failures separately as `no_route` and
  `selected_channel_unavailable` so rollout problems are distinguishable from
   incomplete onboarding.

The additive rollout initially remained schema-safe for the previous queue-based
service. Migration `0006` ends that compatibility window: after cleanup, rollback is
limited to explicit-route binaries. Recovering the legacy membership snapshot
requires restoring the pre-cleanup database backup.

## Post-deployment cleanup

Migration `0006_drop_legacy_bot_channels` implements this separate follow-up
cleanup. It must be deployed only after the preconditions below are complete.
`channel_settings` remains a live production table and is not part of cleanup.

### Preconditions

Before creating the destructive cleanup migration:

1. Keep the new feature deployed for the team’s agreed rollback/observation
  window.
2. Confirm every running service instance is on the explicit-route release; no old
  process may still read or write the legacy membership table.
3. Confirm route initialization, channel switches, video delivery, mention changes,
  approver changes, and approval clicks are healthy in production.
4. Compare the expected onboarded workspaces with `team_channel_routes` and
  investigate any missing route row.
5. Validate that settings exist or correctly default for each selected route.
6. Take a database snapshot or export of `bot_channels`.
  Record where it is retained according to the project’s backup policy.
7. Explicitly accept that rollback to a queue-based binary will no longer be
  supported after the cleanup migration.

### Cleanup migration

The registered forward migration `0006_drop_legacy_bot_channels.ts` performs:

```sql
drop table bot_channels;
```

Do not edit or delete historical migration files `0002_channel_routing.ts` or
`0004_last_left_at.ts`: fresh databases still need the complete migration history
before `0006` removes `bot_channels`. Migration `0002` also creates
`channel_settings`, which remains required.

The cleanup migration is intentionally destructive. Its `down` migration may
recreate the empty legacy table shape for migration-tool symmetry, but it cannot
restore membership history. Operational rollback must use the pre-cleanup database
snapshot, not an empty down migration.

### Code and documentation deletion

In the same cleanup PR:

- Remove `BotChannelsTable` from `packages/service/src/storage/schema.ts` and from
`DB`; keep `ChannelSettingsTable`.
- Remove any remaining legacy `BotChannel` types, SQL helpers, fixtures, and tests
that exist solely for the dropped membership table.
- Confirm no production query contains `bot_channels`; continue testing
`channel_settings`.
- Keep `SlackClient.listBotChannels`; it remains necessary for transient target
and availability checks even though memberships are no longer persisted.
- Remove rollback notes that imply an old queue-based service is still supported.
- Update operational documentation to identify `team_channel_routes` as the route
source of truth and `channel_settings` as the per-channel mention/approver source
of truth.

### Cleanup verification

After deploying the cleanup:

1. Confirm `bot_channels` is absent while `team_channel_routes` and
  `channel_settings` row counts and contents are unchanged.
2. Run `/feature-rec status`, `channel`, `mention`, and `approvers`.
3. Deliver and approve/reject a validation.
4. Verify a second bot join remains silent and creates no database row.
5. Run typecheck, lint, and the complete selftest suite against a fresh database so
  the full `0001` through `0006` migration chain is exercised.
6. Monitor for `bot_channels` undefined-table errors and channel-settings parse
  failures during the normal production observation period.

## Acceptance criteria

- [ ] First observed bot membership for a new team is selected and receives one
  ```
  active greeting.
  ```
- [ ] Every later join is silent, writes no membership state, and cannot change
  ```
  the route.
  ```
- [ ] Video delivery uses the explicit selected channel, not membership age.
- [ ] `/feature-rec channel #channel` works from any workspace conversation or DM
  ```
  for any Slack user.
  ```
- [ ] Only the target channel is checked against live bot membership; the source
  ```
  conversation is never rejected because the bot is absent.
  ```
- [ ] A successful switch emits only an ephemeral response.
- [ ] A switch preserves the target channel’s mention and approver settings.
- [ ] Removing the selected channel never promotes another channel or sends a
  ```
  notice.
  ```
- [ ] Mention and approver changes update the selected channel’s settings and
  ```
  validate their targets against that channel.
  ```
- [ ] Every concrete configured user is verified as a selected-channel member
  ```
  before persistence.
  ```
- [ ] Invalid commands and Slack API failures leave route/settings unchanged.
- [ ] Status and documentation contain no queue/fallback behavior.
- [ ] Migration preserves the channel and settings effective before deployment.
- [ ] Typecheck, lint, core selftests, and service Postgres selftests pass.
