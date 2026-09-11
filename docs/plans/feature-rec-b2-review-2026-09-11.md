# B2 pre-landing review — 2026-09-11

**Result: 3 findings fixed, 0 unresolved code findings.** Local B2 scope is addressed. Hosted release verification remains open.

## Scope and method

Reviewed branch `feat/oidc-multitenancy-pr-b2`, HEAD `750e8a4`, against merge base
`8aad709b51fa1a2ea17fa5594b4c04b4b1912f95` with fetched `origin/main`. Scope includes
the committed SDK setup and all uncommitted/untracked B2 source, tests and docs.
At review time, no PR existed for this branch. The review itself did not commit, push or deploy Feature-Rec.

The gstack `/review` checklist was applied alongside three independent reviewers:
HTTP/security, data/transactions, and acceptance tests/packaging. The installed
skill’s specialist templates and referenced numeric scoring step are absent;
reviewers used its available checklist and source directly. No numeric quality
score is claimed. Prior review records had no skipped finding to suppress.

**Scope check: CLEAN after fixes.** The initial acceptance-test gap below is fixed.
C/D implementation and hosted environment state are outside this checkout review.

## Findings resolved

1. **P2, confidence 9/10: independent callback concurrency was not tested.**
   The original three-workspace loop used `const response = await callback(replica, session, value);`.
   It completed installations serially; the overlapping callback case replayed one
   session. The required test now holds three distinct exchanges open on one app
   and finishes them in reverse order, checking the matching completion ID,
   workspace, bot, token and downstream activation. Waiting is bounded and failure
   cleanup releases every gate. This closes an acceptance-test gap; no production
   race was demonstrated. See [the regression](../../packages/service/scripts/slack-oauth-http-selftest.mts#L255).
2. **P3, confidence 10/10: setup and rollback instructions described unfinished code.**
   The runbook said there was “no operator command yet” and that service routes
   could not create sessions. Updated configuration requirements, implementation
   markers, unusable-token recovery and rollback. The rollback procedure now
   identifies unconsumed rows, invokes compiled cancellation and requires an empty
   result before downgrade. See [the runbook](../setup-and-operations.md)
   and [.env.example](../../.env.example).
3. **P3, confidence 10/10: staging comment overstated key-guard work.**
   “Check every stored token before writing this one” was inaccurate when a verifier
   already exists. The comment now says “Verify/pin the deployment key before
   writing”; behavior is unchanged. See [storage](../../packages/service/src/storage/slack-oauth.ts#L82).

All three issues are also appended to the bottom of the
[design plan](feature-rec-oidc-multitenancy-plan.md#b2-pre-landing-review--2026-09-11).

## Verification

Re-executed during this review, all passed:

- SDK selftest: `node --import tsx scripts/slack-oauth-selftest.mts` from `packages/service`.
- HTTP integration: `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @feature-rec/service exec tsx scripts/slack-oauth-http-selftest.mts` (exit 0). The test creates a unique database and uses fake Slack.
- `pnpm --filter @feature-rec/service run typecheck` and `pnpm exec eslint packages/service/scripts/slack-oauth-http-selftest.mts --max-warnings=0` (both exit 0).
- Final `git diff --no-ext-diff --check` and documentation/link inspection.

The complete CI suite and production-image rollback harness passed during the
preceding implementation on 2026-09-10; this review inspected their recorded
results and test code, and did not rerun those broad checks. See the
[implementation verification record](feature-rec-b2-verification.md). The only
executable change made during this review is the concurrency regression.

## Plan completion audit

Plan: `docs/plans/feature-rec-oidc-multitenancy-plan.md`, B2 contract and milestones.
This audits B2, excluding earlier A/B work, separate C/D implementation and accepted
deferrals. “Done” means present and verified in this checkout, not shipped.
Paths below are relative to `packages/service` unless rooted at `.github`.

| Category | Item | Status / mode | Evidence |
| --- | --- | --- | --- |
| CONFIG | SDK configuration, fixed redirect, safe logger, bounded timeout and no exchange retry | DONE / diff-verifiable | `src/env.ts; src/slack-oauth.ts; pnpm-lock.yaml` |
| CODE | Fixed public start URL with direct SDK redirect and required bot scopes | DONE / diff-verifiable | `src/slack-oauth-http.ts` |
| CODE | Random state and independent browser binding; only hashes persisted | DONE / diff-verifiable | `src/slack-oauth-http.ts; src/storage/slack-oauth.ts` |
| CODE | Secure/HttpOnly/SameSite cookies, restart behavior and reliable deletion | DONE / diff-verifiable | `src/slack-oauth-http.ts` |
| CODE | Browser validation before atomic claim; single-use claim before external exchange | DONE / diff-verifiable | `src/slack-oauth-http.ts; src/storage/slack-oauth.ts` |
| CODE | Validate normalized app, team, bot, scopes and supported token model; cross-check auth.test | DONE / diff-verifiable | `src/slack-oauth.ts; src/slack-oauth-http.ts` |
| CODE | Encrypt verified pending token with existing key and workspace AAD, under key guard | DONE / diff-verifiable | `src/storage/slack-oauth.ts; src/storage/slack-token-check.ts` |
| CODE | Ten-minute session expiry, no pending expiry, explicit cancellation and bounded cleanup | DONE / diff-verifiable | `src/storage/slack-oauth.ts; src/slack-oauth-http.ts` |
| CODE | Safe completion and sanitized failures/logs; no-store and no-referrer | DONE / diff-verifiable | `src/slack-oauth-http.ts; src/http.ts` |
| CODE | Per-process request budgets; no overlapping cleanup; shutdown drains active sweep | DONE / diff-verifiable | `src/slack-oauth-http.ts; src/index.ts` |
| CODE | Pending-ID provisioning reuses provider validation and existing pairing/confirmation guards | DONE / diff-verifiable | `src/admin-input.ts; src/admin-operations.ts; src/admin.ts` |
| CODE | Copy validated envelope unchanged; active writes and exact-envelope consumption are atomic | DONE / diff-verifiable | `src/admin-operations.ts; src/storage/slack-oauth.ts` |
| CODE | Sanitized status/cancel and lost-response recovery; preserve manual-token input | DONE / diff-verifiable | `src/admin.ts; src/admin-input.ts; src/storage/slack-oauth.ts` |
| CODE | Pending credentials cannot run product workflows; retain enabled-tenant runtime resolution | DONE / diff-verifiable | `src/slack-resolver.ts; scripts/slack-oauth-http-selftest.mts` |
| TEST | Configuration, actual SDK normalization, identity checks, retry and logger boundaries | DONE / diff-verifiable | `scripts/slack-oauth-selftest.mts` |
| TEST | Start redirects, scopes, unpredictable state, cookies, browser binding and callback rejection | DONE / diff-verifiable | `scripts/slack-oauth-http-selftest.mts` |
| TEST | Independent callback overlap, reverse completion, duplicate races, replica handoff and restart | DONE / diff-verifiable | `scripts/slack-oauth-http-selftest.mts:255; remaining race/restart cases in the same suite` |
| TEST | Invalid identities/scopes/token models and ambiguous provider errors | DONE / diff-verifiable | `scripts/slack-oauth-http-selftest.mts` |
| TEST | Secret-free responses/logs including disabled, wrong-method and unknown routes | DONE / diff-verifiable | `scripts/slack-oauth-http-selftest.mts` |
| TEST | Three callback-created workspace/GitHub-owner pairs through activation and runtime routing | DONE / diff-verifiable | `scripts/slack-oauth-http-selftest.mts` |
| TEST | Old pending availability, failed validation retry, cancellation, single consumption and reinstall isolation | DONE / diff-verifiable | `scripts/slack-oauth-http-selftest.mts; scripts/admin-selftest.mts; scripts/slack-oauth-storage-selftest.mts` |
| TEST | Key pinning, transaction rollback and expiry recheck under real PostgreSQL locks | DONE / diff-verifiable | `scripts/slack-oauth-storage-selftest.mts` |
| TEST | Rate limits and cleanup scheduling, batch bounds, non-overlap and graceful shutdown | DONE / diff-verifiable | `scripts/slack-oauth-http-selftest.mts; scripts/slack-oauth-storage-selftest.mts` |
| TEST | Compiled operator inputs, status, cancellation and manual-token compatibility | DONE / diff-verifiable | `scripts/admin-input-selftest.mts; scripts/admin-selftest.mts; scripts/service-image-selftest.mts` |
| MIGRATION | Add only 0009 OAuth storage; retain B compatibility and leave C/D integration separate | DONE / diff-verifiable | `src/storage/migrations/0009_slack_oauth_installations.ts; src/storage/migrations/index.ts; src/storage/postgres.ts` |
| MIGRATION | Forward/down/forward preserves active data; rollback guards unconsumed rows | DONE / diff-verifiable | `scripts/slack-oauth-storage-selftest.mts; scripts/storage-selftest.mts` |
| TEST | Production packaging, configured/disabled health, compiled CLI and older-artifact ordering | DONE / diff-verifiable | `scripts/service-image-selftest.mts; .github/workflows/ci.yaml; prior local execution receipt` |
| DOCS | Configuration, installation, provisioning, recovery and B2-to-B rollback runbook | DONE / diff-verifiable | `../../.env.example; ../../docs/setup-and-operations.md` |
| DOCS | Current implementation markers, release boundaries and reproducible local evidence | DONE / diff-verifiable | `../../docs/plans/feature-rec-oidc-multitenancy-plan.md; ../../docs/plans/feature-rec-b2-verification.md` |
| DOCS | Crypto guide and sequence/state artifacts reflect no pending expiry and exact-envelope activation | DONE / cross-repo | Separately maintained supporting artifacts were verified: `oauth-crypto-guide.md`, four `oauth-crypto-*.mmd` sources and their SVG/PNG/Excalidraw artifacts; inspected implementation labels and activation flow. |
| CONFIG | Slack app distribution, bot scopes, token rotation disabled, exact hosted redirect and backend secrets | UNVERIFIABLE / external-state | Inspect actual Slack app and hosted service configuration. |
| TEST | Hosted authorization in two real workspaces and provisioning with distinct GitHub owners/installations | UNVERIFIABLE / external-state | Run the plan’s end-to-end beta smoke matrix against the real targets. |
| TEST | B observation evidence and clean validate-contract-readiness --require-future-cycle-keys | UNVERIFIABLE / external-state | Capture the report and observation evidence before C integration/release. |
| CONFIG | Fresh database backup and retained deployment artifacts before rollback or C rollout | UNVERIFIABLE / external-state | Verify actual backup and artifact inventory; local fixtures do not prove this. |

**Completion: 30/34 DONE, 0 PARTIAL, 0 NOT DONE, 0 CHANGED, 4 UNVERIFIABLE.**

External checks remain release gates; this review does not clear deployment or C.
Pending expiry, key rotation infrastructure and previously deferred optional
crypto unit-test matrices have not been reintroduced.

## Review notes

The review rechecked the prior cookie-adapter reentry and Fastify query-redaction
fixes, database-clock expiry checks, SDK handler ordering, key-verifier bootstrap,
exact-envelope consumption, rollback guards and retained B compatibility.

A malformed-path probe (`/api/slack/oauth/callback%?...`) reached Fastify’s generic
400 response and reflected caller-supplied input. The fixed registered callback
cannot produce that path, logs stayed sanitized, and no credential disclosure or
cross-user exploit was demonstrated. It was excluded as an actionable B2 security
finding. No extra runtime change was made for this probe.
