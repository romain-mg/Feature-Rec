import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCycleKey,
  isAllowedPullRequestEvent,
  parseFeatureRecConfig,
  renderTemplate,
} from "../src/index";

const config = parseFeatureRecConfig(`
version: 1
github:
  checkName: Feature-Rec
  mention: "@claude"
  acceptComment: "@{pr_author} validation passed; you can merge."
  rejectComment: "{mention} make the following changes:\\n\\n{review_comment}"
slack:
  channel: "C0123"
  mention: "<!subteam^S123|@reviewers>"
  approverUsergroups: ["S123"]
`);

assert.equal(config.github.checkName, "Feature-Rec");
assert.equal(config.github.mention, "@claude");
assert.equal(config.slack.approverUsergroups[0], "S123");
assert.equal(
  renderTemplate(config.github.acceptComment, { pr_author: "romain" }),
  "@romain validation passed; you can merge.",
);
assert.equal(
  renderTemplate(config.github.rejectComment, {
    mention: config.github.mention,
    review_comment: "make it feel premium",
  }),
  "@claude make the following changes:\n\nmake it feel premium",
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

const yamlConfig = parseFeatureRecConfig(`
version: 1
github:
  checkName: Feature-Rec
  mention: "@claude"
  acceptComment: "@{pr_author} validation passed; you can merge."
  rejectComment: |
    {mention} make the following changes:

    {review_comment}
slack:
  channel: "C0123 # design-review"
  mention: ""
  approverUsergroups:
    - "S123"
`);
assert.equal(yamlConfig.slack.channel, "C0123 # design-review");
assert.equal(
  yamlConfig.github.rejectComment,
  "{mention} make the following changes:\n\n{review_comment}\n",
);

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleConfig = parseFeatureRecConfig(
  fs.readFileSync(path.resolve(here, "../../../examples/feature-rec-config.yaml"), "utf8"),
);
assert.equal(exampleConfig.github.mention, "@claude");

console.log("core selftest passed");
