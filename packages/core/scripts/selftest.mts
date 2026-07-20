import assert from "node:assert/strict";
import {
  buildCycleKey,
  GITHUB_ACCEPT_COMMENT,
  GITHUB_REJECT_COMMENT,
  isAllowedPullRequestEvent,
  renderTemplate,
  SLACK_GREETING_ACTIVE,
  SLACK_GREETING_NEXT_IN_LINE,
  SLACK_GREETING_QUEUED,
  SLACK_NO_CHANNEL_MESSAGE,
  SLACK_PROMOTION_NOTICE,
} from "../src/index";

assert.equal(
  renderTemplate(GITHUB_ACCEPT_COMMENT, { pr_author: "romain" }),
  "@romain validation passed; you can merge.",
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
    owner: "o",
    repo: "r",
    prNumber: 7,
    headSha: "abc1234",
  }),
  "o/r#7:abc1234",
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
assert.equal(SLACK_PROMOTION_NOTICE.includes("{"), false);
assert.equal(SLACK_NO_CHANNEL_MESSAGE.includes("{"), false);
assert.equal(
  renderTemplate(SLACK_GREETING_NEXT_IN_LINE, { active_channel: "<#C0123>" }),
  "Connected, validations currently go to <#C0123>. Remove me from that channel if you want reviews to happen here instead.",
);
assert.equal(
  renderTemplate(SLACK_GREETING_QUEUED, { active_channel: "<#C0123>" }),
  "Connected but currently unused, validations go to <#C0123>. Remove me from other channels to use this one.",
);

console.log("core selftest passed");
