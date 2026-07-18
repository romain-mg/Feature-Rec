import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCycleKey,
  GITHUB_ACCEPT_COMMENT,
  GITHUB_REJECT_COMMENT,
  isAllowedPullRequestEvent,
  parseFeatureRecConfig,
  renderTemplate,
} from "../src/index";

const config = parseFeatureRecConfig(`
version: 1
slack:
  channel: "C0123"
  mention: "<!subteam^S123|@reviewers>"
  approverUsergroups: ["S123"]
`);

assert.equal(config.slack.approverUsergroups[0], "S123");
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
    configHash: "cfg",
  }),
  "o/r#7:abc1234:cfg",
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

// Legacy configs that still set the removed github section must keep parsing:
// unknown keys are stripped rather than rejected.
const yamlConfig = parseFeatureRecConfig(`
version: 1
github:
  checkName: legacy-section-now-ignored
  mention: "@claude"
  acceptComment: "legacy key, now ignored"
slack:
  channel: "C0123 # design-review"
  mention: ""
  approverUsergroups:
    - "S123"
`);
assert.equal(yamlConfig.slack.channel, "C0123 # design-review");
assert.equal("github" in yamlConfig, false);

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleConfig = parseFeatureRecConfig(
  fs.readFileSync(path.resolve(here, "../../../examples/feature-rec-config.yaml"), "utf8"),
);
assert.equal(exampleConfig.slack.channel, "C0123456789");

console.log("core selftest passed");
