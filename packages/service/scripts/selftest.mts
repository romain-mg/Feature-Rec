import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Client } from "pg";
import {
  buildCycleKey,
  parseFeatureRecConfig,
  type RunStartRequest,
} from "@feature-rec/core";
import { GitHubClient } from "../src/github";
import type { ServiceEnv } from "../src/env";
import { buildServer } from "../src/http";
import { verifySlackSignature } from "../src/slack";
import { PostgresCycleStore } from "../src/storage/postgres";

// Requires a Postgres reachable at TEST_DATABASE_URL (an admin/maintenance DB).
// The suite creates a uniquely named database, runs against it, then drops it,
// so parallel CI runs can't collide. Local one-liner:
//   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:18
const adminUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

// CREATE/DROP DATABASE can't take bound params, so the name comes from a
// safe-identifier alphabet only (lowercase hex + underscores).
const dbName = `feature_rec_test_${crypto.randomBytes(8).toString("hex")}`;

const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();

const testUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
})();

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

const env: ServiceEnv = {
  port: 0,
  baseUrl: "http://localhost",
  databaseUrl: testUrl,
  runnerToken: "runner-secret",
  githubToken: "",
  githubAppId: "",
  githubPrivateKey: "",
  slackBotToken: "",
  slackSigningSecret: "slack-secret",
};

const RUNNER_AUTH = `Bearer ${env.runnerToken}`;

type StartResponse = {
  cycleId?: string;
  cycleKey?: string;
  checkRunId?: number;
  duplicate?: boolean;
  attemptId?: string;
};

type ResultResponse = { ok?: boolean; stale?: boolean; error?: string };

type AppInstance = ReturnType<typeof buildServer>;

const apps: AppInstance[] = [];

function makeApp(github: unknown, slack: unknown): AppInstance {
  const app = buildServer({ env, store, github: github as never, slack: slack as never });
  apps.push(app);
  return app;
}

function makeGithubStub() {
  const checkRuns = new Map<number, { status?: string; conclusion?: string }>();
  let nextId = 1000;
  const stub = {
    createCheckRunCalls: 0,
    acceptCalls: 0,
    rejectCalls: 0,
    checkRuns,
    createCheckRun: async (): Promise<number> => {
      stub.createCheckRunCalls += 1;
      const id = nextId;
      nextId += 1;
      checkRuns.set(id, { status: "in_progress" });
      return id;
    },
    updateCheckRun: async (
      cycle: { checkRunId?: number | null },
      input: { status?: string; conclusion?: string },
    ): Promise<void> => {
      if (!cycle.checkRunId) return;
      checkRuns.set(cycle.checkRunId, { status: input.status, conclusion: input.conclusion });
    },
    accept: async (): Promise<void> => {
      stub.acceptCalls += 1;
    },
    reject: async (): Promise<void> => {
      stub.rejectCalls += 1;
    },
  };
  return stub;
}

function makeSlackStub() {
  const finalizeCalls: Array<{ state: string; channel: string; ts: string }> = [];
  const stub = {
    uploadVideoCalls: 0,
    postValidationCalls: 0,
    isApproverCalls: 0,
    finalizeCalls,
    uploadVideo: async (): Promise<void> => {
      stub.uploadVideoCalls += 1;
    },
    postValidation: async (): Promise<{ channel: string; ts: string }> => {
      stub.postValidationCalls += 1;
      return { channel: "C0123", ts: `1710000000.${String(stub.postValidationCalls).padStart(6, "0")}` };
    },
    finalize: async (
      cycle: { slackChannelId: string | null; slackMessageTs: string | null },
      state: string,
    ): Promise<void> => {
      // Mirror the real client: it no-ops when the message coordinates are absent.
      if (!cycle.slackChannelId || !cycle.slackMessageTs) return;
      finalizeCalls.push({ state, channel: cycle.slackChannelId, ts: cycle.slackMessageTs });
    },
    openRequestChangesModal: async (): Promise<void> => {},
    isApprover: async (): Promise<boolean> => {
      stub.isApproverCalls += 1;
      return true;
    },
  };
  return stub;
}

function makeStart(prNumber: number, overrides: Partial<RunStartRequest> = {}): RunStartRequest {
  return {
    owner: "MathFreedom",
    repo: "Agora",
    prNumber,
    prTitle: "Add button",
    prAuthor: "romain",
    headSha: "abc1234567",
    baseSha: "def1234567",
    configHash: "0123456789abcdef",
    checkName: "Feature-Rec",
    config,
    ...overrides,
  };
}

async function startRun(app: AppInstance, start: RunStartRequest) {
  const res = await app.inject({
    method: "POST",
    url: "/api/runs/start",
    headers: { authorization: RUNNER_AUTH, "content-type": "application/json" },
    payload: JSON.stringify(start),
  });
  return { res, body: JSON.parse(res.body) as StartResponse };
}

async function postResult(
  app: AppInstance,
  cycleId: string,
  action: "accepted" | "failed",
  payload: unknown,
) {
  const res = await app.inject({
    method: "POST",
    url: `/api/runs/${cycleId}/${action}`,
    headers: { authorization: RUNNER_AUTH, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
  return { res, body: JSON.parse(res.body) as ResultResponse };
}

async function postVideo(app: AppInstance, cycleId: string, attemptId?: string) {
  const headers: Record<string, string> = {
    authorization: RUNNER_AUTH,
    "content-type": "application/octet-stream",
  };
  if (attemptId) headers["x-feature-rec-attempt"] = attemptId;
  const res = await app.inject({
    method: "POST",
    url: `/api/runs/${cycleId}/video`,
    headers,
    payload: Buffer.alloc(1024),
  });
  return { res, body: JSON.parse(res.body) as ResultResponse & { channel?: string; ts?: string } };
}

function signSlack(rawBody: string, timestamp: string): string {
  return `v0=${crypto
    .createHmac("sha256", env.slackSigningSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
}

async function postBlockAction(
  app: AppInstance,
  input: { cycleId: string; headSha: string; action: "accept" | "request_changes"; actionTs: string; triggerId: string },
) {
  const payload = {
    type: "block_actions",
    trigger_id: input.triggerId,
    user: { id: "U999" },
    actions: [
      {
        action_id: input.action === "accept" ? "feature_rec_accept" : "feature_rec_request_changes",
        action_ts: input.actionTs,
        value: JSON.stringify({ action: input.action, cycleId: input.cycleId, headSha: input.headSha }),
      },
    ],
  };
  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: "POST",
    url: "/api/slack/interactivity",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlack(rawBody, timestamp),
    },
    payload: rawBody,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(20);
  }
  return false;
}

const store = new PostgresCycleStore(testUrl);
await store.init();

try {
  // --- Store basics: startCycle create + duplicate, dedupe, lookups ---
  {
    const start = makeStart(13, { headSha: "basics0001" });
    const cycleKey = buildCycleKey(start);
    const first = await store.startCycle({ ...start, cycleKey });
    const second = await store.startCycle({ ...start, cycleKey });

    assert.equal(first.created, true);
    assert.ok(first.attemptId);
    assert.equal(first.cycle.config.slack.channel, "C0123");
    assert.equal(second.created, false);
    assert.equal(second.attemptId, null);
    assert.equal(first.cycle.id, second.cycle.id);

    assert.equal(await store.recordProcessedInteraction("i1", first.cycle.id), true);
    assert.equal(await store.recordProcessedInteraction("i1", first.cycle.id), false);

    assert.equal((await store.getCycleByKey(cycleKey))?.id, first.cycle.id);
    assert.equal(await store.getCycleByKey("does-not-exist"), null);
  }

  // --- GitHubClient template rendering via a stubbed fetch ---
  {
    const start = makeStart(1, { headSha: "github0001" });
    const created = await store.startCycle({ ...start, cycleKey: buildCycleKey(start) });
    await store.attachCheckRun(created.cycle.id, 123);
    const cycleForGithub = await store.getCycle(created.cycle.id);
    assert.ok(cycleForGithub);

    const previousFetch = globalThis.fetch;
    const githubCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);
      const reqBody = init?.body ? JSON.parse(String(init.body)) : {};
      githubCalls.push({ url: urlText, body: reqBody });
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
    assert.equal(
      (githubCalls[1].body.output as { summary: string }).summary.includes("issuecomment-9"),
      true,
    );
    assert.equal(
      (githubCalls[1].body.output as { summary: string }).summary.includes("make it feel premium"),
      false,
    );
    assert.equal(githubCalls[2].url.endsWith("/repos/MathFreedom/Agora/issues/1/comments"), true);
    assert.equal(githubCalls[2].body.body, "@romain validation passed; you can merge.");
    assert.equal(githubCalls[3].url.endsWith("/repos/MathFreedom/Agora/check-runs/123"), true);
    assert.equal(
      (githubCalls[3].body.output as { summary: string }).summary.includes("issuecomment-9"),
      true,
    );
  }

  // --- verifySlackSignature rejects bad input ---
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    assert.equal(
      verifySlackSignature({ signingSecret: "", timestamp, signature: "v0=short", rawBody: "" }),
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
  }

  // --- HTTP auth: start without a runner token is unauthorized ---
  {
    const app = makeApp(makeGithubStub(), makeSlackStub());
    const res = await app.inject({
      method: "POST",
      url: "/api/runs/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(makeStart(14, { headSha: "unauth0001" })),
    });
    assert.equal(res.statusCode, 401);
  }

  // --- HTTP: invalid Slack signature is rejected ---
  {
    const app = makeApp(makeGithubStub(), makeSlackStub());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await app.inject({
      method: "POST",
      url: "/api/slack/interactivity",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=short",
      },
      payload: "payload={}",
    });
    assert.equal(res.statusCode, 401);
  }

  // --- Store-level concurrency: two heads, one active cycle ---
  {
    const a = makeStart(2, { headSha: "store00001a" });
    const b = makeStart(2, { headSha: "store00002b" });
    const [ra, rb] = await Promise.all([
      store.startCycle({ ...a, cycleKey: buildCycleKey(a) }),
      store.startCycle({ ...b, cycleKey: buildCycleKey(b) }),
    ]);
    const finalA = await store.getCycle(ra.cycle.id);
    const finalB = await store.getCycle(rb.cycle.id);
    const analyzing = [finalA, finalB].filter((c) => c?.status === "analyzing");
    const superseded = [finalA, finalB].filter((c) => c?.status === "superseded");
    assert.equal(analyzing.length, 1);
    assert.equal(superseded.length, 1);
  }

  // --- (a) newer-head supersession over HTTP; loser's check run neutralized ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const a = makeStart(3, { headSha: "httpsup001a" });
    const b = makeStart(3, { headSha: "httpsup002b" });
    const [ra, rb] = await Promise.all([startRun(app, a), startRun(app, b)]);
    assert.ok(ra.body.cycleId);
    assert.ok(rb.body.cycleId);

    const finalA = await store.getCycle(ra.body.cycleId);
    const finalB = await store.getCycle(rb.body.cycleId);
    const loser = [finalA, finalB].find((c) => c?.status === "superseded");
    const winner = [finalA, finalB].find((c) => c?.status === "analyzing");
    assert.ok(loser);
    assert.ok(winner);
    assert.equal(github.createCheckRunCalls, 2);

    assert.ok(loser.checkRunId);
    assert.ok(
      await waitFor(async () => github.checkRuns.get(loser.checkRunId ?? 0)?.conclusion === "neutral"),
    );
    if (winner.checkRunId) {
      assert.notEqual(github.checkRuns.get(winner.checkRunId)?.conclusion, "neutral");
    }
  }

  // --- Superseded cleanup is best-effort: a failed old check update must not block the new run ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const first = (await startRun(app, makeStart(14, { headSha: "cleanup001a" }))).body;
    assert.ok(first.checkRunId);

    let cleanupAttempts = 0;
    const updateCheckRun = github.updateCheckRun;
    github.updateCheckRun = async (cycle, input): Promise<void> => {
      if (cycle.checkRunId === first.checkRunId) {
        cleanupAttempts += 1;
        throw new Error("cleanup failed");
      }
      await updateCheckRun(cycle, input);
    };

    const second = await startRun(app, makeStart(14, { headSha: "cleanup002b" }));
    assert.equal(second.res.statusCode, 200);
    assert.ok(second.body.checkRunId);
    assert.ok(second.body.attemptId);
    assert.equal(github.createCheckRunCalls, 2);
    assert.equal((await store.getCycle(second.body.cycleId ?? ""))?.checkRunId, second.body.checkRunId);
    assert.ok(await waitFor(async () => cleanupAttempts > 0));
    assert.equal((await store.getCycle(first.cycleId ?? ""))?.status, "superseded");
  }

  // --- (b) same-head duplicate start: one created, one duplicate, one check run ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const start = makeStart(4, { headSha: "httpdup001" });
    const [r1, r2] = await Promise.all([startRun(app, start), startRun(app, start)]);
    const bodies = [r1.body, r2.body];
    const duplicates = bodies.filter((b) => b.duplicate === true);
    const creators = bodies.filter((b) => b.duplicate !== true);
    assert.equal(duplicates.length, 1);
    assert.equal(creators.length, 1);
    assert.ok(creators[0].checkRunId);
    assert.ok(creators[0].attemptId);
    assert.equal(github.createCheckRunCalls, 1);
  }

  // --- (c) stale runner no-op: superseded head A can't post results ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub();
    const app = makeApp(github, slack);
    const a = makeStart(5, { headSha: "stale0001a" });
    const b = makeStart(5, { headSha: "stale0002b" });
    const startA = (await startRun(app, a)).body;
    await startRun(app, b);
    assert.ok(startA.cycleId);
    assert.ok(startA.attemptId);
    assert.equal((await store.getCycle(startA.cycleId))?.status, "superseded");

    const accepted = await postResult(app, startA.cycleId, "accepted", { attemptId: startA.attemptId });
    const failed = await postResult(app, startA.cycleId, "failed", { attemptId: startA.attemptId });
    const video = await postVideo(app, startA.cycleId, startA.attemptId);
    assert.equal(accepted.res.statusCode, 200);
    assert.equal(accepted.body.stale, true);
    assert.equal(failed.body.stale, true);
    assert.equal(video.body.stale, true);

    const finalA = await store.getCycle(startA.cycleId);
    assert.equal(finalA?.status, "superseded");
    assert.equal(finalA?.slackMessageTs, null);
    assert.equal(slack.postValidationCalls, 0);
  }

  // --- (d) attempt ownership: wrong token is stale, missing/malformed is 400 ---
  {
    const app = makeApp(makeGithubStub(), makeSlackStub());
    const start = (await startRun(app, makeStart(6, { headSha: "attempt001" }))).body;
    assert.ok(start.cycleId);

    const wrong = await postResult(app, start.cycleId, "accepted", { attemptId: crypto.randomUUID() });
    assert.equal(wrong.res.statusCode, 200);
    assert.equal(wrong.body.stale, true);
    assert.equal((await store.getCycle(start.cycleId))?.status, "analyzing");

    const missing = await postResult(app, start.cycleId, "accepted", {});
    assert.equal(missing.res.statusCode, 400);
    const malformed = await postResult(app, start.cycleId, "accepted", { attemptId: 123 });
    assert.equal(malformed.res.statusCode, 400);
    assert.equal((await store.getCycle(start.cycleId))?.status, "analyzing");
  }

  // --- (e) runner /accepted on a pending_validation cycle is stale ---
  {
    const app = makeApp(makeGithubStub(), makeSlackStub());
    const start = (await startRun(app, makeStart(7, { headSha: "pending001" }))).body;
    assert.ok(start.cycleId);
    assert.ok(start.attemptId);

    const video = await postVideo(app, start.cycleId, start.attemptId);
    assert.equal(video.res.statusCode, 200);
    assert.equal((await store.getCycle(start.cycleId))?.status, "pending_validation");

    const accepted = await postResult(app, start.cycleId, "accepted", { attemptId: start.attemptId });
    assert.equal(accepted.res.statusCode, 200);
    assert.equal(accepted.body.stale, true);
    assert.equal((await store.getCycle(start.cycleId))?.status, "pending_validation");
  }

  // --- (f) stale duplicate start can't displace the active head ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const a = makeStart(8, { headSha: "displace01a" });
    const b = makeStart(8, { headSha: "displace02b" });
    const startA = (await startRun(app, a)).body;
    const startB = (await startRun(app, b)).body;
    assert.ok(startA.cycleId);
    assert.ok(startB.cycleId);
    assert.equal((await store.getCycle(startB.cycleId))?.status, "analyzing");

    const lateDuplicate = (await startRun(app, a)).body;
    assert.equal(lateDuplicate.duplicate, true);
    assert.equal((await store.getCycle(startB.cycleId))?.status, "analyzing");
    assert.equal((await store.getCycle(startA.cycleId))?.status, "superseded");
  }

  // --- (g) double Slack click: only one GitHub accept, loser stops at transition ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const start = (await startRun(app, makeStart(9, { headSha: "dblclick01" }))).body;
    assert.ok(start.cycleId);
    assert.ok(start.attemptId);
    await store.transitionRunnerStatus({
      cycleId: start.cycleId,
      attemptId: start.attemptId,
      from: ["analyzing"],
      to: "pending_validation",
    });

    await Promise.all([
      postBlockAction(app, {
        cycleId: start.cycleId,
        headSha: "dblclick01",
        action: "accept",
        actionTs: "1710000000.000001",
        triggerId: "T1",
      }),
      postBlockAction(app, {
        cycleId: start.cycleId,
        headSha: "dblclick01",
        action: "accept",
        actionTs: "1710000000.000002",
        triggerId: "T2",
      }),
    ]);

    const settled = await waitFor(
      async () => (await store.getCycle(start.cycleId!))?.status === "accepted",
    );
    assert.equal(settled, true);
    await sleep(200);
    assert.equal(github.acceptCalls, 1);
  }

  // --- Slack approver restriction: non-approver click is ignored ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub();
    slack.isApprover = async () => {
      slack.isApproverCalls += 1;
      return false;
    };
    const app = makeApp(github, slack);
    const start = makeStart(10, { headSha: "approver01", config: restrictedConfig });
    const created = await store.startCycle({ ...start, cycleKey: buildCycleKey(start) });
    assert.ok(created.attemptId);
    await store.transitionRunnerStatus({
      cycleId: created.cycle.id,
      attemptId: created.attemptId,
      from: ["analyzing"],
      to: "pending_validation",
    });

    await postBlockAction(app, {
      cycleId: created.cycle.id,
      headSha: "approver01",
      action: "accept",
      actionTs: "1710000000.000003",
      triggerId: "T3",
    });
    const checked = await waitFor(async () => slack.isApproverCalls === 1);
    assert.equal(checked, true);
    await sleep(200);
    assert.equal(github.acceptCalls, 0);
    assert.equal((await store.getCycle(created.cycle.id))?.status, "pending_validation");
  }

  // --- (h) supersession between /video transition and the Slack post ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub();
    const app = makeApp(github, slack);
    const startA = (await startRun(app, makeStart(11, { headSha: "video0001a" }))).body;
    assert.ok(startA.cycleId);
    assert.ok(startA.attemptId);

    // Inject the race deterministically: posting the validation message starts a
    // newer head, which supersedes A before its own attachSlackMessage runs.
    slack.postValidation = async () => {
      slack.postValidationCalls += 1;
      await startRun(app, makeStart(11, { headSha: "video0002b" }));
      return { channel: "C0123", ts: "1710000000.000777" };
    };

    const video = await postVideo(app, startA.cycleId, startA.attemptId);
    assert.equal(video.res.statusCode, 200);

    assert.equal(slack.finalizeCalls.length, 1);
    assert.equal(slack.finalizeCalls[0].state, "superseded");
    assert.equal(slack.finalizeCalls[0].ts, "1710000000.000777");
    const finalA = await store.getCycle(startA.cycleId);
    assert.equal(finalA?.status, "superseded");
    assert.equal(finalA?.slackMessageTs, null);
  }

  // --- (i) takeover from failed: fresh attempt, reused check run, old token stale ---
  {
    const github = makeGithubStub();
    const app = makeApp(github, makeSlackStub());
    const start = makeStart(12, { headSha: "takeover01" });
    const first = (await startRun(app, start)).body;
    assert.ok(first.cycleId);
    assert.ok(first.attemptId);
    assert.ok(first.checkRunId);
    assert.equal(github.createCheckRunCalls, 1);

    const failed = await postResult(app, first.cycleId, "failed", { attemptId: first.attemptId });
    assert.equal(failed.body.ok, true);
    assert.equal((await store.getCycle(first.cycleId))?.status, "failed");

    const rerun = (await startRun(app, start)).body;
    assert.equal(rerun.duplicate, undefined);
    assert.ok(rerun.attemptId);
    assert.notEqual(rerun.attemptId, first.attemptId);
    assert.equal(rerun.checkRunId, first.checkRunId);
    assert.equal(github.createCheckRunCalls, 1);
    assert.equal((await store.getCycle(first.cycleId))?.status, "analyzing");

    const staleResult = await postResult(app, first.cycleId, "accepted", {
      attemptId: first.attemptId,
    });
    assert.equal(staleResult.res.statusCode, 200);
    assert.equal(staleResult.body.stale, true);
    assert.equal((await store.getCycle(first.cycleId))?.status, "analyzing");
  }

  // --- Writes after close() reject (pg pool, not a synchronous throw) ---
  {
    // init() first so the (lazily-created) pool is actually opened; otherwise
    // close() is a no-op and the write below would succeed against a live pool.
    const closeStore = new PostgresCycleStore(testUrl);
    await closeStore.init();
    await closeStore.close();
    await assert.rejects(closeStore.recordProcessedInteraction("after-close", "none"));
  }

  console.log("service selftest passed");
} finally {
  // Close the app + store/pool before dropping so no live client receives the
  // termination; FORCE is a belt-and-braces against any lingering connection so
  // a failed run can't strand the test database.
  await Promise.allSettled(apps.map((app) => app.close()));
  await store.close().catch(() => {});
  const dropper = new Client({ connectionString: adminUrl });
  await dropper.connect();
  await dropper.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await dropper.end();
}
