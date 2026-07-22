# Multitenancy Notes

Single-workspace assumptions currently baked into the service, recorded so the
multitenant redesign revisits them deliberately.

Note: v0 stores no `enterprise_id` anywhere. That is safe to defer because it
is always derivable — in the single-token era every row belongs to the token's
org (`auth.test` reports it), and at multitenancy time the org↔workspace
pairing table knows each team's org — so re-adding it is one nullable-column
migration plus a one-line backfill. Both concern how the backend
decides "which workspace am I talking to" — today there is exactly one answer,
so simple designs are correct; multi-workspace makes the same designs hazards.

## Tenant resolution: payload team id, with a single-tenant fallback

Interaction handlers prefer the team id carried by the Slack payload and fall
back to the bot token's own workspace (`auth.test`) when absent:

```typescript
const teamId = payload.team?.id ?? (await slack.botIdentity()).teamId;
```

The fallback is only correct while this backend serves a single workspace —
one env token, one tenant, so "whoever owns the token" is always the right
answer. In a multi-workspace deployment it becomes a wrong-tenant hazard: a
payload missing team context would silently resolve to whichever workspace the
global token belongs to, routing state into another tenant.

Multitenant version: never fall back to a global bot identity. Resolve the
tenant from the request's installation/enterprise context (payload `team_id` /
`enterprise_id` → pairing table) and use that tenant's token via
`tokenForTeam()`; treat missing team context as an error, not a default.

In practice the fallback should be nearly dead code — block actions, view
submissions, slash commands, and event callbacks all carry a team id. If it
ever fires, that is a payload shape worth understanding before multitenancy
makes it dangerous.

## Bot identity: cached `auth.test`, not a DB copy

Why `auth.test` instead of storing identity in the DB: Slack is the source of
truth for which installation the token belongs to. `auth.test` derives the bot
user id, team id, and enterprise id directly from `SLACK_BOT_TOKEN`, so
identity can never drift from the configured token — a DB copy would need
setup and synchronization logic to avoid stale or mismatched token/identity
records.

This is not a per-call query. The promise is cached:

```typescript
this.#identity ??= slackApi(...);
```

so each `SlackClient` instance normally calls `auth.test` once, and concurrent
callers share the same in-flight promise. On failure the cache is cleared
(`this.#identity = null`), letting a later call retry instead of pinning a
rejected promise forever.

Trade-offs:

- Current approach: simple, always consistent with `SLACK_BOT_TOKEN`; costs
  one Slack request per service instance/restart.
- DB approach: avoids that startup request and supports multiple
  installations, but requires storing token↔team mappings and keeping them
  correct.

For multi-workspace support the DB approach becomes necessary: store each
installation's bot token and select it by `teamId`/`enterpriseId`
(`tokenForTeam()`). For one global token, cached `auth.test` is the right
design — simpler and less error-prone, though not universally "better."
