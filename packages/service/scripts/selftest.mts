import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Client } from "pg";
import {
  buildCycleKey,
  renderTemplate,
  SLACK_GREETING_ACTIVE,
  SLACK_GREETING_NEXT_IN_LINE,
  SLACK_GREETING_QUEUED,
  SLACK_NO_CHANNEL_MESSAGE,
  SLACK_PROMOTION_NOTICE,
  type RunStartRequest,
} from "@feature-rec/core";
import { ChannelResolutionError, resolveChannel } from "../src/channels";
import { GitHubClient } from "../src/github";
import type { ServiceEnv } from "../src/env";
import { buildServer } from "../src/http";
import { SlackClient, verifySlackSignature } from "../src/slack";
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
  onboarded?: boolean;
};

type ResultResponse = { ok?: boolean; stale?: boolean; error?: string; settled?: boolean };

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

function makeSlackStub(options: { teamId?: string; channels?: string[] } = {}) {
  const teamId = options.teamId ?? "T0123";
  const finalizeCalls: Array<{ state: string; channel: string; ts: string }> = [];
  const stub = {
    channels: options.channels ?? ["C0123"],
    usergroups: [] as Array<{ id: string; handle: string }>,
    usergroupMembers: {} as Record<string, string[]>,
    postMessageCalls: [] as Array<{ channel: string; text: string }>,
    ephemeralCalls: [] as Array<{ url: string; text: string }>,
    uploadVideoChannels: [] as string[],
    postValidationArgs: [] as Array<{ channel: string; mention: string | null }>,
    uploadVideoCalls: 0,
    postValidationCalls: 0,
    isApproverCalls: 0,
    finalizeCalls,
    botIdentity: async () => ({ userId: "UBOT", teamId, enterpriseId: null }),
    listBotChannels: async (): Promise<string[]> => [...stub.channels],
    listUsergroups: async (): Promise<Array<{ id: string; handle: string }>> => stub.usergroups,
    postMessage: async (channel: string, text: string): Promise<void> => {
      stub.postMessageCalls.push({ channel, text });
    },
    respondEphemeral: async (url: string, text: string): Promise<void> => {
      stub.ephemeralCalls.push({ url, text });
    },
    uploadVideo: async (_cycle: unknown, channel: string): Promise<void> => {
      stub.uploadVideoCalls += 1;
      stub.uploadVideoChannels.push(channel);
    },
    postValidation: async (
      _cycle: unknown,
      channel: string,
      mention: string | null,
    ): Promise<{ channel: string; ts: string }> => {
      stub.postValidationCalls += 1;
      stub.postValidationArgs.push({ channel, mention });
      return { channel, ts: `1710000000.${String(stub.postValidationCalls).padStart(6, "0")}` };
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
    // Same semantics as SlackClient.isApprover, with usergroup expansion
    // served from usergroupMembers instead of the Slack API.
    isApprover: async (
      approvers: string[] | null,
      userId: string | undefined,
    ): Promise<boolean> => {
      stub.isApproverCalls += 1;
      if (!approvers || approvers.length === 0) return true;
      if (!userId) return false;
      if (approvers.includes(userId)) return true;
      return approvers.some((id) => (stub.usergroupMembers[id] ?? []).includes(userId));
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

// Interaction dedupe is global (processed_interactions): every test must use
// a unique triggerId/actionTs (and viewId) or it silently dedupes as stale.
async function postBlockAction(
  app: AppInstance,
  input: {
    cycleId: string;
    headSha: string;
    action: "accept" | "request_changes";
    actionTs: string;
    triggerId: string;
    userId?: string;
    teamId?: string;
    responseUrl?: string;
  },
) {
  const payload = {
    type: "block_actions",
    trigger_id: input.triggerId,
    ...(input.teamId ? { team: { id: input.teamId } } : {}),
    ...(input.responseUrl ? { response_url: input.responseUrl } : {}),
    user: { id: input.userId ?? "U999" },
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

async function postViewSubmission(
  app: AppInstance,
  input: {
    cycleId: string;
    headSha: string;
    viewId: string;
    comment: string;
    userId?: string;
    teamId?: string;
    responseUrl?: string;
  },
) {
  const payload = {
    type: "view_submission",
    ...(input.teamId ? { team: { id: input.teamId } } : {}),
    user: { id: input.userId ?? "U999" },
    view: {
      id: input.viewId,
      hash: `${input.viewId}-hash`,
      private_metadata: JSON.stringify({
        cycleId: input.cycleId,
        headSha: input.headSha,
        responseUrl: input.responseUrl,
      }),
      state: { values: { comment: { value: { value: input.comment } } } },
    },
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

async function postSlackEvent(app: AppInstance, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: "POST",
    url: "/api/slack/events",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlack(rawBody, timestamp),
    },
    payload: rawBody,
  });
}

function membershipEvent(input: {
  type: "member_joined_channel" | "member_left_channel";
  teamId: string;
  user: string;
  channel: string;
  ts: string;
}) {
  return {
    type: "event_callback",
    team_id: input.teamId,
    event: { type: input.type, user: input.user, channel: input.channel, event_ts: input.ts },
  };
}

async function postCommand(
  app: AppInstance,
  input: { teamId: string; channelId: string; userId: string; text: string },
) {
  const rawBody = new URLSearchParams({
    command: "/feature-rec",
    team_id: input.teamId,
    channel_id: input.channelId,
    user_id: input.userId,
    text: input.text,
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await app.inject({
    method: "POST",
    url: "/api/slack/commands",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlack(rawBody, timestamp),
    },
    payload: rawBody,
  });
  return { res, body: JSON.parse(res.body) as { response_type?: string; text?: string } };
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
      await client.reject(cycleForGithub, "make it feel premium");
      await client.accept(cycleForGithub);
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(githubCalls[0].url.endsWith("/repos/MathFreedom/Agora/issues/1/comments"), true);
    assert.equal(
      githubCalls[0].body.body,
      "@romain make the following changes:\n\nmake it feel premium",
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

  // --- Check Run creation failure releases the cycle for a same-head rerun ---
  {
    const github = makeGithubStub();
    const createCheckRun = github.createCheckRun;
    github.createCheckRun = async (): Promise<number> => {
      if (github.createCheckRunCalls === 0) {
        github.createCheckRunCalls += 1;
        throw new Error("GitHub App credentials are missing");
      }
      return createCheckRun();
    };
    const app = makeApp(github, makeSlackStub());
    const start = makeStart(15, { headSha: "retryinit01" });

    const failed = await startRun(app, start);
    assert.equal(failed.res.statusCode, 500);
    assert.equal((await store.getCycleByKey(buildCycleKey(start)))?.status, "failed");

    const rerun = await startRun(app, start);
    assert.equal(rerun.res.statusCode, 200);
    assert.equal(rerun.body.duplicate, undefined);
    assert.ok(rerun.body.attemptId);
    assert.ok(rerun.body.checkRunId);
    assert.equal(github.createCheckRunCalls, 2);
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
    const start = makeStart(10, { headSha: "approver01" });
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

  // --- Channel routing: resolver 0/1/many, ordering, failover, rejoin-to-back ---
  {
    const slack = makeSlackStub({ teamId: "TROUTE", channels: [] });
    const slackClient = slack as never as SlackClient;

    await assert.rejects(
      resolveChannel(store, slackClient),
      (err: unknown) =>
        err instanceof ChannelResolutionError && err.message === SLACK_NO_CHANNEL_MESSAGE,
    );

    // Join events carry exact times; CA is the older introduction.
    await store.recordChannelJoin({
      teamId: "TROUTE",
      enterpriseId: null,
      channelId: "CA",
      joinedAt: "2026-01-01T00:00:01.000Z",
    });
    await store.recordChannelJoin({
      teamId: "TROUTE",
      enterpriseId: null,
      channelId: "CB",
      joinedAt: "2026-01-01T00:00:02.000Z",
    });
    slack.channels = ["CA", "CB"];
    assert.equal((await resolveChannel(store, slackClient)).channelId, "CA");

    // Failover: removing the bot from CA promotes CB on the next post.
    await store.recordChannelLeave({
      teamId: "TROUTE",
      channelId: "CA",
      leftAt: "2026-01-01T00:00:03.000Z",
    });
    slack.channels = ["CB"];
    assert.equal((await resolveChannel(store, slackClient)).channelId, "CB");

    // Rejoin goes to the back of the queue: CB keeps the active slot.
    await store.recordChannelJoin({
      teamId: "TROUTE",
      enterpriseId: null,
      channelId: "CA",
      joinedAt: "2026-01-01T00:00:04.000Z",
    });
    slack.channels = ["CA", "CB"];
    assert.equal((await resolveChannel(store, slackClient)).channelId, "CB");

    // Poll-seeded channel (no join event) orders by first_seen_at, after both.
    slack.channels = ["CA", "CB", "CC"];
    await resolveChannel(store, slackClient);
    assert.deepEqual(
      (await store.activeBotChannels("TROUTE")).map((channel) => channel.channelId),
      ["CB", "CA", "CC"],
    );

    // Stale-poll guard: a join that lands after the snapshot must survive a
    // sync whose channel list predates it.
    await store.recordChannelJoin({
      teamId: "TROUTE",
      enterpriseId: null,
      channelId: "CD",
      joinedAt: new Date().toISOString(),
    });
    await store.syncBotChannels({
      teamId: "TROUTE",
      enterpriseId: null,
      channelIds: ["CB"],
      seenAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.ok(
      (await store.activeBotChannels("TROUTE")).some((channel) => channel.channelId === "CD"),
    );

    // A fresh poll is authoritative: channels missing from it are reaped.
    slack.channels = ["CA", "CC"];
    assert.equal((await resolveChannel(store, slackClient)).channelId, "CA");
    assert.deepEqual(
      (await store.activeBotChannels("TROUTE")).map((channel) => channel.channelId),
      ["CA", "CC"],
    );
  }

  // --- Shared tenant channel: repos share the active channel; mention default ---
  {
    const slack = makeSlackStub();
    const app = makeApp(makeGithubStub(), slack);
    const first = (await startRun(app, makeStart(20, { headSha: "shared0001" }))).body;
    const second = (
      await startRun(app, makeStart(21, { repo: "OtherRepo", headSha: "shared0002" }))
    ).body;
    assert.ok(first.cycleId && first.attemptId);
    assert.ok(second.cycleId && second.attemptId);
    // Advisory flag: a tenant with an active channel reports onboarded.
    assert.equal(first.onboarded, true);
    assert.equal(second.onboarded, true);
    await postVideo(app, first.cycleId!, first.attemptId);
    await postVideo(app, second.cycleId!, second.attemptId);
    assert.deepEqual(slack.postValidationArgs, [
      { channel: "C0123", mention: null },
      { channel: "C0123", mention: null },
    ]);
    assert.deepEqual(slack.uploadVideoChannels, ["C0123", "C0123"]);
  }

  // --- Validation mention comes from the channel settings at post time ---
  {
    const slack = makeSlackStub({ teamId: "TMENTION", channels: ["CM1"] });
    const app = makeApp(makeGithubStub(), slack);
    await store.setMention({
      teamId: "TMENTION",
      channelId: "CM1",
      mention: "<!subteam^S321|@design>",
      updatedBy: "U1",
    });
    const start = (await startRun(app, makeStart(22, { headSha: "mention0001" }))).body;
    await postVideo(app, start.cycleId!, start.attemptId);
    assert.deepEqual(slack.postValidationArgs, [
      { channel: "CM1", mention: "<!subteam^S321|@design>" },
    ]);
  }

  // --- Events: challenge echo, bad signature, greetings by rank ---
  {
    const slack = makeSlackStub({ teamId: "TEVT", channels: [] });
    const app = makeApp(makeGithubStub(), slack);

    const challenge = await postSlackEvent(app, { type: "url_verification", challenge: "chal123" });
    assert.equal(challenge.statusCode, 200);
    assert.equal((JSON.parse(challenge.body) as { challenge?: string }).challenge, "chal123");

    const badSig = await app.inject({
      method: "POST",
      url: "/api/slack/events",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=bad",
      },
      payload: JSON.stringify({ type: "url_verification", challenge: "nope" }),
    });
    assert.equal(badSig.statusCode, 401);

    const join = (channel: string, ts: string, user = "UBOT") =>
      postSlackEvent(
        app,
        membershipEvent({ type: "member_joined_channel", teamId: "TEVT", user, channel, ts }),
      );
    const leave = (channel: string, ts: string) =>
      postSlackEvent(
        app,
        membershipEvent({
          type: "member_left_channel",
          teamId: "TEVT",
          user: "UBOT",
          channel,
          ts,
        }),
      );

    await join("CE1", "1710000001.000000");
    assert.ok(await waitFor(async () => slack.postMessageCalls.length === 1));
    assert.deepEqual(slack.postMessageCalls[0], { channel: "CE1", text: SLACK_GREETING_ACTIVE });

    await join("CE2", "1710000002.000000");
    assert.ok(await waitFor(async () => slack.postMessageCalls.length === 2));
    assert.deepEqual(slack.postMessageCalls[1], {
      channel: "CE2",
      text: renderTemplate(SLACK_GREETING_NEXT_IN_LINE, { active_channel: "<#CE1>" }),
    });

    await join("CE3", "1710000003.000000");
    assert.ok(await waitFor(async () => slack.postMessageCalls.length === 3));
    assert.deepEqual(slack.postMessageCalls[2], {
      channel: "CE3",
      text: renderTemplate(SLACK_GREETING_QUEUED, { active_channel: "<#CE1>" }),
    });

    // Non-bot joins are dropped: no row, no greeting.
    await join("CE4", "1710000004.000000", "UHUMAN");
    await sleep(150);
    assert.equal(slack.postMessageCalls.length, 3);
    assert.equal(
      (await store.activeBotChannels("TEVT")).some((channel) => channel.channelId === "CE4"),
      false,
    );

    // Leaving a non-active channel promotes nothing.
    await leave("CE3", "1710000005.000000");
    await sleep(150);
    assert.equal(slack.postMessageCalls.length, 3);

    // Leaving the active channel notifies the promoted one.
    await leave("CE1", "1710000006.000000");
    assert.ok(await waitFor(async () => slack.postMessageCalls.length === 4));
    assert.deepEqual(slack.postMessageCalls[3], { channel: "CE2", text: SLACK_PROMOTION_NOTICE });

    // A join without event_ts still records the channel (falls back to now).
    await postSlackEvent(app, {
      type: "event_callback",
      team_id: "TEVT",
      event: { type: "member_joined_channel", user: "UBOT", channel: "CE5" },
    });
    assert.ok(
      (await store.activeBotChannels("TEVT")).some((channel) => channel.channelId === "CE5"),
    );

    // Retried deliveries (same event_id) keep the idempotent membership write
    // but must not greet twice.
    const greetingsBefore = slack.postMessageCalls.length;
    const retried = {
      ...membershipEvent({
        type: "member_joined_channel" as const,
        teamId: "TEVT",
        user: "UBOT",
        channel: "CE6",
        ts: "1710000007.000000",
      }),
      event_id: "Ev0RETRY01",
    };
    await postSlackEvent(app, retried);
    await postSlackEvent(app, retried);
    await sleep(150);
    assert.equal(slack.postMessageCalls.length, greetingsBefore + 1);
    assert.ok(
      (await store.activeBotChannels("TEVT")).some((channel) => channel.channelId === "CE6"),
    );
  }

  // --- Commands: mention set/off/echo/bad-handle, approvers, status, usage ---
  {
    const slack = makeSlackStub({ teamId: "TCMD", channels: ["CCMD"] });
    slack.usergroups = [{ id: "S777", handle: "product-team" }];
    const app = makeApp(makeGithubStub(), slack);
    const run = (text: string) =>
      postCommand(app, { teamId: "TCMD", channelId: "CCMD", userId: "UCMD", text });

    assert.equal((await run("mention")).body.text, "Mention: @here (default)");

    const set = await run("mention @product-team <@U111|bob>");
    assert.equal(
      set.body.text,
      "Validation requests in this channel will mention <!subteam^S777|@product-team> <@U111>.",
    );
    assert.equal(
      (await store.getChannelSettings("TCMD", "CCMD"))?.mention,
      "<!subteam^S777|@product-team> <@U111>",
    );
    assert.equal(
      (await run("mention")).body.text,
      "Mention: <!subteam^S777|@product-team> <@U111>",
    );

    const badHandle = await run("mention @nope");
    assert.ok(badHandle.body.text?.startsWith("Unknown mention target @nope."));
    assert.equal(
      (await store.getChannelSettings("TCMD", "CCMD"))?.mention,
      "<!subteam^S777|@product-team> <@U111>",
    );

    assert.equal(
      (await run("mention @here")).body.text,
      "Validation requests in this channel will mention <!here>.",
    );
    assert.equal((await store.getChannelSettings("TCMD", "CCMD"))?.mention, "<!here>");
    assert.equal(
      (await run("mention @here off")).body.text,
      'Use "off" by itself: `/feature-rec mention off`.',
    );
    assert.equal((await store.getChannelSettings("TCMD", "CCMD"))?.mention, "<!here>");

    assert.equal(
      (await run("mention off")).body.text,
      "Mention turned off for validation requests in this channel.",
    );
    assert.equal((await store.getChannelSettings("TCMD", "CCMD"))?.mention, "");
    assert.equal((await run("mention")).body.text, "Mention: off");

    assert.equal((await run("approvers")).body.text, "Approvers: everyone in the channel.");
    assert.equal(
      (await run("approvers @product-team <@U111|bob>")).body.text,
      "Only <!subteam^S777>, <@U111> can approve.",
    );
    assert.deepEqual((await store.getChannelSettings("TCMD", "CCMD"))?.approvers, [
      "S777",
      "U111",
    ]);
    assert.ok((await run("approvers @nobody")).body.text?.startsWith("Unknown approver @nobody."));
    assert.equal(
      (await run("approvers everyone <@U111|bob>")).body.text,
      'Use "everyone" by itself: `/feature-rec approvers everyone`.',
    );
    assert.deepEqual((await store.getChannelSettings("TCMD", "CCMD"))?.approvers, [
      "S777",
      "U111",
    ]);
    assert.equal(
      (await run("approvers everyone")).body.text,
      "Everyone in the channel can now approve.",
    );
    assert.equal((await store.getChannelSettings("TCMD", "CCMD"))?.approvers, null);

    slack.channels = ["CCMD", "CCMD2"];
    const status = (await run("status")).body.text ?? "";
    assert.ok(status.includes("Validations go to <#CCMD>."));
    assert.ok(status.includes("Mention: off"));
    assert.ok(status.includes("Approvers: everyone in the channel."));
    assert.ok(status.includes("If I'm removed from <#CCMD>, validations will move to <#CCMD2>."));

    assert.ok((await run("wat")).body.text?.startsWith("Usage:"));
    assert.ok((await run("")).body.text?.startsWith("Usage:"));

    const badCommandSig = await app.inject({
      method: "POST",
      url: "/api/slack/commands",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=bad",
      },
      payload: "team_id=TCMD&channel_id=CCMD&user_id=UCMD&text=status",
    });
    assert.equal(badCommandSig.statusCode, 401);

    const missingTeam = "channel_id=CCMD&user_id=UCMD&text=status";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const noTeam = await app.inject({
      method: "POST",
      url: "/api/slack/commands",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signSlack(missingTeam, timestamp),
      },
      payload: missingTeam,
    });
    assert.equal(noTeam.statusCode, 400);
  }

  // --- Restricted approval: non-approver gets an ephemeral reply, member accepts ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub();
    slack.usergroupMembers = { S900: ["UMEMBER"] };
    const app = makeApp(github, slack);
    const start = (await startRun(app, makeStart(23, { headSha: "restrict01" }))).body;
    await postVideo(app, start.cycleId!, start.attemptId);
    await store.setApprovers({
      teamId: "TAPPR",
      channelId: "C0123",
      approvers: ["S900"],
      updatedBy: "UADMIN",
    });

    await postBlockAction(app, {
      cycleId: start.cycleId!,
      headSha: "restrict01",
      action: "accept",
      actionTs: "1710000000.000101",
      triggerId: "TR1",
      userId: "USTRANGER",
      teamId: "TAPPR",
      responseUrl: "https://hooks.slack.test/r1",
    });
    assert.ok(await waitFor(async () => slack.ephemeralCalls.length === 1));
    assert.deepEqual(slack.ephemeralCalls[0], {
      url: "https://hooks.slack.test/r1",
      text: "Only <!subteam^S900> can approve.",
    });
    await sleep(150);
    assert.equal(github.acceptCalls, 0);
    assert.equal((await store.getCycle(start.cycleId!))?.status, "pending_validation");

    await postBlockAction(app, {
      cycleId: start.cycleId!,
      headSha: "restrict01",
      action: "accept",
      actionTs: "1710000000.000102",
      triggerId: "TR2",
      userId: "UMEMBER",
      teamId: "TAPPR",
      responseUrl: "https://hooks.slack.test/r2",
    });
    assert.ok(
      await waitFor(async () => (await store.getCycle(start.cycleId!))?.status === "accepted"),
    );
    await sleep(150);
    assert.equal(github.acceptCalls, 1);
    assert.equal(slack.ephemeralCalls.length, 1);
  }

  // --- Request-changes submissions: empty comment, unauthorized, rejection ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub();
    slack.usergroupMembers = { S900: ["UMEMBER"] };
    const app = makeApp(github, slack);
    const start = (await startRun(app, makeStart(26, { headSha: "reject0001" }))).body;
    await postVideo(app, start.cycleId!, start.attemptId);
    // TAPPR/C0123 approvers were set to ["S900"] in the restricted-approval block.

    const emptyComment = await postViewSubmission(app, {
      cycleId: start.cycleId!,
      headSha: "reject0001",
      viewId: "V1",
      comment: "  ",
      userId: "UMEMBER",
      teamId: "TAPPR",
    });
    assert.equal(
      (JSON.parse(emptyComment.body) as { response_action?: string }).response_action,
      "errors",
    );

    // Unauthorized submission replies through the response_url stashed in the
    // modal's private_metadata (view payloads carry none of their own).
    await postViewSubmission(app, {
      cycleId: start.cycleId!,
      headSha: "reject0001",
      viewId: "V2",
      comment: "not premium enough",
      userId: "USTRANGER",
      teamId: "TAPPR",
      responseUrl: "https://hooks.slack.test/r3",
    });
    assert.ok(await waitFor(async () => slack.ephemeralCalls.length === 1));
    assert.deepEqual(slack.ephemeralCalls[0], {
      url: "https://hooks.slack.test/r3",
      text: "Only <!subteam^S900> can approve.",
    });
    await sleep(150);
    assert.equal(github.rejectCalls, 0);
    assert.equal((await store.getCycle(start.cycleId!))?.status, "pending_validation");

    await postViewSubmission(app, {
      cycleId: start.cycleId!,
      headSha: "reject0001",
      viewId: "V3",
      comment: "not premium enough",
      userId: "UMEMBER",
      teamId: "TAPPR",
      responseUrl: "https://hooks.slack.test/r4",
    });
    assert.ok(
      await waitFor(async () => (await store.getCycle(start.cycleId!))?.status === "rejected"),
    );
    await sleep(150);
    assert.equal(github.rejectCalls, 1);
    assert.equal(slack.finalizeCalls.at(-1)?.state, "rejected");
  }

  // --- Real SlackClient.listBotChannels: pagination and ext-shared exclusion ---
  {
    const previousFetch = globalThis.fetch;
    const pages = [
      {
        ok: true,
        channels: [{ id: "CP1" }, { id: "CP2", is_ext_shared: true }],
        response_metadata: { next_cursor: "cur2" },
      },
      {
        ok: true,
        channels: [{ id: "CP3", is_pending_ext_shared: true }, { id: "CP4" }],
        response_metadata: { next_cursor: "" },
      },
    ];
    const cursors: Array<string | undefined> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { cursor?: string };
      cursors.push(body.cursor);
      return new Response(JSON.stringify(pages[cursors.length - 1]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new SlackClient({ ...env, slackBotToken: "xoxb-test" });
      assert.deepEqual(await client.listBotChannels(), ["CP1", "CP4"]);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.deepEqual(cursors, [undefined, "cur2"]);
  }

  // --- Real SlackClient.isApprover: direct ids skip the API, groups expand ---
  {
    const previousFetch = globalThis.fetch;
    const usergroupCalls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      usergroupCalls.push(String(url));
      const body = init?.body ? (JSON.parse(String(init.body)) as { usergroup?: string }) : {};
      assert.equal(body.usergroup, "S123");
      return new Response(JSON.stringify({ ok: true, users: ["U1", "U2"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new SlackClient({ ...env, slackBotToken: "xoxb-test" });
      assert.equal(await client.isApprover(null, "Uany"), true);
      assert.equal(await client.isApprover(["U9"], undefined), false);
      assert.equal(await client.isApprover(["U9"], "U9"), true);
      assert.equal(await client.isApprover(["S123"], "U1"), true);
      assert.equal(await client.isApprover(["S123"], "U7"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.equal(usergroupCalls.length, 2);
  }

  // --- Video with no review channel: 422, actionable check run, /failed no-ops ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub({ teamId: "TEMPTY", channels: [] });
    const app = makeApp(github, slack);
    const start = (await startRun(app, makeStart(24, { headSha: "nochannel1" }))).body;
    // Advisory flag: an unboarded tenant is announced at start so the runner
    // can fail frontend-visible PRs before rendering.
    assert.equal(start.onboarded, false);

    const video = await postVideo(app, start.cycleId!, start.attemptId);
    assert.equal(video.res.statusCode, 422);
    assert.equal(video.body.error, "no_slack_channel");
    // Machine-readable settlement: the backend already failed the cycle and
    // wrote the check run, so the runner must skip its own failure report.
    assert.equal(video.body.settled, true);
    assert.equal((await store.getCycle(start.cycleId!))?.status, "failed");
    assert.equal(github.checkRuns.get(start.checkRunId!)?.conclusion, "failure");
    assert.equal(slack.uploadVideoCalls, 0);

    const failed = await postResult(app, start.cycleId!, "failed", { attemptId: start.attemptId });
    assert.equal(failed.body.stale, true);
    assert.equal(github.checkRuns.get(start.checkRunId!)?.conclusion, "failure");
  }

  // --- Superseded while resolving the channel: no failure written over neutral ---
  {
    const github = makeGithubStub();
    const slack = makeSlackStub({ teamId: "TRACE", channels: [] });
    const app = makeApp(github, slack);
    const startA = (await startRun(app, makeStart(25, { headSha: "race0001aa" }))).body;

    // The membership poll starts a newer head before reporting no channels,
    // so A is superseded mid-resolution.
    slack.listBotChannels = async () => {
      await startRun(app, makeStart(25, { headSha: "race0002bb" }));
      return [];
    };
    const video = await postVideo(app, startA.cycleId!, startA.attemptId);
    assert.equal(video.res.statusCode, 200);
    assert.equal(video.body.stale, true);
    assert.equal((await store.getCycle(startA.cycleId!))?.status, "superseded");
    assert.ok(
      await waitFor(
        async () => github.checkRuns.get(startA.checkRunId!)?.conclusion === "neutral",
      ),
    );
  }

  // --- Stale membership data cannot resurrect a newer leave ---
  {
    // A poll snapshot taken BEFORE the leave still lists the channel; the
    // sweep must not clear the newer left_at.
    await store.recordChannelJoin({
      teamId: "TSTALE",
      enterpriseId: null,
      channelId: "CSTALE",
      joinedAt: "2026-07-22T10:00:00.000Z",
    });
    await store.recordChannelLeave({
      teamId: "TSTALE",
      channelId: "CSTALE",
      leftAt: "2026-07-22T10:05:00.000Z",
    });
    await store.syncBotChannels({
      teamId: "TSTALE",
      enterpriseId: null,
      channelIds: ["CSTALE"],
      seenAt: "2026-07-22T10:04:00.000Z",
    });
    assert.equal((await store.activeBotChannels("TSTALE")).length, 0);

    // An out-of-order join event (older than the leave, e.g. a delayed
    // retry) must not resurrect it either.
    await store.recordChannelJoin({
      teamId: "TSTALE",
      enterpriseId: null,
      channelId: "CSTALE",
      joinedAt: "2026-07-22T10:03:00.000Z",
    });
    assert.equal((await store.activeBotChannels("TSTALE")).length, 0);

    // A genuinely fresh poll (snapshot after the leave) revives the channel
    // as a NEW introduction with reset ordering.
    await store.syncBotChannels({
      teamId: "TSTALE",
      enterpriseId: null,
      channelIds: ["CSTALE"],
      seenAt: "2026-07-22T10:10:00.000Z",
    });
    const revived = await store.activeBotChannels("TSTALE");
    assert.equal(revived.length, 1);
    assert.equal(revived[0].joinedAt, null);
    assert.equal(revived[0].firstSeenAt, "2026-07-22T10:10:00.000Z");
  }

  // --- Advisory onboarding probe failure cannot stall the start ---
  {
    // The Slack sweep throwing must not 500 the start: the cycle would stay
    // `analyzing` with no attemptId returned, and retries would exit as
    // duplicates forever. Unknown onboarding → flag omitted, start succeeds.
    const slack = makeSlackStub({ teamId: "TPROBE", channels: [] });
    slack.listBotChannels = async () => {
      throw new Error("slack is down");
    };
    const app = makeApp(makeGithubStub(), slack);
    const start = await startRun(app, makeStart(26, { headSha: "probe00001" }));
    assert.equal(start.res.statusCode, 200);
    assert.ok(start.body.attemptId);
    assert.equal(start.body.onboarded, undefined);
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
