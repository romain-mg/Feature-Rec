import assert from "node:assert/strict";
import { resolveChannel } from "../src/channels";
import { SlackApiError, SlackClient, isRevokedSlackToken, respondEphemeral } from "../src/slack";
import { SlackResolver } from "../src/slack-resolver";
import { encryptSlackToken } from "../src/slack-token-crypto";
import type { CycleRecord, SlackWorkspace } from "../src/storage";

const key = Buffer.alloc(32, 7);
const workspaces = new Map<string, SlackWorkspace>();
function install(teamId: string, token: string, enabled = true): void {
  workspaces.set(teamId, {
    teamId,
    tenantId: `tenant-${teamId}`,
    enabled,
    botUserId: `bot-${teamId}`,
    botTokenCiphertext: encryptSlackToken({ token, teamId, key }),
    selectedChannelId: null,
  });
}
install("TA", "token-A");
install("TB", "token-B");
install("TD", "token-disabled", false);
const createdTokens: string[] = [];
const store = {
  getSlackWorkspaceByTeamId: async (teamId: string) => workspaces.get(teamId) ?? null,
  getSlackWorkspaceByTenantId: async (tenantId: string) =>
    [...workspaces.values()].find((workspace) => workspace.tenantId === tenantId) ?? null,
  getSelectedChannelId: async (teamId: string) => workspaces.get(teamId)?.selectedChannelId ?? null,
  initializeTeamChannelRoute: async ({ teamId, channelId }: { teamId: string; channelId: string }) => {
    const workspace = workspaces.get(teamId)!;
    if (workspace.selectedChannelId) return { initializedRoute: false };
    workspace.selectedChannelId = channelId;
    return { initializedRoute: true };
  },
};
const resolver = new SlackResolver(store, key, (token) => {
  createdTokens.push(token);
  return new SlackClient(token);
});

// Lookups for missing or disabled workspaces never construct a client. The
// metadata lookup can filter a non-bot member join even with corrupt ciphertext.
assert.equal(await resolver.forTeam("missing"), null);
assert.equal(await resolver.forTenant("tenant-missing"), null);
assert.equal(await resolver.forTeam("TD"), null);
assert.equal(await resolver.forTenant("tenant-TD"), null);
const workspaceA = workspaces.get("TA")!;
const validCiphertext = workspaceA.botTokenCiphertext;
workspaceA.botTokenCiphertext = "corrupt-never-log-this";
assert.equal((await resolver.workspaceForTeam("TA"))?.botUserId, "bot-TA");
assert.deepEqual(createdTokens, []);
await assert.rejects(resolver.forTeam("TA"), (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.match(error.message, /tenant-TA, workspace TA/);
  assert.doesNotMatch(error.message, /corrupt-never-log-this/);
  return true;
});
workspaceA.botTokenCiphertext = validCiphertext;

// A team-bound envelope cannot be replayed in another workspace.
const workspaceB = workspaces.get("TB")!;
const validCiphertextB = workspaceB.botTokenCiphertext;
workspaceB.botTokenCiphertext = validCiphertext;
await assert.rejects(resolver.forTeam("TB"), /tenant-TB, workspace TB/);
workspaceB.botTokenCiphertext = validCiphertextB;
await assert.rejects(new SlackResolver(store, null).forTeam("TA"), /token unavailable/);

type Call = { url: URL; authorization: string | null; body: Record<string, unknown> };
const calls: Call[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const authorization = new Headers(init?.headers).get("Authorization");
  const body = typeof init?.body === "string"
    ? JSON.parse(init.body) as Record<string, unknown>
    : {};
  calls.push({ url, authorization, body });
  if (url.hostname !== "slack.com") return new Response("ok");
  assert.notEqual(url.pathname, "/api/auth.test", "Runtime Slack operations must use stored identity");
  const suffix = authorization === "Bearer token-A" ? "A" : "B";
  return Response.json({
    ok: true,
    channels: [{ id: `C${suffix}` }],
    members: [`U${suffix}`],
    usergroups: [{ id: `S${suffix}`, handle: `group-${suffix}` }],
    users: [`U${suffix}`],
    channel: `C${suffix}`,
    ts: "123.456",
    upload_url: `https://uploads.example.test/${suffix}`,
    file_id: `F${suffix}`,
  });
};

try {
  for (const suffix of ["A", "B"]) {
    const resolved = await resolver.forTenant(`tenant-T${suffix}`);
    assert.ok(resolved);
    const { workspace, client } = resolved;
    const start = calls.length;
    assert.deepEqual(await resolveChannel(store, client, workspace.teamId), {
      teamId: `T${suffix}`,
      channelId: `C${suffix}`,
      initializedRoute: true,
    });
    assert.equal((await resolveChannel(store, client, workspace.teamId)).initializedRoute, false);
    const cycle = {
      id: `cycle-${suffix}`,
      prNumber: 42,
      headSha: "abcdef0123456789",
      prTitle: "Fresh GitHub title",
      slackChannelId: `C${suffix}`,
      slackMessageTs: "123.456",
    } as CycleRecord;
    assert.deepEqual(await client.listChannelMembers(`C${suffix}`), [`U${suffix}`]);
    assert.equal((await client.listUsergroups())[0].id, `S${suffix}`);
    assert.equal(await client.isApprover([`S${suffix}`], `U${suffix}`), true);
    await client.postMessage(`C${suffix}`, "hello");
    await client.uploadVideo(cycle, `C${suffix}`, Buffer.from("video"), `current/repo-${suffix}`);
    await client.postValidation(cycle, `C${suffix}`, null, `current/repo-${suffix}`);
    await client.openRequestChangesModal("trigger", cycle, undefined);
    // The cycle intentionally has no legacy owner/repo fields or GitHub client.
    await client.finalize(cycle, "superseded", "A newer head is ready.");
    for (const call of calls.slice(start).filter((call) => call.url.hostname === "slack.com")) {
      assert.equal(call.authorization, `Bearer token-${suffix}`);
    }
    const uploaded = calls.slice(start).find((call) => call.url.pathname.endsWith("files.completeUploadExternal"))!;
    assert.equal(uploaded.body.initial_comment, `Feature-Rec video for current/repo-${suffix}#42`);
    const validation = calls.slice(start).find((call) => call.body.blocks && call.url.pathname.endsWith("chat.postMessage"))!;
    assert.equal(validation.body.text, `Feature-Rec validation needed for current/repo-${suffix}#42`);
    const finalized = calls.at(-1)!;
    assert.equal(finalized.body.text, "Feature-Rec superseded for PR #42");
    assert.equal(JSON.stringify(finalized.body.blocks).includes('"actions"'), false);
    await client.finalize(cycle, "failed", "Video delivery failed. Rerun the workflow.");
    const failedMessage = calls.at(-1)!;
    assert.equal(failedMessage.body.text, "Feature-Rec failed for PR #42");
    assert.equal(failedMessage.authorization, `Bearer token-${suffix}`);
    assert.equal(JSON.stringify(failedMessage.body.blocks).includes('"actions"'), false);
  }
  assert.equal(workspaces.get("TA")?.selectedChannelId, "CA");
  assert.equal(workspaces.get("TB")?.selectedChannelId, "CB");

  // Reinstallation is visible on the next operation, with no persistent client
  // cache retaining the previous plaintext token.
  install("TA", "token-A-reinstalled");
  const reinstalled = await resolver.forTeam("TA");
  assert.ok(reinstalled);
  await reinstalled.client.postMessage("CA", "new installation");
  assert.equal(calls.at(-1)?.authorization, "Bearer token-A-reinstalled");
  assert.equal(createdTokens.at(-1), "token-A-reinstalled");

  await respondEphemeral("https://hooks.example.test/signed-response", "Unknown workspace");
  assert.equal(calls.at(-1)?.authorization, null);
  assert.deepEqual(calls.at(-1)?.body, {
    response_type: "ephemeral",
    replace_original: false,
    text: "Unknown workspace",
  });
} finally {
  globalThis.fetch = originalFetch;
}

// Exercise the real upload client: both Web API steps preserve Slack's error
// codes, while the raw upload endpoint only establishes an HTTP failure.
try {
  const cycle = { prNumber: 42, headSha: "abcdef0123456789" } as CycleRecord;
  const client = new SlackClient("upload-token");
  for (const failingMethod of ["files.getUploadURLExternal", "files.completeUploadExternal"]) {
    const uploadCalls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      uploadCalls.push(url.pathname);
      if (url.hostname !== "slack.com") {
        assert.equal(new Headers(init?.headers).get("Authorization"), null);
        return new Response("OK - 5");
      }
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer upload-token");
      if (url.pathname === `/api/${failingMethod}`) {
        return Response.json({ ok: false, error: "token_revoked" });
      }
      return Response.json({ ok: true, upload_url: "https://uploads.example.test/video", file_id: "F1" });
    };
    await assert.rejects(client.uploadVideo(cycle, "CA", Buffer.from("video"), "owner/repo"), (error: unknown) => {
      assert.ok(error instanceof SlackApiError);
      assert.equal(error.code, "token_revoked");
      assert.equal(isRevokedSlackToken(error), true);
      return true;
    });
    assert.deepEqual(uploadCalls, failingMethod === "files.getUploadURLExternal"
      ? ["/api/files.getUploadURLExternal"]
      : ["/api/files.getUploadURLExternal", "/video", "/api/files.completeUploadExternal"]);
  }

  const uploadCalls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    uploadCalls.push(url.pathname);
    return url.hostname === "slack.com"
      ? Response.json({ ok: true, upload_url: "https://uploads.example.test/video", file_id: "F1" })
      : new Response("token_revoked", { status: 403 });
  };
  await assert.rejects(client.uploadVideo(cycle, "CA", Buffer.from("video"), "owner/repo"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Slack file upload failed: 403/);
    assert.equal(isRevokedSlackToken(error), false);
    return true;
  });
  assert.deepEqual(uploadCalls, ["/api/files.getUploadURLExternal", "/video"]);
} finally {
  globalThis.fetch = originalFetch;
}

// Lifecycle verification must fail closed when Slack cannot establish the
// stored identity, including invalid_auth from an IP allowlist rejection.
try {
  const workspace = workspaces.get("TA")!;
  let authCalls = 0;
  let authResponse: Record<string, unknown>;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.pathname, "/api/auth.test");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer token-A-reinstalled");
    authCalls += 1;
    return Response.json(authResponse);
  };
  const unverifiable = (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Cannot verify Slack token for workspace TA");
    assert.equal(error.cause, undefined);
    return true;
  };
  for (const identity of [
    { team_id: "TB", user_id: workspace.botUserId },
    { team_id: workspace.teamId, user_id: "wrong-bot" },
  ]) {
    authResponse = { ok: true, ...identity };
    await assert.rejects(resolver.tokenIsRevoked(workspace), unverifiable);
  }
  for (const error of ["invalid_auth", "ratelimited", "service_unavailable"]) {
    authResponse = { ok: false, error, response_metadata: { messages: ["provider-detail-never-log-this"] } };
    await assert.rejects(resolver.tokenIsRevoked(workspace), unverifiable);
  }
  const callsBeforeCorruption = authCalls;
  await assert.rejects(resolver.tokenIsRevoked({ ...workspace, botTokenCiphertext: "corrupt-never-log-this" }), unverifiable);
  await assert.rejects(new SlackResolver(store, null).tokenIsRevoked(workspace), unverifiable);
  assert.equal(authCalls, callsBeforeCorruption, "Unreadable credentials must not reach Slack");

  authResponse = { ok: true, team_id: workspace.teamId, user_id: workspace.botUserId };
  assert.equal(await resolver.tokenIsRevoked(workspace), false);
  assert.equal(await resolver.tokenIsRevoked({ ...workspace, enabled: false }), false);
  for (const error of ["token_revoked", "account_inactive"]) {
    authResponse = { ok: false, error };
    assert.equal(await resolver.tokenIsRevoked(workspace), true);
    assert.equal(await resolver.tokenIsRevoked({ ...workspace, enabled: false }), true);
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Slack multitenancy selftest passed");
