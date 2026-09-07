import assert from "node:assert/strict";
import {
  buildCycleKey,
  buildTenantCycleKey,
  buildLegacyCycleKey,
  normalizeOidcAudience,
  RunStartRequestSchema,
  RunStartResponseSchema,
  GITHUB_ACCEPT_COMMENT,
  GITHUB_REJECT_COMMENT,
  isAllowedPullRequestEvent,
  renderTemplate,
  SLACK_GREETING_ACTIVE,
  SLACK_MULTIPLE_CHANNELS_MESSAGE,
  SLACK_NO_CHANNEL_MESSAGE,
  slackSelectedChannelUnavailableMessage,
} from "../src/index";

assert.equal(
  renderTemplate(GITHUB_ACCEPT_COMMENT, { pr_author: "romain" }),
  "@romain validation passed, you can merge.",
);
assert.equal(
  renderTemplate(GITHUB_REJECT_COMMENT, {
    pr_author: "romain",
    review_comment: "make it feel premium",
  }),
  "@romain make the following changes:\n\nmake it feel premium",
);
assert.equal(
  buildCycleKey({
    tenantId: "tenant-a",
    repositoryId: "9223372036854775807",
    prNumber: 7,
    headSha: "abc1234",
  }),
  "tenant-a/9223372036854775807#7:abc1234",
);
assert.equal(buildTenantCycleKey, buildCycleKey);
assert.equal(buildLegacyCycleKey({ owner: "o", repo: "r", prNumber: 7, headSha: "abc1234" }), "o/r#7:abc1234");
assert.notEqual(
  buildCycleKey({ tenantId: "a", repositoryId: "1", prNumber: 7, headSha: "abc1234" }),
  buildCycleKey({ tenantId: "b", repositoryId: "1", prNumber: 7, headSha: "abc1234" }),
);
assert.equal(normalizeOidcAudience("HTTPS://EXAMPLE.COM:443/review///"), "https://example.com/review");
assert.equal(normalizeOidcAudience("http://127.0.0.1:3000/", { allowLoopbackHttp: true }), "http://127.0.0.1:3000");
assert.equal(normalizeOidcAudience("http://[::1]:3000/", { allowLoopbackHttp: true }), "http://[::1]:3000");
for (const url of ["", "bad", "http://localhost:3000", "http://example.com", "https://user:pass@example.com", "https://example.com?", "https://example.com/#", "https://example.com?x=1", "https://example.com#f"]) {
  assert.throws(() => normalizeOidcAudience(url), /base URL/);
}
assert.throws(() => normalizeOidcAudience("http://localhost.example.com", { allowLoopbackHttp: true }), /base URL/);
assert.deepEqual(RunStartRequestSchema.parse({ owner: "untrusted", tenantId: "untrusted", prTitle: "untrusted", prNumber: 7, headSha: "abc1234" }), { prNumber: 7, headSha: "abc1234" });
for (const reason of ["closed", "draft", "stale_head"]) {
  assert.deepEqual(RunStartResponseSchema.parse({ skipped: true, reason }), { skipped: true, reason });
}
assert.equal(
  buildTenantCycleKey({
    tenantId: "c647960e-af6a-42d3-a7e5-49c258fa5a11",
    repositoryId: "9007199254740991",
    prNumber: 7,
    headSha: "abc1234",
  }),
  "c647960e-af6a-42d3-a7e5-49c258fa5a11/9007199254740991#7:abc1234",
);
assert.equal(
  isAllowedPullRequestEvent({
    action: "opened",
    pull_request: { state: "open", draft: false },
  }),
  true,
);
assert.equal(
  isAllowedPullRequestEvent({
    action: "reopened",
    pull_request: { state: "open", draft: false },
  }),
  false,
);
assert.equal(
  isAllowedPullRequestEvent({
    action: "synchronize",
    pull_request: { state: "open", draft: true },
  }),
  false,
);

assert.equal(SLACK_GREETING_ACTIVE.includes("{"), false);
assert.ok(SLACK_GREETING_ACTIVE.includes("/feature-rec help"));
assert.equal(SLACK_NO_CHANNEL_MESSAGE.includes("{"), false);
assert.ok(SLACK_MULTIPLE_CHANNELS_MESSAGE.includes("/feature-rec channel"));
assert.equal(
  slackSelectedChannelUnavailableMessage("C0123"),
  "Feature-Rec is not currently in the selected review channel <#C0123>. Invite @Feature-Rec back or run `/feature-rec channel #another-channel` from any workspace conversation, then re-run.",
);

console.log("core selftest passed");
