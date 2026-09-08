import assert from "node:assert/strict";
import crypto from "node:crypto";
import { request as httpRequest } from "node:http";
import { Client } from "pg";
import { buildServer } from "../src/http";
import { GitHubAuthorizationError, GitHubRequestError, type GitHubClient, type RepositoryAccess } from "../src/github";
import { OidcAuthenticationError, OidcProviderError } from "../src/oidc";
import type { ServiceEnv } from "../src/env";
import { SlackApiError, type SlackClient } from "../src/slack";
import type { CycleRecord } from "../src/storage";
import { encryptSlackToken } from "../src/slack-token-crypto";
import { PostgresCycleStore } from "../src/storage/postgres";

const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const name = `feature_rec_http_${crypto.randomBytes(8).toString("hex")}`;
const maintenance = new Client({ connectionString: adminUrl });
await maintenance.connect();
await maintenance.query(`create database ${name}`);
const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${name}`;
const db = new Client({ connectionString: dbUrl.toString() });
const store = new PostgresCycleStore(dbUrl.toString());
await store.init();
await db.connect();
const encryptionKey = Buffer.alloc(32, 17);
const env: ServiceEnv = {
  port: 0, baseUrl: "https://service.example", databaseUrl: dbUrl.toString(),
  githubAppId: "", githubPrivateKey: "", githubOidcIssuer: "https://token.actions.githubusercontent.com",
  slackTokenEncryptionKey: encryptionKey, slackSigningSecret: "signed-workspace-secret",
};
const tenants = { A: crypto.randomUUID(), B: crypto.randomUUID(), D: crypto.randomUUID() };
const accounts = { A: "601", B: "602", D: "603" };
const installations = { A: "501", B: "502", D: "503" };
for (const team of ["A", "B", "D"] as const) {
  await db.query("insert into tenants (id,enabled) values ($1,$2)", [tenants[team], team !== "D"]);
  await db.query("insert into github_installations (installation_id,tenant_id,github_account_id) values ($1,$2,$3)", [installations[team], tenants[team], accounts[team]]);
  await db.query("insert into slack_workspaces (team_id,tenant_id,bot_user_id,bot_token_ciphertext,selected_channel_id) values ($1,$2,$3,$4,$5)", [
    `T${team}`, tenants[team], `UBOT${team}`, encryptSlackToken({ token: `token-${team}`, teamId: `T${team}`, key: encryptionKey }), `C${team}`,
  ]);
}
const identities: Record<string, { repositoryId: string; repositoryOwnerId: string; eventName: string }> = {
  A: { repositoryId: "101", repositoryOwnerId: "601", eventName: "pull_request" },
  B: { repositoryId: "102", repositoryOwnerId: "602", eventName: "pull_request" },
  A2: { repositoryId: "103", repositoryOwnerId: "601", eventName: "pull_request" },
  BHistorical: { repositoryId: "101", repositoryOwnerId: "602", eventName: "pull_request" },
  hugeOwner: { repositoryId: "101", repositoryOwnerId: "999999999999999999999999", eventName: "pull_request" },
  D: { repositoryId: "104", repositoryOwnerId: "603", eventName: "pull_request" },
  unknown: { repositoryId: "999", repositoryOwnerId: "999", eventName: "pull_request" },
};
let oidcCalls = 0;
let streamTokenExpired = false;
let streamTokenVerified = false;
let grantError: Error | null = null;
let grantFailures = 0;
let grantCalls = 0;
let grantWait: Promise<void> | undefined;
let prError: Error | null = null;
let wrongOwner = false;
let currentName = "Acme/Repo";
let prState: "open" | "closed" = "open";
let draft = false;
let prHead = "head0000001";
const githubCalls: Array<{ kind: string; repositoryId: string; fullName: string }> = [];
let nextCheck = 100;
const record = (kind: string, access: RepositoryAccess) => { githubCalls.push({ kind, repositoryId: access.repositoryId, fullName: access.fullName }); };
const github = {
  authorizeRepository: async (installationId: string, repositoryId: string): Promise<RepositoryAccess> => {
    grantCalls++;
    if (grantWait) await grantWait;
    if (grantFailures-- > 0) throw new GitHubRequestError(503);
    if (grantError) throw grantError;
    const repositoryOwnerId = wrongOwner ? "999" : installationId === "501" ? "601" : "602";
    const [owner, repo] = currentName.split("/");
    return { repositoryId, repositoryOwnerId, token: `scoped-${installationId}-${repositoryId}-${grantCalls}`, expiresAt: Date.now() + 3_600_000, owner, repo, fullName: currentName };
  },
  getPullRequest: async () => { if (prError) throw prError; return { state: prState, draft, headSha: prHead, prTitle: "GitHub title", prAuthor: "github-author" }; },
  createCheckRun: async (_cycle: unknown, access: RepositoryAccess) => { record("create", access); return ++nextCheck; },
  updateCheckRun: async (_cycle: unknown, _details: unknown, access: RepositoryAccess) => { record("update", access); },
  accept: async (_cycle: unknown, access: RepositoryAccess) => { record("accept", access); },
  reject: async (_cycle: unknown, _comment: string, access: RepositoryAccess) => { record("reject", access); },
};
const slackCalls: Array<{ kind: string; token: string; channel?: string; fullName?: string; state?: string; ts?: string }> = [];
let clientConstructions = 0;
const revokedTokens = new Set<string>();
let identityError: Error | null = null;
let identityOverride: { teamId: string; userId: string } | undefined;
let identityHook: ((token: string) => Promise<void>) | undefined;
let membershipHook: (() => Promise<void>) | undefined;
let uploadError: Error | null = null;
let uploadHook: ((cycle: CycleRecord) => Promise<void>) | undefined;
let finalizeFailures = 0;
let approverAllowed = true;
const clientFactory = (token: string): SlackClient => {
  clientConstructions++;
  const team = token.slice(-1);
  return {
    botIdentity: async () => {
      await identityHook?.(token);
      if (identityError) throw identityError;
      if (revokedTokens.has(token)) throw new SlackApiError("token_revoked", "revoked");
      return identityOverride ?? { teamId: `T${team}`, userId: `UBOT${team}` };
    },
    listBotChannels: async () => { await membershipHook?.(); slackCalls.push({ kind: "list", token }); return [`C${team}`]; },
    postMessage: async (channel: string) => { slackCalls.push({ kind: "message", token, channel }); },
    uploadVideo: async (cycle: CycleRecord, channel: string, _video: Buffer, fullName: string) => { await uploadHook?.(cycle); if (uploadError) throw uploadError; slackCalls.push({ kind: "upload", token, channel, fullName }); },
    postValidation: async (_cycle: unknown, channel: string, _mention: unknown, fullName: string) => { slackCalls.push({ kind: "validation", token, channel, fullName }); return { channel, ts: "123.456" }; },
    finalize: async (cycle: CycleRecord, state: string) => {
      if (!cycle.slackChannelId || !cycle.slackMessageTs) return;
      slackCalls.push({ kind: "finalize", token, channel: cycle.slackChannelId, state, ts: cycle.slackMessageTs });
      if (finalizeFailures > 0) { finalizeFailures--; throw new Error("Slack finalize unavailable"); }
    },
    isApprover: async () => approverAllowed,
    openRequestChangesModal: async () => { slackCalls.push({ kind: "modal", token }); },
    respondEphemeral: async () => {},
  } as unknown as SlackClient;
};
const ephemeral: string[] = [];
const app = buildServer({ env, store, github: github as unknown as GitHubClient, slackClientFactory: clientFactory,
  respondEphemeral: async (_url, text) => { ephemeral.push(text); },
  oidc: { verify: async (header) => {
    oidcCalls++;
    if (header === "Bearer expiring-A") {
      if (streamTokenExpired) throw new OidcAuthenticationError("expired");
      streamTokenVerified = true;
      return identities.A;
    }
    if (header === "Bearer provider-down") throw new OidcProviderError();
    const identity = identities[(header ?? "").replace(/^Bearer /, "")];
    if (!identity) throw new OidcAuthenticationError();
    return identity;
  } },
});
const lifecycleWarnings: Array<Record<string, unknown>> = [];
app.addHook("onRequest", async (request) => {
  if (request.url === "/api/slack/events") {
    request.log.warn = (fields: unknown) => {
      if (fields && typeof fields === "object") lifecycleWarnings.push(fields as Record<string, unknown>);
    };
  }
});
async function start(identity = "A", prNumber = 1, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/api/runs/start", headers: { authorization: `Bearer ${identity}` }, payload: { prNumber, headSha: prHead, ...extra } });
}
async function result(cycleId: string, attemptId: string, identity: string, action: "accepted" | "failed" | "video") {
  return app.inject({ method: "POST", url: `/api/runs/${cycleId}/${action}`,
    headers: { authorization: `Bearer ${identity}`, ...(action === "video" ? { "content-type": "application/octet-stream", "x-feature-rec-attempt": attemptId } : {}) },
    payload: action === "video" ? Buffer.from("video") : { attemptId, message: "render failed" },
  });
}
function signed(raw: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${crypto.createHmac("sha256", env.slackSigningSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}` };
}
async function event(teamId: string, type: string, extra: Record<string, unknown> = {}) {
  const raw = JSON.stringify({ type: "event_callback", team_id: teamId, event: { type, ...extra } });
  return app.inject({ method: "POST", url: "/api/slack/events", headers: { ...signed(raw), "content-type": "application/json" }, payload: raw });
}
async function click(teamId: string, cycleId: string, headSha: string, actionTs: string) {
  const raw = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", team: { id: teamId }, user: { id: "UREVIEWER" }, trigger_id: actionTs, response_url: "https://hooks.slack.com/test",
    actions: [{ action_ts: actionTs, value: JSON.stringify({ action: "accept", cycleId, headSha }) }] }) }).toString();
  return app.inject({ method: "POST", url: "/api/slack/interactivity", headers: { ...signed(raw), "content-type": "application/x-www-form-urlencoded" }, payload: raw });
}
async function submit(teamId: string, cycleId: string, viewId: string, comment = "Keep this comment", headSha = prHead) {
  const raw = new URLSearchParams({ payload: JSON.stringify({ type: "view_submission", team: { id: teamId }, user: { id: "UREVIEWER" },
    view: { id: viewId, hash: "hash", private_metadata: JSON.stringify({ cycleId, headSha }),
      state: { values: { comment: { value: { value: comment } } } } } }) }).toString();
  return app.inject({ method: "POST", url: "/api/slack/interactivity", headers: { ...signed(raw), "content-type": "application/x-www-form-urlencoded" }, payload: raw });
}
async function waitFor(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("asynchronous Slack handler did not complete");
}
try {
  for (const [identity, status] of [["legacy-shared-runner-token", 401], ["provider-down", 503], ["unknown", 403], ["hugeOwner", 403], ["D", 403]] as const) {
    const response = await start(identity);
    assert.equal(response.statusCode, status);
  }
  // Header auth runs before even invalid JSON reaches the body parser.
  assert.equal((await app.inject({ method: "POST", url: "/api/runs/start", headers: { "content-type": "application/json" }, payload: "not-json" })).statusCode, 401);
  grantError = new GitHubRequestError(401);
  assert.equal((await start()).statusCode, 502);
  grantError = null;
  const count = async () => Number((await db.query("select count(*) from review_cycles")).rows[0].count);
  assert.equal(await count(), 0);
  for (const error of [new GitHubAuthorizationError()]) {
    grantError = error;
    assert.equal((await start()).statusCode, 403);
  }
  grantError = new GitHubRequestError(429, true, 60);
  const beforeRateLimit = grantCalls;
  const rateLimited = await start();
  assert.equal(rateLimited.statusCode, 503);
  assert.equal(rateLimited.headers["retry-after"], "60");
  assert.equal(grantCalls - beforeRateLimit, 1);
  grantError = new GitHubRequestError(503);
  assert.equal((await start()).statusCode, 503);
  grantError = null;
  for (const [status, expected] of [[401, 502], [403, 502], [404, 502], [422, 502], [503, 503]] as const) {
    prError = new GitHubRequestError(status);
    const response = await start();
    assert.equal(response.statusCode, expected);
    assert.deepEqual(response.json(), { error: expected === 502 ? "github_request_failed" : "authorization_temporarily_unavailable" });
  }
  prError = null;
  wrongOwner = true;
  assert.equal((await start()).statusCode, 403);
  wrongOwner = false;
  assert.equal(await count(), 0);
  for (const reason of ["closed", "draft", "stale_head"] as const) {
    prState = reason === "closed" ? "closed" : "open"; draft = reason === "draft";
    const response = await start("A", 1, reason === "stale_head" ? { headSha: "stale000001" } : {});
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { skipped: true, reason });
  }
  draft = true;
  const grantsBeforeRetry = grantCalls;
  grantFailures = 2;
  assert.equal((await start()).statusCode, 200);
  assert.equal(grantCalls - grantsBeforeRetry, 3, "transient authorization retries before creating any cycle");
  prState = "open"; draft = false;
  assert.equal(await count(), 0);
  assert.equal(githubCalls.length, 0, "non-actionable PRs create neither cycles nor checks");
  // Extra caller fields never contribute authority or persisted PR metadata.
  const spoofed = await start("A", 1, { tenantId: tenants.B, owner: "attacker", prTitle: "spoofed" });
  assert.equal(spoofed.statusCode, 200);
  const a = spoofed.json();
  const b = (await start("B")).json();
  assert.ok(a.cycleId && b.cycleId);
  const cycleA = await store.getCycle(a.cycleId);
  assert.equal(cycleA?.tenantId, tenants.A);
  assert.equal(cycleA?.repositoryId, "101");
  assert.equal(cycleA?.prAuthor, "github-author");
  assert.equal(cycleA?.prTitle, "GitHub title");
  assert.equal(cycleA?.owner, "Acme", "compatibility names are written from authorized GitHub metadata");
  assert.equal((await start("A")).json().duplicate, true);
  for (const action of ["accepted", "failed", "video"] as const) {
    assert.equal((await result(b.cycleId, b.attemptId, "A", action)).statusCode, 403);
    assert.equal((await result(a.cycleId, a.attemptId, "A2", action)).statusCode, 403);
    assert.equal((await result(a.cycleId, a.attemptId, "legacy-shared-runner-token", action)).statusCode, 401);
    const stale = await result(a.cycleId, "wrong-attempt", "A", action);
    assert.equal(stale.statusCode, 200);
    assert.deepEqual(stale.json(), { ok: false, stale: true });
  }
  assert.equal((await store.getCycle(a.cycleId))?.status, "analyzing");
  grantError = new GitHubAuthorizationError();
  assert.equal((await result(a.cycleId, a.attemptId, "A", "accepted")).statusCode, 403);
  assert.equal((await store.getCycle(a.cycleId))?.status, "analyzing");
  grantError = null;
  currentName = "Acme/Renamed";
  const beforeResults = oidcCalls;
  assert.equal((await result(a.cycleId, a.attemptId, "A", "video")).statusCode, 200);
  assert.equal((await result(b.cycleId, b.attemptId, "B", "video")).statusCode, 200);
  assert.equal(oidcCalls, beforeResults + 2);
  assert.deepEqual(slackCalls.filter((c) => c.kind === "upload").map(({ token, channel, fullName }) => ({ token, channel, fullName })), [
    { token: "token-A", channel: "CA", fullName: "Acme/Renamed" }, { token: "token-B", channel: "CB", fullName: "Acme/Renamed" },
  ]);
  assert.equal(githubCalls.at(-1)?.fullName, "Acme/Renamed");
  const beforeClients = clientConstructions;
  await event("TA", "member_joined_channel", { user: "UHUMAN", channel: "CA" });
  assert.equal(clientConstructions, beforeClients, "human joins do not decrypt or construct clients");
  await click("TA", b.cycleId, prHead, "cross-team");
  await click("", a.cycleId, prHead, "missing-team");
  await click("TA", a.cycleId, "wrong-head", "wrong-head");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await store.getCycle(b.cycleId))?.status, "pending_validation");
  assert.equal((await db.query("select count(*) from processed_interactions where id like '%cross-team%'")).rows[0].count, "0");
  assert.equal(clientConstructions, beforeClients, "cross-team/missing-team/head mismatch rejected before decryption");
  grantError = new GitHubAuthorizationError();
  await click("TA", a.cycleId, prHead, "revoked-access");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await store.getCycle(a.cycleId))?.status, "pending_validation", "Slack cannot transition without GitHub authorization");
  assert.match(ephemeral.at(-1)!, /restore the GitHub App/);
  const modalDenied = await submit("TA", a.cycleId, "denied-modal");
  assert.equal(modalDenied.json().response_action, "errors");
  assert.match(modalDenied.json().errors.comment, /restore the GitHub App/);
  assert.equal((await db.query("select count(*) from processed_interactions where id like '%denied-modal%'")).rows[0].count, "0");
  grantError = null;
  let releaseGrant!: () => void;
  grantWait = new Promise<void>((resolve) => { releaseGrant = resolve; });
  const slowModal = await submit("TA", a.cycleId, "slow-modal");
  assert.equal(slowModal.json().response_action, "errors");
  assert.match(slowModal.json().errors.comment, /preserved/);
  releaseGrant(); grantWait = undefined;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await store.getCycle(a.cycleId))?.status, "pending_validation", "timed-out preparation cannot mutate later");
  assert.equal((await db.query("select count(*) from processed_interactions where id like '%slow-modal%'")).rows[0].count, "0");
  await click("TA", a.cycleId, prHead, "valid-accept");
  await waitFor(async () => (await store.getCycle(a.cycleId))?.status === "accepted");
  assert.equal(githubCalls.filter((c) => c.kind === "accept").length, 1);
  // Each preparation rejection must preserve the modal's comment and leave
  // dedupe, cycle state, and provider mutations untouched.
  for (const [teamId, cycleId, viewId, headSha, message] of [
    ["TA", a.cycleId, "decided-modal", prHead, /no longer pending/],
    ["TB", b.cycleId, "stale-head-modal", "outdated-head", /no longer pending/],
    ["TB", crypto.randomUUID(), "missing-cycle-modal", prHead, /no longer pending/],
    ["TA", b.cycleId, "cross-team-modal", prHead, /cannot approve/],
    ["", b.cycleId, "missing-team-modal", prHead, /cannot approve/],
    ["TD", b.cycleId, "disabled-team-modal", prHead, /cannot approve/],
    ["TB", b.cycleId, "approver-denied-modal", prHead, /cannot approve/],
  ] as const) {
    const callsBefore: number = githubCalls.length;
    const grantsBefore = grantCalls;
    const statusBefore = (await store.getCycle(cycleId))?.status;
    approverAllowed = viewId !== "approver-denied-modal";
    try {
      const rejectedModal = await submit(teamId, cycleId, viewId, "Keep this comment", headSha);
      assert.equal(rejectedModal.statusCode, 200);
      assert.equal(rejectedModal.json().response_action, "errors");
      assert.match(rejectedModal.json().errors.comment, message);
      assert.equal((await store.getCycle(cycleId))?.status, statusBefore);
      assert.equal((await db.query("select count(*) from processed_interactions where id=$1", [`view:${viewId}:hash`])).rows[0].count, "0");
      assert.equal(grantCalls, grantsBefore, "rejected modal preparation does not request GitHub access");
      assert.equal(githubCalls.length, callsBefore, "rejected modal preparation does not mutate GitHub");
    } finally { approverAllowed = true; }
  }
  // Historical same repository IDs in different tenants have different keys.
  const historical = (await start("BHistorical")).json();
  assert.notEqual(historical.cycleKey, a.cycleKey);
  assert.equal((await store.getCycle(historical.cycleId))?.tenantId, tenants.B);
  // Finalization of an existing Slack message has no dependency on GH access.
  const old = (await start("A", 8)).json();
  await result(old.cycleId, old.attemptId, "A", "video");
  const finalizedBefore = slackCalls.filter((c) => c.kind === "finalize" && c.token === "token-A").length;
  const update = github.updateCheckRun;
  github.updateCheckRun = async () => { throw new GitHubRequestError(404); };
  prHead = "head0000002";
  await start("A", 8);
  await waitFor(async () => slackCalls.filter((c) => c.kind === "finalize" && c.token === "token-A").length > finalizedBefore);
  assert.equal((await store.getCycle(old.cycleId))?.status, "superseded");
  github.updateCheckRun = update;
  // A failed check restoration must release the attempt for another retry.
  const restore = (await start("A", 9)).json();
  await result(restore.cycleId, restore.attemptId, "A", "failed");
  github.updateCheckRun = async () => { throw new GitHubRequestError(503); };
  assert.equal((await start("A", 9)).statusCode, 503);
  assert.equal((await store.getCycle(restore.cycleId))?.status, "failed");
  github.updateCheckRun = update;
  const restored = (await start("A", 9)).json();
  assert.equal(restored.cycleId, restore.cycleId);
  assert.ok(restored.attemptId && restored.attemptId !== restore.attemptId);
  const rejectCycle = (await start("A", 10)).json();
  await result(rejectCycle.cycleId, rejectCycle.attemptId, "A", "video");
  assert.equal((await submit("TA", rejectCycle.cycleId, "valid-modal")).body, "");
  await waitFor(async () => (await store.getCycle(rejectCycle.cycleId))?.status === "rejected");
  // Send only headers first over a real socket. The body arrives after the
  // fake token expires, so verification in the body handler would reject it.
  const streamed = (await start("A", 13)).json();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  let finishUpload!: () => void;
  const streamedResponse = new Promise<number>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: address.port, method: "POST", path: `/api/runs/${streamed.cycleId}/video`,
      headers: { authorization: "Bearer expiring-A", "content-type": "application/octet-stream", "x-feature-rec-attempt": streamed.attemptId, "transfer-encoding": "chunked" } },
      (response) => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
    request.on("error", reject);
    finishUpload = () => { request.end("video"); };
    request.flushHeaders();
  });
  await waitFor(async () => streamTokenVerified);
  streamTokenExpired = true;
  finishUpload();
  assert.equal(await streamedResponse, 200);
  assert.equal((await store.getCycle(streamed.cycleId))?.status, "pending_validation");

  const revokedVideo = (await start("A", 11)).json();
  uploadError = new SlackApiError("token_revoked", "revoked");
  const revokedDelivery = await result(revokedVideo.cycleId, revokedVideo.attemptId, "A", "video");
  assert.equal(revokedDelivery.statusCode, 422);
  assert.deepEqual({ error: revokedDelivery.json().error, settled: revokedDelivery.json().settled }, { error: "slack_unavailable", settled: true });
  assert.equal((await store.getCycle(revokedVideo.cycleId))?.status, "failed");
  uploadError = null;
  const transientVideo = (await start("A", 14)).json();
  uploadError = new SlackApiError("ratelimited", "temporary");
  const transientDelivery = await result(transientVideo.cycleId, transientVideo.attemptId, "A", "video");
  assert.equal(transientDelivery.statusCode, 500);
  assert.equal(transientDelivery.json().error, "video_delivery_failed");
  assert.equal(transientDelivery.json().settled, true);
  assert.equal((await store.getCycle(transientVideo.cycleId))?.status, "failed", "no runner failure callback is needed");
  uploadError = null;
  const deliveryRetry = (await start("A", 14)).json();
  assert.equal(deliveryRetry.cycleId, transientVideo.cycleId);
  assert.ok(deliveryRetry.attemptId && deliveryRetry.attemptId !== transientVideo.attemptId);

  // Even a GitHub outage affecting both the pending update and failure cleanup
  // leaves a failed cycle that can be taken over by a same-head workflow rerun.
  const githubOutage = (await start("A", 15)).json();
  let failedCheckAttempts = 0;
  github.updateCheckRun = async () => {
    if ((await store.getCycle(githubOutage.cycleId))?.status === "failed") failedCheckAttempts++;
    throw new GitHubRequestError(503, true, 60);
  };
  try {
    const delivery = await result(githubOutage.cycleId, githubOutage.attemptId, "A", "video");
    assert.equal(delivery.statusCode, 503);
    assert.equal(delivery.headers["retry-after"], "60");
    assert.equal(delivery.json().settled, true);
    assert.equal(delivery.json().error, "video_delivery_failed");
    assert.equal((await store.getCycle(githubOutage.cycleId))?.status, "failed");
    assert.equal(failedCheckAttempts, 3);
  } finally { github.updateCheckRun = update; }

  const githubRejectedUpdate = (await start("A", 20)).json();
  github.updateCheckRun = async () => { throw new GitHubRequestError(422); };
  try {
    const delivery = await result(githubRejectedUpdate.cycleId, githubRejectedUpdate.attemptId, "A", "video");
    assert.equal(delivery.statusCode, 502);
    assert.equal(delivery.json().settled, true);
    assert.equal(delivery.json().error, "video_delivery_failed");
    assert.equal(delivery.headers["retry-after"], undefined);
    assert.equal((await store.getCycle(githubRejectedUpdate.cycleId))?.status, "failed");
  } finally { github.updateCheckRun = update; }

  // A validation post can succeed before persisting its coordinates fails.
  // Clean up that known message even if the independent GitHub update fails.
  const attachmentFailure = (await start("A", 16)).json();
  const attachSlackMessage = store.attachSlackMessage.bind(store);
  store.attachSlackMessage = async () => { throw new Error("private-database-diagnostic"); };
  github.updateCheckRun = async (cycle, details, access) => {
    if ((await store.getCycle(attachmentFailure.cycleId))?.status === "failed") throw new GitHubRequestError(503);
    return update(cycle, details, access);
  };
  const finalizedBeforeAttachmentFailure = slackCalls.filter((call) => call.kind === "finalize").length;
  try {
    const delivery = await result(attachmentFailure.cycleId, attachmentFailure.attemptId, "A", "video");
    assert.equal(delivery.statusCode, 500);
    assert.equal(delivery.json().settled, true);
    assert.doesNotMatch(delivery.body, /private-database-diagnostic/);
    assert.equal((await store.getCycle(attachmentFailure.cycleId))?.status, "failed");
    const finalizations = slackCalls.filter((call) => call.kind === "finalize").slice(finalizedBeforeAttachmentFailure);
    assert.deepEqual(finalizations, [{ kind: "finalize", token: "token-A", channel: "CA", state: "failed", ts: "123.456" }]);
  } finally {
    store.attachSlackMessage = attachSlackMessage;
    github.updateCheckRun = update;
  }

  // Only a token near/past expiry needs a fresh grant after Slack delivery.
  // An otherwise usable token can repair the check even if minting is down.
  for (const [prNumber, remainingMs, refresh] of [
    [25, 3_000_000, false], [28, 60_001, false], [29, 60_000, true], [30, 0, true], [31, -1, true],
  ] as const) {
    const deliveryCycle = (await start("A", prNumber)).json();
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    let pendingAccess: RepositoryAccess | undefined;
    let uploadFinished = false;
    const failureTokens: string[] = [];
    const grantsBeforeExpiry = grantCalls;
    const oidcBeforeExpiry = oidcCalls;
    github.updateCheckRun = async (cycle, details, access) => {
      if ((await store.getCycle(deliveryCycle.cycleId))?.status === "pending_validation") {
        pendingAccess = access;
      } else {
        assert.equal(uploadFinished, true);
        if (access.expiresAt <= Date.now()) throw new GitHubRequestError(401);
        failureTokens.push(access.token);
        assert.equal((details as { conclusion?: string }).conclusion, "failure");
      }
      return update(cycle, details, access);
    };
    uploadHook = async () => {
      assert.ok(pendingAccess, "the initial token worked before upload");
      now = pendingAccess.expiresAt - remainingMs;
      uploadFinished = true;
      if (!refresh) grantError = new GitHubRequestError(503);
      throw new Error("Slack upload failed after time elapsed");
    };
    try {
      const delivery = await result(deliveryCycle.cycleId, deliveryCycle.attemptId, "A", "video");
      assert.equal(delivery.statusCode, 500);
      assert.equal(delivery.json().settled, true);
      assert.equal((await store.getCycle(deliveryCycle.cycleId))?.status, "failed");
      assert.equal(grantCalls, grantsBeforeExpiry + (refresh ? 2 : 1), "cleanup only obtains fresh access within the expiry margin");
      assert.equal(failureTokens.length, 1, "the failure check succeeds with usable access");
      assert.ok(pendingAccess);
      assert.equal(failureTokens[0] === pendingAccess.token, !refresh);
      assert.equal(oidcCalls, oidcBeforeExpiry + 1, "failure cleanup does not reverify the runner's expiring OIDC token");
    } finally {
      Date.now = originalNow;
      grantError = null;
      uploadHook = undefined;
      github.updateCheckRun = update;
    }
  }

  // Losing GitHub access during delivery cannot suppress cleanup of a known
  // Slack message or undo the already committed failed cycle.
  for (const [prNumber, error, cleanupGrants] of [
    [26, new GitHubAuthorizationError(), 1], [27, new GitHubRequestError(503), 3],
  ] as const) {
    const deniedCleanup = (await start("A", prNumber)).json();
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    store.attachSlackMessage = async () => {
      if (!grantError) now += 3_600_000;
      grantError = error;
      throw new Error("Slack attachment failed after GitHub access changed");
    };
    const grantsBefore = grantCalls;
    const updatesBefore = githubCalls.filter((call) => call.kind === "update").length;
    const finalizedBefore = slackCalls.filter((call) => call.kind === "finalize").length;
    try {
      const delivery = await result(deniedCleanup.cycleId, deniedCleanup.attemptId, "A", "video");
      assert.equal(delivery.statusCode, 500);
      assert.equal(delivery.json().settled, true);
      assert.equal((await store.getCycle(deniedCleanup.cycleId))?.status, "failed");
      assert.equal(grantCalls, grantsBefore + 1 + cleanupGrants, "cleanup honors bounded authorization retries");
      assert.equal(githubCalls.filter((call) => call.kind === "update").length, updatesBefore + 1,
        "only the initial pending check update uses the initial grant");
      assert.deepEqual(slackCalls.filter((call) => call.kind === "finalize").slice(finalizedBefore), [
        { kind: "finalize", token: "token-A", channel: "CA", state: "failed", ts: "123.456" },
      ]);
    } finally {
      Date.now = originalNow;
      grantError = null;
      store.attachSlackMessage = attachSlackMessage;
    }
  }

  // Another decision winning during delivery must not be overwritten by a
  // caught error from the older pending operation.
  for (const [prNumber, status] of [[17, "accepted"], [18, "superseded"]] as const) {
    const concurrent = (await start("A", prNumber)).json();
    uploadHook = async (cycle) => {
      await store.transitionSlackStatus({ tenantId: tenants.A, cycleId: cycle.id, from: ["pending_validation"], to: status });
      throw new Error("delivery failed after another decision");
    };
    const updatesBefore = githubCalls.filter((call) => call.kind === "update").length;
    try {
      const delivery = await result(concurrent.cycleId, concurrent.attemptId, "A", "video");
      assert.deepEqual(delivery.json(), { ok: false, stale: true });
      assert.equal((await store.getCycle(concurrent.cycleId))?.status, status);
      assert.equal(githubCalls.filter((call) => call.kind === "update").length, updatesBefore + 1, "only the earlier in-progress check update ran");
    } finally { uploadHook = undefined; }
  }

  // Supersession can win after the post but before its coordinates persist.
  // Its cleanup sees no message; only the losing delivery can remove those
  // buttons. A concurrent reviewer decision must never be relabeled instead.
  for (const [prNumber, status, cleanupFailures] of [
    [21, "superseded", 1], [22, "accepted", 0], [23, "rejected", 0], [24, "superseded", 3],
  ] as const) {
    const concurrent = (await start("A", prNumber)).json();
    const previousHead = prHead;
    let attachmentAttempts = 0;
    let replacementCycleId: string | undefined;
    store.attachSlackMessage = async (cycleId) => {
      if (++attachmentAttempts === 1) {
        if (status === "superseded") {
          prHead = "head0000003";
          replacementCycleId = (await start("A", prNumber)).json().cycleId;
          assert.ok(replacementCycleId && replacementCycleId !== cycleId);
        } else {
          await store.transitionSlackStatus({ tenantId: tenants.A, cycleId, from: ["pending_validation"], to: status });
        }
      }
      throw new Error("Slack attachment unavailable after competing transition");
    };
    finalizeFailures = cleanupFailures;
    const finalizedBefore = slackCalls.filter((call) => call.kind === "finalize").length;
    const updatesBefore = githubCalls.filter((call) => call.kind === "update").length;
    try {
      const delivery = await result(concurrent.cycleId, concurrent.attemptId, "A", "video");
      assert.equal(delivery.statusCode, 200);
      assert.deepEqual(delivery.json(), { ok: false, stale: true });
      assert.equal(attachmentAttempts, 3);
      const current = await store.getCycle(concurrent.cycleId);
      assert.equal(current?.status, status);
      assert.equal(current?.slackMessageTs, null, "the posted message was never persisted");
      const finalizations = slackCalls.filter((call) => call.kind === "finalize").slice(finalizedBefore);
      const expectedFinalizations = status === "superseded" ? Math.min(cleanupFailures + 1, 3) : 0;
      assert.deepEqual(finalizations, Array.from({ length: expectedFinalizations }, () => ({
        kind: "finalize", token: "token-A", channel: "CA", state: "superseded", ts: "123.456",
      })));
      assert.equal(githubCalls.filter((call) => call.kind === "update").length, updatesBefore + (status === "superseded" ? 2 : 1),
        "only the initial pending update and the superseder's neutral update can run");
      if (replacementCycleId) assert.equal((await store.getCycle(replacementCycleId))?.status, "analyzing");
    } finally {
      store.attachSlackMessage = attachSlackMessage;
      finalizeFailures = 0;
      prHead = previousHead;
    }
  }

  // Never claim settlement if the database failure transition itself fails.
  const databaseOutage = (await start("A", 19)).json();
  const transitionRunnerStatus = store.transitionRunnerStatus.bind(store);
  uploadError = new Error("upload unavailable");
  store.transitionRunnerStatus = async (input) => {
    if (input.to === "failed") throw new Error("database unavailable");
    return transitionRunnerStatus(input);
  };
  try {
    const delivery = await result(databaseOutage.cycleId, databaseOutage.attemptId, "A", "video");
    assert.equal(delivery.statusCode, 500);
    assert.notEqual(delivery.json().settled, true);
    assert.equal((await store.getCycle(databaseOutage.cycleId))?.status, "pending_validation");
  } finally {
    store.transitionRunnerStatus = transitionRunnerStatus;
    uploadError = null;
  }

  // A corrupt join token must not turn an already deduped greeting into a 500.
  const workspaceA = (await store.getSlackWorkspaceByTeamId("TA"))!;
  await db.query("update slack_workspaces set bot_token_ciphertext='corrupt', selected_channel_id=null where team_id='TA'");
  assert.equal((await event("TA", "member_joined_channel", { user: "UBOTA", channel: "CA" })).statusCode, 200);
  const clientsBeforeCorruptLifecycle = clientConstructions;
  const corruptLifecycle = await event("TA", "tokens_revoked");
  assert.equal(corruptLifecycle.statusCode, 503);
  assert.equal(corruptLifecycle.headers["retry-after"], "10");
  assert.equal(clientConstructions, clientsBeforeCorruptLifecycle, "unreadable lifecycle credentials never reach Slack");
  assert.equal((await store.getSlackWorkspaceByTeamId("TA"))?.botTokenCiphertext, "corrupt");
  assert.equal(lifecycleWarnings.at(-1)?.category, "slack_lifecycle_unverified");
  assert.ok(lifecycleWarnings.at(-1)?.err instanceof Error);
  await db.query("update slack_workspaces set bot_token_ciphertext=$1 where team_id='TA'", [workspaceA.botTokenCiphertext]);

  // Old and companion lifecycle deliveries cannot remove a still-valid token.
  assert.equal((await event("TA", "app_uninstalled")).statusCode, 200);
  assert.equal((await event("TA", "tokens_revoked")).statusCode, 200);
  assert.equal((await store.getSlackWorkspaceByTeamId("TA"))?.enabled, true);
  for (const code of ["ratelimited", "invalid_auth"]) {
    identityError = new SlackApiError(code, "private-provider-response");
    try {
      assert.equal((await event("TA", "app_uninstalled")).statusCode, 503);
      const preservedWorkspace = await store.getSlackWorkspaceByTeamId("TA");
      assert.equal(preservedWorkspace?.enabled, true);
      assert.equal(preservedWorkspace?.botTokenCiphertext, workspaceA.botTokenCiphertext);
      const verificationError = lifecycleWarnings.at(-1)?.err;
      assert.ok(verificationError instanceof Error);
      assert.doesNotMatch(verificationError.message, /private-provider-response/);
      assert.equal(verificationError.cause, undefined);
    } finally { identityError = null; }
  }
  for (const mismatchedIdentity of [
    { teamId: "TB", userId: "UBOTA" },
    { teamId: "TA", userId: "UOTHER" },
  ]) {
    identityOverride = mismatchedIdentity;
    try {
      const mismatchedLifecycle = await event("TA", "app_uninstalled");
      assert.equal(mismatchedLifecycle.statusCode, 503);
      assert.equal(mismatchedLifecycle.headers["retry-after"], "10");
      assert.equal((await store.getSlackWorkspaceByTeamId("TA"))?.enabled, true);
      assert.equal(lifecycleWarnings.at(-1)?.category, "slack_lifecycle_unverified");
    } finally { identityOverride = undefined; }
  }
  const deleteSlackWorkspace = store.deleteSlackWorkspace.bind(store);
  revokedTokens.add("token-A");
  store.deleteSlackWorkspace = async () => {
    throw Object.assign(new Error("private-database-diagnostic"), { code: "53300", detail: workspaceA.botTokenCiphertext });
  };
  try {
    const failedCleanup = await event("TA", "tokens_revoked");
    assert.equal(failedCleanup.statusCode, 503);
    assert.equal(failedCleanup.headers["retry-after"], "10");
    assert.equal((await store.getSlackWorkspaceByTeamId("TA"))?.enabled, true);
    assert.deepEqual(lifecycleWarnings.at(-1), { category: "slack_lifecycle_cleanup_failed", teamId: "TA", errorCode: "53300" });
    assert.doesNotMatch(failedCleanup.body, /private-database-diagnostic/);
  } finally { store.deleteSlackWorkspace = deleteSlackWorkspace; }
  // Reprovisioning while the old token's auth.test is in flight is fenced by
  // randomized ciphertext, even when Slack reuses the bot user ID.
  let checkingOld = false;
  let releaseIdentity!: () => void;
  const identityWait = new Promise<void>((resolve) => { releaseIdentity = resolve; });
  identityHook = async () => { checkingOld = true; await identityWait; };
  revokedTokens.add("token-A");
  const pendingUninstall = event("TA", "app_uninstalled");
  await waitFor(async () => checkingOld);
  const replacementCiphertext = encryptSlackToken({ token: "replacement-A", teamId: "TA", key: encryptionKey });
  await db.query("update slack_workspaces set bot_token_ciphertext=$1 where team_id='TA'", [replacementCiphertext]);
  releaseIdentity();
  assert.equal((await pendingUninstall).statusCode, 200);
  identityHook = undefined;
  assert.equal((await store.getSlackWorkspaceByTeamId("TA"))?.botTokenCiphertext, replacementCiphertext);
  assert.equal((await event("TA", "tokens_revoked")).statusCode, 200);
  assert.equal((await store.getSlackWorkspaceByTeamId("TA"))?.enabled, true);
  revokedTokens.add("replacement-A");

  // Lifecycle events are signed, target one team, and remove pre-FK settings.
  await store.setSelectedChannelApprovers({ teamId: "TA", expectedChannelId: "CA", approvers: ["U1"], updatedBy: "U1" });
  const unsigned = await app.inject({ method: "POST", url: "/api/slack/events", payload: { type: "event_callback", team_id: "TA", event: { type: "app_uninstalled" } } });
  assert.equal(unsigned.statusCode, 401);
  await event("TA", "tokens_revoked");
  await event("TA", "app_uninstalled");
  await event("TA", "tokens_revoked");
  assert.equal(await store.getSlackWorkspaceByTeamId("TA"), null);
  assert.equal((await db.query("select enabled from tenants where id=$1", [tenants.A])).rows[0].enabled, false);
  assert.equal((await db.query("select count(*) from channel_settings where team_id='TA'")).rows[0].count, "0");
  assert.ok(await store.getCycle(a.cycleId));
  assert.equal((await store.getSlackWorkspaceByTeamId("TB"))?.enabled, true);
  assert.equal((await start("A")).statusCode, 403);
  const command = new URLSearchParams({ team_id: "TA", channel_id: "CA", user_id: "U1", response_url: "https://hooks.slack.com/test", text: "status" }).toString();
  const callsBeforeDeletedCommand = clientConstructions;
  await app.inject({ method: "POST", url: "/api/slack/commands", headers: { ...signed(command), "content-type": "application/x-www-form-urlencoded" }, payload: command });
  await waitFor(async () => ephemeral.some((text) => text.includes("not enabled")));
  assert.match(ephemeral.at(-1)!, /not enabled/);
  assert.equal(clientConstructions, callsBeforeDeletedCommand);
  revokedTokens.add("token-D");
  await event("TD", "app_uninstalled");
  assert.equal(await store.getSlackWorkspaceByTeamId("TD"), null, "disabled tenants still receive lifecycle cleanup");
  const deletedDuringRoute = (await start("B", 12)).json();
  await db.query("update slack_workspaces set selected_channel_id=null where team_id='TB'");
  membershipHook = async () => {
    membershipHook = undefined;
    const workspace = (await store.getSlackWorkspaceByTeamId("TB"))!;
    await store.deleteSlackWorkspace("TB", workspace.botTokenCiphertext);
  };
  const raced = await result(deletedDuringRoute.cycleId, deletedDuringRoute.attemptId, "B", "video");
  assert.equal(raced.statusCode, 422);
  assert.equal(raced.json().settled, true);
  assert.equal(raced.json().error, "slack_unavailable");
  assert.equal((await store.getCycle(deletedDuringRoute.cycleId))?.status, "failed");
  console.log("HTTP multitenancy selftest passed");
} finally {
  await app.close(); await store.close(); await db.end();
  await maintenance.query(`drop database ${name} with (force)`); await maintenance.end();
}
