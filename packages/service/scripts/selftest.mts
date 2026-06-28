import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCycleKey, parseFeatureRecConfig } from "@feature-rec/core";
import { GitHubClient } from "../src/github";
import type { ServiceEnv } from "../src/env";
import { buildServer } from "../src/http";
import { verifySlackSignature } from "../src/slack";
import { SqliteCycleStore } from "../src/storage/sqlite";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feature-rec-"));
const store = new SqliteCycleStore(path.join(dir, "test.sqlite"));
const config = parseFeatureRecConfig(`
version: 1
github:
  checkName: Feature-Rec
  mention: "@claude"
  acceptComment: "@{pr_author} validation passed; you can merge."
  rejectComment: "{mention} make the following changes:\\n\\n{review_comment}"
slack:
  channel: "C0123"
  mention: ""
  approverUsergroups: []
`);

const start = {
  owner: "MathFreedom",
  repo: "Agora",
  prNumber: 1,
  prTitle: "Add button",
  prAuthor: "romain",
  headSha: "abc1234567",
  baseSha: "def1234567",
  configHash: "0123456789abcdef",
  checkName: "Feature-Rec",
  config,
};
const cycleKey = buildCycleKey(start);
const one = store.upsertCycle({ ...start, cycleKey });
const two = store.upsertCycle({ ...start, cycleKey });

assert.equal(one.id, two.id);
assert.equal(one.config.slack.channel, "C0123");
assert.equal(store.recordProcessedInteraction("i1", one.id), true);
assert.equal(store.recordProcessedInteraction("i1", one.id), false);
store.updateStatus(one.id, "pending_validation");
store.updateCheckRun(one.id, 123);
assert.equal(store.getCycle(one.id)?.status, "pending_validation");

const restrictedConfig = parseFeatureRecConfig(`
version: 1
github:
  checkName: Feature-Rec
  mention: "@claude"
  acceptComment: "@{pr_author} validation passed; you can merge."
  rejectComment: "{mention} make the following changes:\\n\\n{review_comment}"
slack:
  channel: "C0123"
  mention: ""
  approverUsergroups: ["S123"]
`);
const restrictedStart = {
  ...start,
  headSha: "abc1234568",
  configHash: "0123456789abcdea",
  config: restrictedConfig,
};
const restricted = store.upsertCycle({
  ...restrictedStart,
  cycleKey: buildCycleKey(restrictedStart),
});
store.updateStatus(restricted.id, "pending_validation");
store.updateCheckRun(restricted.id, 124);

const env: ServiceEnv = {
  port: 0,
  baseUrl: "http://localhost",
  dbPath: path.join(dir, "test.sqlite"),
  runnerToken: "runner-secret",
  githubToken: "",
  githubAppId: "",
  githubPrivateKey: "",
  slackBotToken: "",
  slackSigningSecret: "slack-secret",
};

const cycleForGithub = store.getCycle(one.id);
assert.ok(cycleForGithub);
const previousFetch = globalThis.fetch;
const githubCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const urlText = String(url);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  githubCalls.push({ url: urlText, body });
  const json = urlText.includes("/issues/")
    ? { html_url: "https://github.com/MathFreedom/Agora/pull/1#issuecomment-9" }
    : { id: 123 };
  return new Response(JSON.stringify(json), {
    status: urlText.includes("/issues/") ? 201 : 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

try {
  const client = new GitHubClient({ ...env, githubToken: "gh-token" });
  await client.reject(
    cycleForGithub,
    cycleForGithub.config.github.rejectComment,
    "make it feel premium",
  );
  await client.accept(cycleForGithub, cycleForGithub.config.github.acceptComment);
} finally {
  globalThis.fetch = previousFetch;
}

assert.equal(githubCalls[0].url.endsWith("/repos/MathFreedom/Agora/issues/1/comments"), true);
assert.equal(
  githubCalls[0].body.body,
  "@claude make the following changes:\n\nmake it feel premium",
);
assert.equal(githubCalls[1].url.endsWith("/repos/MathFreedom/Agora/check-runs/123"), true);
assert.equal((githubCalls[1].body.output as { summary: string }).summary.includes("issuecomment-9"), true);
assert.equal(
  (githubCalls[1].body.output as { summary: string }).summary.includes("make it feel premium"),
  false,
);
assert.equal(githubCalls[2].url.endsWith("/repos/MathFreedom/Agora/issues/1/comments"), true);
assert.equal(githubCalls[2].body.body, "@romain validation passed; you can merge.");
assert.equal(githubCalls[3].url.endsWith("/repos/MathFreedom/Agora/check-runs/123"), true);
assert.equal((githubCalls[3].body.output as { summary: string }).summary.includes("issuecomment-9"), true);

let accepted = 0;
let approverChecks = 0;
const github = {
  createCheckRun: async () => 125,
  updateCheckRun: async () => {},
  accept: async () => {
    accepted += 1;
  },
  reject: async () => {},
};
const slack = {
  uploadVideo: async () => {},
  postValidation: async () => ({ channel: "C0123", ts: "1710000000.000001" }),
  finalize: async () => {},
  openRequestChangesModal: async () => {},
  isApprover: async () => {
    approverChecks += 1;
    return false;
  },
};
const app = buildServer({ env, store, github: github as never, slack: slack as never });

const unauthorizedStart = await app.inject({
  method: "POST",
  url: "/api/runs/start",
  headers: { "content-type": "application/json" },
  payload: start,
});
assert.equal(unauthorizedStart.statusCode, 401);

const videoResponse = await app.inject({
  method: "POST",
  url: `/api/runs/${one.id}/video`,
  headers: {
    authorization: "Bearer runner-secret",
    "content-type": "application/octet-stream",
  },
  payload: Buffer.alloc(2 * 1024 * 1024),
});
assert.equal(videoResponse.statusCode, 200, videoResponse.body);

const timestamp = String(Math.floor(Date.now() / 1000));
assert.equal(
  verifySlackSignature({
    signingSecret: "",
    timestamp,
    signature: "v0=short",
    rawBody: "",
  }),
  false,
);
assert.equal(
  verifySlackSignature({
    signingSecret: env.slackSigningSecret,
    timestamp,
    signature: "v0=short",
    rawBody: "",
  }),
  false,
);

const invalidSlack = await app.inject({
  method: "POST",
  url: "/api/slack/interactivity",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": "v0=short",
  },
  payload: "payload={}",
});
assert.equal(invalidSlack.statusCode, 401);

const blockPayload = {
  type: "block_actions",
  trigger_id: "T123",
  user: { id: "U999" },
  actions: [
    {
      action_id: "feature_rec_accept",
      action_ts: "1710000000.000001",
      value: JSON.stringify({
        action: "accept",
        cycleId: restricted.id,
        headSha: restricted.headSha,
      }),
    },
  ],
};
const rawBlockBody = `payload=${encodeURIComponent(JSON.stringify(blockPayload))}`;
const blockSignature = `v0=${crypto
  .createHmac("sha256", env.slackSigningSecret)
  .update(`v0:${timestamp}:${rawBlockBody}`)
  .digest("hex")}`;
const blockResponse = await app.inject({
  method: "POST",
  url: "/api/slack/interactivity",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": blockSignature,
  },
  payload: rawBlockBody,
});
assert.equal(blockResponse.statusCode, 200);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(approverChecks, 1);
assert.equal(accepted, 0);
assert.equal(store.getCycle(restricted.id)?.status, "pending_validation");

await app.close();
store.close();
assert.throws(() => store.recordProcessedInteraction("i2", one.id));

console.log("service selftest passed");
