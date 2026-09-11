# B2 implementation and verification — 2026-09-10

Local branch: `feat/oidc-multitenancy-pr-b2`. This records checkout evidence, not a deployment.

## Milestone status

| Step | Status | Evidence |
| --- | --- | --- |
| 1. SDK/configuration | Implemented | Configuration, safe SDK logging, timeout/retry tests |
| 2. Persistence | Implemented | PostgreSQL claims, key checks, encryption, cancellation, rollback tests |
| 3. Public start | Implemented | Real SDK redirect/scopes, independent cookies, rate limiting, secret-safe failures |
| 4. Callback | Implemented | Real SDK exchanges against a local fake Slack server; app/team/bot/scopes checks; encrypted staging |
| 5. Operator activation | Implemented | Compiled CLI, exact envelope transfer, atomic activation/consumption, status/cancel and manual input |
| 6. Reliability/isolation | Implemented | Three callback-to-provisioning tenant pairs, replica races/restarts, retry, runtime token routing, cleanup shutdown |
| 7. Packaging/rollback | Implemented and locally checked | Production image, compiled commands, partial config, 0009→0008→0009 and retained B image ordering |
| 7. Hosted installation/observation | Open | Needs configured hosted backend, two real workspaces and distinct GitHub owners/installations, live smoke, observation/readiness and backup evidence |

## Checks

- `make ci` passed: workspace typecheck/lint and all repository selftests.
- Focused HTTP tests additionally exercise the same callback-created records through
  provider validation, failed-validation retry, exact ciphertext transfer, competing
  activation, and tenant-specific runtime token lookup for three tenants.
- Scheduler tests prove a 60-second interval, no overlapping cleanup transaction,
  and shutdown waiting for the active sweep while a real PostgreSQL lock is held.
- The production-image harness uses a fresh uniquely named local database, dummy
  OAuth credentials, and temporary containers. No production data is involved.
- The retained `feature-rec-service:pr-b` image refuses schema 0009, starts after
  rollback to 0008, and the B2 image starts after migration forward to 0009.
- Design, operations documentation and diagram implementation markers are updated.

Reproduce the packaging check after building the image:

```bash
docker build --tag feature-rec-b2:local .
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  PREVIOUS_SERVICE_IMAGE=feature-rec-service:pr-b \
  pnpm --filter @feature-rec/service exec tsx scripts/service-image-selftest.mts feature-rec-b2:local
```

Omit `PREVIOUS_SERVICE_IMAGE` when a retained B image is unavailable; CI still
checks the forward/down/forward schema and compiled B2 commands.

## Review fixes

- Fixed query disclosure in Fastify's default not-found handler. A request serializer
  alone did not protect disabled/wrong-method OAuth routes; the handler now returns
  a fixed response, with disabled/POST/HEAD/not-found secret-redaction regressions.
- Fixed failed-start cookie cleanup: response adapters must wrap the original header
  setter so a later deletion cannot be replaced by an earlier binding-cookie value.
  A fault-injected SDK redirect-generation failure exercises this path.

## Remaining release gate

Local tests never grant Slack permissions, install an app in a real workspace or
prove hosted routing. The local environment lacks OAuth app credentials, a hosted
base URL and encryption-key configuration; no real two-workspace target inventory
was supplied during this implementation. Hosted configuration was not inspected.

Complete the [runbook](../setup-and-operations.md#hosted-slack-oauth-installation-b2)
and [live smoke matrix](feature-rec-oidc-multitenancy-plan.md#end-to-end-beta-smoke-matrix) with the
actual targets, retain a backup, and record observation plus a clean contract
readiness report before allowing C. Keep C's separate work and migration renumbering
out of this checkout. No Feature-Rec push, deployment or live-provider mutation was
performed during this implementation.

## Pre-PR verification — 2026-09-11

The full `make ci` gate passed again before publication. A newly built
`feature-rec-b2:ship` production image passed the isolated service-image harness
with `PREVIOUS_SERVICE_IMAGE=feature-rec-service:pr-b`, including compiled admin,
configured/disabled startup, callback response handling and 0009→0008→0009 rollback
with the retained B artifact. No production data or live provider configuration
was used. The upstream PR target is `Hanibzd/Feature-Rec:main`; its baseline
`8aad709` matches the earlier review. Hosted release checks above remain open.
