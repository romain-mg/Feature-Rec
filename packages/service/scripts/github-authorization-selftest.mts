import assert from "node:assert/strict";
import crypto from "node:crypto";
import { GitHubAuthorizationError, GitHubClient, GitHubRequestError } from "../src/github";
import type { CycleRecord } from "../src/storage";

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const client = new GitHubClient({
  port: 0, baseUrl: "https://feature-rec.example", databaseUrl: "unused",
  githubAppId: "123", githubPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  slackOAuth: null,
  slackSigningSecret: "", slackTokenEncryptionKey: null,
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
});
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const now = 1_800_000_000_250;
const requests: Array<{ path: string; method: string; body: unknown; authorization: string | null }> = [];
let fullName = "Original/Repo";
let repositoryId = 101;
let ownerId = 601;
let repositories = 1;
let token: unknown = "a completely opaque token with no assumed prefix or length";
let expiresAt: unknown = new Date(now + 3_600_000).toISOString();
let failTokenStatus = 0;
let nullTokenResponse = false;
let commentFails = false;
let tokenFailureHeaders: Record<string, string> = {};
let tokenFailureBody = "provider credential details must stay private";
let patchFailures = 0;
const cycle: CycleRecord = {
  id: "cycle", tenantId: "tenant", repositoryId: "101", cycleKey: "tenant/101#9:headsha",
  owner: "Wrong", repo: "Legacy", prNumber: 9, headSha: "headsha", prAuthor: "author", prTitle: "Title",
  checkRunId: 55, status: "pending_validation", slackChannelId: "CA", slackMessageTs: "1.1", createdAt: "", updatedAt: "",
};
globalThis.fetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  requests.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init?.headers).get("authorization") });
  let body: unknown = {};
  if (path.endsWith("/access_tokens")) {
    if (nullTokenResponse) return Response.json(null);
    if (failTokenStatus) return new Response(tokenFailureBody, { status: failTokenStatus, headers: tokenFailureHeaders });
    body = { token, expires_at: expiresAt, repositories: Array.from({ length: repositories }, () => ({ id: repositoryId, full_name: fullName, owner: { id: ownerId } })) };
  } else if (path.endsWith("/pulls/9")) {
    body = { number: 9, state: "open", draft: false, title: "Authoritative GitHub title", user: { login: "verified-author" }, head: { sha: "verified-head" } };
  } else if (path.endsWith("/comments")) {
    if (commentFails) throw new Error("sensitive network detail");
    body = { html_url: "https://github.com/comment/1" };
  } else if (init?.method === "PATCH") {
    if (patchFailures-- > 0) return new Response("temporary", { status: 503 });
  } else if (path.endsWith("/check-runs")) body = { id: 55 };
  return Response.json(body);
};
Date.now = () => now;
try {
  const access = await client.authorizeRepository("501", "101");
  assert.deepEqual(requests[0].body, { repository_ids: [101] });
  assert.equal(access.token, token);
  assert.equal(access.expiresAt, now + 3_600_000);
  assert.equal(access.repositoryOwnerId, "601");
  assert.deepEqual(await client.getPullRequest(access, 9), { state: "open", draft: false, headSha: "verified-head", prTitle: "Authoritative GitHub title", prAuthor: "verified-author" });
  await client.createCheckRun(cycle, access);
  await client.updateCheckRun(cycle, { conclusion: "success", output: { title: "done", summary: "done" } }, access);
  assert.equal(requests.at(-1)?.path, "/repos/Original/Repo/check-runs/55");
  assert.equal(requests.at(-1)?.authorization, "Bearer " + String(token));

  fullName = "Original/Renamed";
  token = "replacement-opaque-value";
  expiresAt = new Date(now + 3_700_000).toISOString();
  const beforeRename = requests.length;
  const renamed = await client.authorizeRepository("501", "101");
  assert.equal(renamed.token, token, "the same installation and repository receive a freshly minted token");
  assert.notEqual(renamed.token, access.token);
  assert.equal(renamed.expiresAt, now + 3_700_000, "expiry metadata belongs to the freshly minted credential");
  assert.deepEqual(requests.slice(beforeRename).map(({ path, method, body }) => ({ path, method, body })), [
    { path: "/app/installations/501/access_tokens", method: "POST", body: { repository_ids: [101] } },
  ], "authorization resolves current coordinates through one scoped grant, without a metadata GET");
  await client.comment(cycle, "hello", renamed);
  assert.equal(requests.at(-1)?.path, "/repos/Original/Renamed/issues/9/comments");
  assert.equal(requests.at(-1)?.authorization, "Bearer " + String(token));
  ownerId = 602;
  fullName = "Transferred/Renamed";
  token = "transferred-repository-token";
  const transferred = await client.authorizeRepository("501", "101");
  assert.equal(transferred.repositoryOwnerId, "602", "callers see the current owner and can reject an old tenant");
  assert.equal(transferred.fullName, fullName);
  assert.equal(transferred.token, token);
  assert.equal(requests.filter((request) => request.path.endsWith("/access_tokens")).length, 3);

  await client.authorizeRepository("502", "101");
  assert.equal(requests.at(-1)?.path, "/app/installations/502/access_tokens");
  repositoryId = 102;
  await client.authorizeRepository("501", "102");
  assert.deepEqual(requests.at(-1)?.body, { repository_ids: [102] });

  for (const changed of [() => { repositoryId = 102; }, () => { repositories = 2; }, () => { repositories = 0; }, () => { fullName = "invalid/name/extra"; }, () => { ownerId = Number.MAX_SAFE_INTEGER + 1; }, () => { token = ""; }, () => { token = undefined; }, () => { token = 123; }]) {
    repositoryId = 101; repositories = 1; fullName = "Original/Repo"; ownerId = 601; token = "valid-opaque-token";
    changed();
    await assert.rejects(client.authorizeRepository("501", "101"), GitHubAuthorizationError);
  }
  repositoryId = 101; repositories = 1; fullName = "Original/Repo"; ownerId = 601; token = "valid-opaque-token";
  nullTokenResponse = true;
  await assert.rejects(client.authorizeRepository("501", "101"), (error: unknown) => error instanceof GitHubRequestError && error.retryable && error.cause === undefined);
  nullTokenResponse = false;

  for (const expiry of [undefined, null, 123, {}, "", "sensitive malformed expiry", new Date(now).toISOString(), new Date(now - 1).toISOString()]) {
    expiresAt = expiry;
    await assert.rejects(client.authorizeRepository("501", "101"), (error: unknown) => {
      assert.ok(error instanceof GitHubRequestError);
      assert.equal(error.status, null);
      assert.equal(error.retryable, true);
      assert.equal(error.cause, undefined);
      assert.ok(!String(error).includes("sensitive"));
      return true;
    });
  }
  expiresAt = new Date(now + 3_600_000).toISOString();
  assert.equal((await client.authorizeRepository("501", "101")).expiresAt, now + 3_600_000);

  const beforeUnsafe = requests.length;
  await assert.rejects(client.authorizeRepository("501", "9007199254740993"), GitHubAuthorizationError);
  await assert.rejects(client.authorizeRepository("501", "0101"), GitHubAuthorizationError);
  await assert.rejects(client.authorizeRepository("0501", "101"), GitHubAuthorizationError);
  assert.equal(requests.length, beforeUnsafe, "unsafe IDs never leave the process rounded");

  for (const status of [401, 403, 404, 422, 503]) {
    failTokenStatus = 0;
    token = "before-failure-" + status;
    await client.authorizeRepository("501", "101");
    failTokenStatus = status;
    const beforeFailure = requests.length;
    await assert.rejects(client.authorizeRepository("501", "101"), (error: unknown) => {
      if ([403, 404, 422].includes(status)) {
        assert.ok(error instanceof GitHubAuthorizationError);
      } else {
        assert.ok(error instanceof GitHubRequestError);
        assert.equal(error.status, status);
        assert.equal(error.retryable, status === 503);
      }
      assert.ok(!String(error).includes("credential"));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(requests.length - beforeFailure, 1, "a later grant failure cannot fall back to previous successful access");
    assert.equal(requests.at(-1)?.path, "/app/installations/501/access_tokens");
    failTokenStatus = 0;
    token = "after-recovery-" + status;
    const beforeRecovery = requests.length;
    assert.equal((await client.authorizeRepository("501", "101")).token, token, "recovery obtains a fresh credential");
    assert.equal(requests.length - beforeRecovery, 1);
    assert.equal(requests.at(-1)?.path, "/app/installations/501/access_tokens");
  }

  for (const { headers, seconds } of [
    { headers: { "retry-after": "60" }, seconds: 60 },
    { headers: { "retry-after": new Date(now + 60_000).toUTCString() }, seconds: 60 },
    { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(now / 1_000) + 60) }, seconds: 60 },
    { headers: { "retry-after": new Date(now - 60_000).toUTCString() }, seconds: 0 },
    { headers: { "retry-after": "invalid" }, seconds: null },
  ]) {
    failTokenStatus = 403;
    tokenFailureHeaders = headers;
    const beforeRateLimit = requests.length;
    await assert.rejects(client.authorizeRepository("501", "101"), (error: unknown) => {
      assert.ok(error instanceof GitHubRequestError);
      assert.equal(error.status, 403);
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterSeconds, seconds);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(requests.length - beforeRateLimit, 1, "rate limits fail without stale access fallback");
  }
  // Secondary limits can leave primary quota available and omit Retry-After.
  // They must remain retryable instead of becoming repository access denials.
  tokenFailureBody = JSON.stringify({ message: "You have exceeded a secondary rate limit. private-provider-detail" });
  for (const status of [403, 429]) {
    for (const { headers, seconds } of [
      { headers: { "x-ratelimit-remaining": "4999" }, seconds: 60 },
      { headers: {}, seconds: 60 },
      { headers: { "retry-after": "120" }, seconds: 120 },
      { headers: { "retry-after": "invalid" }, seconds: 60 },
      { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(now / 1_000) + 90) }, seconds: 90 },
    ]) {
      failTokenStatus = status;
      tokenFailureHeaders = headers;
      const beforeRateLimit = requests.length;
      await assert.rejects(client.authorizeRepository("501", "101"), (error: unknown) => {
        assert.ok(error instanceof GitHubRequestError);
        assert.equal(error.status, status);
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfterSeconds, seconds);
        assert.equal(error.cause, undefined);
        assert.ok(!String(error).includes("private-provider-detail"));
        return true;
      });
      assert.equal(requests.length - beforeRateLimit, 1, "secondary limits do not retry immediately or reuse old access");
    }
  }
  failTokenStatus = 403;
  tokenFailureHeaders = {};
  for (const body of ["private-provider-detail", "null", "42", JSON.stringify({ message: 42 }), JSON.stringify({ message: "Resource not accessible by integration. private-provider-detail" })]) {
    tokenFailureBody = body;
    await assert.rejects(client.authorizeRepository("501", "101"), (error: unknown) => {
      assert.ok(error instanceof GitHubAuthorizationError, "ordinary or malformed 403 responses remain access denials");
      assert.ok(!String(error).includes("private-provider-detail"));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  tokenFailureHeaders = {};
  failTokenStatus = 0;
  commentFails = true;
  const beforeComment = requests.length;
  await assert.rejects(client.accept(cycle, renamed), GitHubRequestError);
  assert.equal(requests.length - beforeComment, 1, "comment POST remains single-shot after network failure");
  commentFails = false;
  patchFailures = 2;
  const beforeAccept = requests.length;
  await client.accept(cycle, renamed);
  assert.equal(requests.length - beforeAccept, 4, "comment once, idempotent PATCH retried within its bound");
  assert.ok(!requests.some((request) => request.path === "/installation/repositories"), "no installation metadata lookup is needed");

  globalThis.fetch = async () => new Response("opaque-private-token-provider-body");
  await assert.rejects(client.authorizeRepository("501", "101"), (error: unknown) => {
    assert.ok(error instanceof GitHubRequestError && error.retryable);
    assert.ok(!String(error).includes("opaque-private-token-provider-body"));
    assert.equal(error.cause, undefined);
    return true;
  });
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}
console.log("GitHub repository authorization selftest passed");
