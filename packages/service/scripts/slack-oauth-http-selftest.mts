import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Writable } from "node:stream";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { InstallProvider } from "@slack/oauth";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Client, Pool } from "pg";
import { provisionTenant, type AdminProviders } from "../src/admin-operations";
import { readEnv } from "../src/env";
import { buildServer } from "../src/http";
import { SlackClient } from "../src/slack";
import { SlackResolver } from "../src/slack-resolver";
import { decryptSlackToken, encryptSlackToken } from "../src/slack-token-crypto";
import { PostgresCycleStore } from "../src/storage/postgres";
import type { DB } from "../src/storage/schema";
import { cleanupSlackOAuthInstallations, readPendingSlackOAuthInstallation } from "../src/storage/slack-oauth";

const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const dbName = `feature_rec_oauth_http_test_${crypto.randomBytes(8).toString("hex")}`;
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${dbName}`;
const testUrl = databaseUrl.toString();
const connect = (applicationName = "feature-rec-oauth-http-selftest") => new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: testUrl, application_name: applicationName }) }) });
const db = connect();
const replicaDb = connect();
const store = new PostgresCycleStore(testUrl);
const key = Buffer.alloc(32, 37);
const env = readEnv({
  DATABASE_URL: testUrl,
  FEATURE_REC_BASE_URL: "https://feature-rec.example",
  FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY: key.toString("base64"),
  SLACK_SIGNING_SECRET: "fixture-oauth-http-signing-secret",
  SLACK_APP_ID: "AHTTP123",
  SLACK_CLIENT_ID: "123456.789012",
  SLACK_CLIENT_SECRET: "fixture-oauth-http-client-secret",
});
assert.ok(env.slackOAuth);
const config = env.slackOAuth;
const scopes = ["chat:write", "files:write", "usergroups:read", "channels:read", "groups:read", "commands"];
const marker = "sensitive-provider-fixture-DO-NOT-LOG";
const secrets = new Set([config.clientSecret, key.toString("base64"), marker]);
const logs: string[] = [];
const stream = new Writable({ write(chunk: Buffer, _encoding, callback) { logs.push(chunk.toString()); callback(); } });
const apps: Array<ReturnType<typeof buildServer>> = [];
function app(database = db, encryptionKey: Buffer | null = key, enabled = true) {
  const instance = buildServer({
    env: { ...env, slackTokenEncryptionKey: encryptionKey, slackOAuth: enabled ? env.slackOAuth : null }, store,
    slackOAuthDb: database, logger: { level: "trace", stream },
  });
  apps.push(instance);
  return instance;
}
type App = ReturnType<typeof app>;
type HttpResponse = Awaited<ReturnType<App["inject"]>>;
const raw = (id: string) => db.selectFrom("slack_oauth_installations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const sessionCount = async () => (await db.selectFrom("slack_oauth_installations").select("id").execute()).length;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
type Fixture = {
  code: string;
  teamId: string;
  botUserId: string;
  token: string;
  response: Record<string, unknown>;
  identity: Record<string, unknown>;
  mode?: "network" | "transient" | "rate-limit";
  gate?: ReturnType<typeof deferred>;
  entered?: ReturnType<typeof deferred>;
};
const fixtures = new Map<string, Fixture>();
const tokenFixtures = new Map<string, Fixture>();
const exchanges = new Map<string, number>();
const identityReads = new Map<string, number>();
const providerErrors: unknown[] = [];
function fixture(teamId: string, mutate?: (value: Fixture) => void): Fixture {
  const id = crypto.randomBytes(8).toString("hex");
  const value: Fixture = {
    code: `fixture-code-${id}`, teamId, botUserId: `U${teamId}`, token: `xoxb-fixture-${id}`,
    response: {}, identity: { ok: true, bot_id: `B${teamId}`, user_id: `U${teamId}`, team_id: teamId },
  };
  value.response = {
    ok: true, app_id: config.appId, access_token: value.token, token_type: "bot",
    bot_user_id: value.botUserId, team: { id: teamId, name: `<script>${marker}</script>` },
    enterprise: null, is_enterprise_install: false, authed_user: { id: "UINSTALLER" },
    scope: scopes.join(","),
  };
  mutate?.(value);
  fixtures.set(value.code, value);
  tokenFixtures.set(value.token, value);
  secrets.add(value.code);
  secrets.add(value.token);
  return value;
}
async function providerRequest(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  const body = Buffer.concat(chunks).toString();
  const form = new URLSearchParams(body);
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/oauth.v2.access") {
    const code = form.get("code") ?? "";
    const value = fixtures.get(code);
    assert.ok(value, "No unexpected authorization code may reach Slack");
    exchanges.set(code, (exchanges.get(code) ?? 0) + 1);
    assert.equal(form.get("client_id"), config.clientId);
    assert.equal(form.get("client_secret"), config.clientSecret);
    assert.equal(form.get("redirect_uri"), config.redirectUri);
    value.entered?.resolve();
    if (value.gate) await value.gate.promise;
    if (value.mode === "network") { response.destroy(); return; }
    if (value.mode === "transient") { response.statusCode = 503; response.end(marker); return; }
    if (value.mode === "rate-limit") {
      response.statusCode = 429; response.setHeader("retry-after", "1"); response.end(marker); return;
    }
    response.end(JSON.stringify(value.response));
    return;
  }
  assert.equal(request.url, "/api/auth.test");
  const token = request.headers.authorization?.replace(/^Bearer /, "") ?? form.get("token") ?? "";
  const value = tokenFixtures.get(token);
  assert.ok(value, "Only a token returned by the fake exchange may reach auth.test");
  identityReads.set(token, (identityReads.get(token) ?? 0) + 1);
  response.end(JSON.stringify(value.identity));
}
const provider = createServer((request, response) => {
  void providerRequest(request, response).catch((error: unknown) => {
    providerErrors.push(error); response.statusCode = 500; response.end("fixture-provider-failed");
  });
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  // Both the actual SDK and SlackClient keep their production URL/transport
  // behavior; only the network destination changes to a local fake server.
  const request = new Request(input, init);
  const target = new URL(request.url);
  assert.equal(target.origin, "https://slack.com", "Selftests never call a live provider");
  assert.ok(["/api/oauth.v2.access", "/api/auth.test"].includes(target.pathname));
  return originalFetch(new Request(`${providerOrigin}${target.pathname}`, request));
};

function cookieHeaders(response: HttpResponse): string[] {
  const header = response.headers["set-cookie"];
  return Array.isArray(header) ? header : header ? [String(header)] : [];
}
function safeResponse(response: HttpResponse, deletion = false) {
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  if (deletion) {
    const cookies = cookieHeaders(response);
    assert.equal(cookies.length, 2, "Every callback preserves both cookie-deletion headers");
    for (const cookie of cookies) {
      assert.match(cookie, /; Secure(?:;|$)/i);
      assert.match(cookie, /; HttpOnly(?:;|$)/i);
      assert.match(cookie, /; SameSite=Lax(?:;|$)/i);
      assert.match(cookie, /(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
    }
  }
  for (const secret of secrets) assert.equal(response.body.includes(secret), false, "Completion/failure output contains no secrets");
  assert.equal(response.body.includes("<script>"), false);
}
async function start(server: App, url = "/api/slack/oauth/start") {
  const response = await server.inject({ method: "GET", url });
  assert.equal(response.statusCode, 302);
  safeResponse(response);
  const location = new URL(String(response.headers.location));
  assert.equal(location.origin, "https://slack.com");
  assert.equal(location.pathname, "/oauth/v2/authorize");
  assert.equal(location.searchParams.get("client_id"), config.clientId);
  assert.equal(location.searchParams.get("redirect_uri"), config.redirectUri);
  assert.deepEqual(location.searchParams.get("scope")?.split(",").sort(), [...scopes].sort());
  assert.equal(location.searchParams.has("user_scope"), false);
  assert.equal(location.searchParams.has("team"), false);
  const state = location.searchParams.get("state");
  assert.match(state ?? "", /^[A-Za-z0-9_-]{43}$/);
  const cookies = cookieHeaders(response);
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) {
    assert.match(cookie, /; Secure(?:;|$)/i);
    assert.match(cookie, /; HttpOnly(?:;|$)/i);
    assert.match(cookie, /; SameSite=Lax(?:;|$)/i);
    assert.match(cookie, /; Max-Age=600(?:;|$)/i);
    assert.equal(cookie.includes("Domain="), false);
  }
  const stateCookie = cookies.find((cookie) => cookie.startsWith("slack-app-oauth-state="));
  assert.ok(stateCookie);
  assert.equal(stateCookie.split(";")[0].split("=")[1], state);
  const bindingCookie = cookies.find((cookie) => cookie !== stateCookie)!;
  const binding = bindingCookie.split(";")[0].split("=")[1];
  assert.match(binding, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state, binding);
  const row = await db.selectFrom("slack_oauth_installations").selectAll()
    .where("state_hash", "=", crypto.createHash("sha256").update(state!).digest("hex")).executeTakeFirstOrThrow();
  assert.equal(row.status, "awaiting_callback");
  assert.equal(row.browser_binding_hash, crypto.createHash("sha256").update(binding).digest("hex"));
  assert.equal(JSON.stringify(row).includes(binding), false);
  assert.equal(JSON.stringify(row).includes(state!), false);
  assert.ok(row.expires_at && row.expires_at.getTime() > Date.now() + 590_000);
  secrets.add(state!); secrets.add(binding);
  return { id: row.id, state: state!, cookies, cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "), bindingCookie };
}
type Session = Awaited<ReturnType<typeof start>>;
function callback(server: App, session: Session, value: Fixture, cookie = session.cookie, suffix = "") {
  return server.inject({ method: "GET", url: `/api/slack/oauth/callback?${new URLSearchParams({ state: session.state, code: value.code })}${suffix}`, headers: { cookie } });
}
async function failed(response: HttpResponse, id?: string) {
  assert.ok(response.statusCode >= 400, `Expected callback failure; got ${response.statusCode}`);
  safeResponse(response, true);
  if (id) assert.notEqual((await raw(id)).status, "pending");
}

try {
  await store.init();
  const primary = app();
  let replica = app(replicaDb);
  const beforeHealth = exchanges.size;
  assert.equal((await primary.inject({ method: "GET", url: "/health" })).statusCode, 200);
  assert.equal(exchanges.size, beforeHealth);

  // The SDK can fail after creating state and setting both cookies. Replacing
  // those headers on failure must delete the original browser-binding cookie,
  // rather than retaining it through an earlier response-header adapter.
  const failingStartApp = app();
  const beforeFailingStart = await sessionCount();
  const installUrlMock = mock.method(InstallProvider.prototype, "generateInstallUrl", async () => {
    assert.equal(await sessionCount(), beforeFailingStart + 1, "The regression fails only after state has been persisted");
    throw new Error(marker);
  });
  try {
    const response = await failingStartApp.inject({ method: "GET", url: "/api/slack/oauth/start" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers.location, undefined);
    safeResponse(response, true);
    const bindingDeletion = cookieHeaders(response).find((cookie) => cookie.startsWith("feature-rec-slack-oauth-bind="));
    assert.ok(bindingDeletion);
    assert.match(bindingDeletion, /; Max-Age=0(?:;|$)/i);
    assert.equal(exchanges.size, beforeHealth);
  } finally { installUrlMock.mock.restore(); }
  await start(failingStartApp);

  // Keep three independent exchanges in flight on the same app, completing in
  // reverse order so shared claim/identity fields would cross-wire installations.
  const accepted: Array<{ session: Session; fixture: Fixture }> = [];
  for (const teamId of ["TALPHA", "TBETA", "TGAMMA"]) {
    accepted.push({ session: await start(primary), fixture: fixture(teamId, (value) => {
      value.gate = deferred(); value.entered = deferred();
    }) });
  }
  const pendingCallbacks = accepted.map(({ session, fixture: value }) => callback(replica, session, value));
  const settledCallbacks = Promise.allSettled(pendingCallbacks);
  let entryDeadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(accepted.map(({ fixture: value }) => value.entered!.promise)),
      new Promise<never>((_resolve, reject) => {
        entryDeadline = setTimeout(() => { reject(new Error("Independent OAuth exchanges did not all enter")); }, 5_000);
      }),
    ]);
    clearTimeout(entryDeadline);
    for (const [index, { session, fixture: value }] of [...accepted.entries()].reverse()) {
      value.gate!.resolve();
      const response = await pendingCallbacks[index];
      assert.equal(response.statusCode, 200);
      safeResponse(response, true);
      assert.ok(response.body.includes(session.id));
      assert.ok(response.body.includes(value.teamId));
      assert.match(response.body, /activation|provision/i);
      const row = await raw(session.id);
      assert.equal(row.status, "pending");
      assert.equal(row.expires_at, null);
      assert.equal(row.state_hash, null); assert.equal(row.browser_binding_hash, null); assert.equal(row.claim_id, null);
      assert.equal(row.team_id, value.teamId); assert.equal(row.bot_user_id, value.botUserId);
      assert.equal(decryptSlackToken({ envelope: row.bot_token_ciphertext!, teamId: value.teamId, key }), value.token);
      assert.equal(JSON.stringify(row).includes(value.token), false);
      secrets.add(row.bot_token_ciphertext!);
      assert.equal(exchanges.get(value.code), 1);
      assert.equal(identityReads.get(value.token), 2, "SDK auth.test plus application identity cross-check both run");
    }
  } finally {
    clearTimeout(entryDeadline);
    for (const { fixture: value } of accepted) value.gate!.resolve();
    await settledCallbacks;
  }
  assert.equal(new Set(accepted.map(({ session }) => session.state)).size, 3);
  assert.deepEqual(await db.selectFrom("tenants").selectAll().execute(), []);
  assert.deepEqual(await db.selectFrom("github_installations").selectAll().execute(), []);
  assert.deepEqual(await db.selectFrom("slack_workspaces").selectAll().execute(), []);
  let runtimeClients = 0;
  const resolver = new SlackResolver(store, key, (token) => { runtimeClients++; return new SlackClient(token); });
  for (const { fixture: value } of accepted) assert.equal(await resolver.forTeam(value.teamId), null);
  assert.equal(runtimeClients, 0);
  await db.updateTable("slack_oauth_installations").set({ created_at: sql`clock_timestamp() - interval '2 years'` })
    .where("id", "=", accepted[0].session.id).execute();
  await cleanupSlackOAuthInstallations(db);
  assert.ok(await readPendingSlackOAuthInstallation(db, accepted[0].session.id, key), "Pending installations never expire locally");

  // A new process/connection can complete a session created by another replica.
  const restart = await start(primary);
  await replica.close();
  replica = app(replicaDb);
  assert.equal((await callback(replica, restart, fixture("TRESTART"))).statusCode, 200);

  // Hold the first provider request until a duplicate reaches another replica:
  // the database claim must already be durable before any exchange can happen.
  const concurrent = await start(primary);
  const concurrentFixture = fixture("TCONCURRENT", (value) => { value.gate = deferred(); value.entered = deferred(); });
  const inflight = callback(primary, concurrent, concurrentFixture);
  try {
    await concurrentFixture.entered!.promise;
    assert.equal((await raw(concurrent.id)).status, "exchanging");
    await failed(await callback(replica, concurrent, concurrentFixture), concurrent.id);
    assert.equal(exchanges.get(concurrentFixture.code), 1);
  } finally { concurrentFixture.gate!.resolve(); }
  assert.equal((await inflight).statusCode, 200);
  await failed(await callback(replica, concurrent, concurrentFixture));
  assert.equal(exchanges.get(concurrentFixture.code), 1);

  // Supplying a copied callback URL and a forged state cookie is insufficient:
  // the independent browser secret must match before the SDK can claim state.
  const browser = await start(primary);
  const differentBrowser = await start(primary);
  const browserValue = fixture("TBROWSER");
  const pristine = await raw(browser.id);
  for (const cookie of ["", `slack-app-oauth-state=${browser.state}`, `slack-app-oauth-state=${browser.state}; ${differentBrowser.bindingCookie.split(";")[0]}`, `${browser.bindingCookie.split(";")[0]}; slack-app-oauth-state=${differentBrowser.state}`]) {
    await failed(await callback(replica, browser, browserValue, cookie), browser.id);
    assert.deepEqual(await raw(browser.id), pristine);
  }
  assert.equal(exchanges.has(browserValue.code), false);
  assert.equal((await callback(replica, browser, browserValue)).statusCode, 200);

  const expired = await start(primary);
  const expiredValue = fixture("TEXPIRED");
  await db.updateTable("slack_oauth_installations").set({ expires_at: sql`clock_timestamp() - interval '1 second'` }).where("id", "=", expired.id).execute();
  await failed(await callback(replica, expired, expiredValue), expired.id);
  assert.equal(exchanges.has(expiredValue.code), false);

  const queryApp = app();
  const query = await start(queryApp);
  const queryValue = fixture("TQUERY");
  for (const suffix of ["&state=duplicate", "&code=duplicate", `&error=${marker}`]) {
    await failed(await callback(queryApp, query, queryValue, query.cookie, suffix), query.id);
  }
  for (const queryString of ["", `?state=${query.state}`, `?code=${queryValue.code}`, `?state=${query.state}&error=access_denied`]) {
    await failed(await queryApp.inject({ method: "GET", url: `/api/slack/oauth/callback${queryString}`, headers: { cookie: query.cookie } }), query.id);
  }
  assert.equal(exchanges.has(queryValue.code), false);
  // Untrusted hints may be ignored, but can never override our fixed redirect,
  // scopes, database association or the identity returned by Slack.
  for (const queryString of ["?team=TATTACKER", "?tenantId=attacker", "?metadata=attacker", `?redirect_uri=${marker}`]) {
    await start(queryApp, `/api/slack/oauth/start${queryString}`);
  }
  const untrusted = await start(queryApp);
  const untrustedValue = fixture("TVERIFIED");
  const untrustedResponse = await callback(queryApp, untrusted, untrustedValue, untrusted.cookie,
    "&tenantId=attacker&team=TATTACKER&metadata=attacker&redirect_uri=https%3A%2F%2Fattacker.example");
  assert.equal(untrustedResponse.statusCode, 200);
  safeResponse(untrustedResponse, true);
  assert.equal((await raw(untrusted.id)).team_id, "TVERIFIED");
  assert.equal((await raw(untrusted.id)).consumed_tenant_id, null);
  assert.equal(untrustedResponse.body.includes("TATTACKER"), false);

  // Exercise what the supported SDK actually exposes after normalization.
  const invalidApp = app();
  const invalidCases: Array<[string, (value: Fixture) => void]> = [
    ["app ID", (value) => { value.response.app_id = "AOTHER"; }],
    ["workspace ID", (value) => { value.response.team = { id: "Tinvalid", name: marker }; }],
    ["missing workspace", (value) => { value.response.team = null; }],
    ["bot user ID", (value) => { value.response.bot_user_id = "not-a-bot-user"; }],
    ["missing bot token", (value) => { delete value.response.access_token; }],
    ["token type", (value) => { value.response.token_type = "user"; }],
    ["missing required scope", (value) => { value.response.scope = scopes.slice(1).join(","); }],
    ["user token", (value) => { value.response.authed_user = { id: "UINSTALLER", access_token: marker, scope: "identity.basic" }; }],
    ["rotation", (value) => { value.response.refresh_token = marker; value.response.expires_in = 3600; }],
    ["enterprise installation", (value) => { value.response.is_enterprise_install = true; value.response.enterprise = { id: "EGRID" }; }],
    ["wrong live workspace", (value) => { value.identity.team_id = "TOTHER"; }],
    ["wrong live bot user", (value) => { value.identity.user_id = "UOTHER"; }],
    ["provider error", (value) => { value.response = { ok: false, error: marker, response_metadata: { messages: [marker] } }; }],
    ["identity provider error", (value) => { value.identity = { ok: false, error: marker, response_metadata: { messages: [marker] } }; }],
  ];
  for (const [label, mutate] of invalidCases) {
    const session = await start(invalidApp);
    const value = fixture("TINVALID", mutate);
    await failed(await callback(invalidApp, session, value), session.id);
    assert.equal((await raw(session.id)).bot_token_ciphertext, null, label);
    assert.equal(exchanges.get(value.code), 1, label);
  }

  // Ambiguous exchanges cannot be replayed, even after another app takes over.
  for (const mode of ["network", "transient", "rate-limit"] as const) {
    const session = await start(invalidApp);
    const value = fixture("TNETWORK", (current) => { current.mode = mode; });
    await failed(await callback(invalidApp, session, value), session.id);
    assert.equal(exchanges.get(value.code), 1);
    assert.equal(identityReads.has(value.token), false);
    const recovery = app(replicaDb);
    await failed(await callback(recovery, session, value), session.id);
    assert.equal(exchanges.get(value.code), 1, `${mode} exchange never automatically retries`);
    await recovery.close();
  }

  // Session expiry during the exchange must prevent a late provider response
  // from staging a token or extending the original ten-minute authorization.
  const late = await start(invalidApp);
  const lateValue = fixture("TLATE", (value) => { value.gate = deferred(); value.entered = deferred(); });
  const lateResponse = callback(invalidApp, late, lateValue);
  try {
    await lateValue.entered!.promise;
    await db.updateTable("slack_oauth_installations").set({ expires_at: sql`clock_timestamp() - interval '1 second'` }).where("id", "=", late.id).execute();
  } finally { lateValue.gate!.resolve(); }
  await failed(await lateResponse, late.id);

  // Reinstallation stages separately: an already active pairing and token are
  // untouched until the operator explicitly validates and provisions it.
  const tenantId = crypto.randomUUID();
  await db.insertInto("tenants").values({ id: tenantId, enabled: true }).execute();
  const oldToken = "xoxb-old-active-fixture";
  await db.insertInto("slack_workspaces").values({
    tenant_id: tenantId, team_id: "TALPHA", bot_user_id: "UOLDALPHA",
    bot_token_ciphertext: encryptSlackToken({ token: oldToken, teamId: "TALPHA", key }), selected_channel_id: "CALPHA",
  }).execute();
  await db.insertInto("github_installations").values({ tenant_id: tenantId, installation_id: "71", github_account_id: "81" }).execute();
  const activeBefore = await db.selectFrom("slack_workspaces").selectAll().execute();
  const reinstall = await start(primary);
  assert.equal((await callback(replica, reinstall, fixture("TALPHA"))).statusCode, 200);
  assert.deepEqual(await db.selectFrom("slack_workspaces").selectAll().execute(), activeBefore);
  let activeRuntimeToken: string | undefined;
  const activeResolver = new SlackResolver(store, key, (token) => { activeRuntimeToken = token; return new SlackClient(token); });
  assert.ok(await activeResolver.forTeam("TALPHA"));
  assert.equal(activeRuntimeToken, oldToken);

  const limited = app();
  const firstLimited = await start(limited);
  const firstLimitedBefore = await raw(firstLimited.id);
  let admitted = 1;
  let rateLimited: HttpResponse | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await limited.inject({ method: "GET", url: "/api/slack/oauth/start" });
    if (response.statusCode === 429) { rateLimited = response; break; }
    assert.equal(response.statusCode, 302); admitted++;
  }
  assert.ok(rateLimited, "Public installation starts have a finite per-instance rate limit");
  assert.equal(admitted, 30);
  assert.ok(Number(rateLimited.headers["retry-after"]) > 0);
  safeResponse(rateLimited);
  const countAfterLimit = await sessionCount();
  assert.equal((await limited.inject({ method: "GET", url: "/api/slack/oauth/start" })).statusCode, 429);
  assert.equal(await sessionCount(), countAfterLimit);
  assert.deepEqual(await raw(firstLimited.id), firstLimitedBefore);

  const callbackLimited = app();
  const limitSession = await start(callbackLimited);
  const limitBefore = await raw(limitSession.id);
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await callbackLimited.inject({ method: "GET", url: `/api/slack/oauth/callback?code=${marker}` });
    assert.equal(response.statusCode, 400);
  }
  const callbackLimit = await callbackLimited.inject({ method: "GET", url: `/api/slack/oauth/callback?code=${marker}` });
  assert.equal(callbackLimit.statusCode, 429);
  assert.ok(Number(callbackLimit.headers["retry-after"]) > 0);
  safeResponse(callbackLimit, true);
  assert.deepEqual(await raw(limitSession.id), limitBefore);

  // Not-found handling can leak raw URLs independently of the request
  // serializer, so exercise disabled routes, wrong methods and unknown paths.
  const disabled = app(db, key, false);
  const beforeDisabled = await sessionCount();
  for (const server of [primary, disabled]) {
    for (const method of ["POST", "HEAD"] as const) {
      for (const path of ["start", "callback", "unknown"]) {
        const response = await server.inject({ method, url: `/api/slack/oauth/${path}?code=${marker}&state=${marker}` });
        assert.equal(response.statusCode, 404);
        for (const secret of secrets) assert.equal(response.body.includes(secret), false);
      }
    }
  }
  for (const path of ["start", "callback"]) {
    const response = await disabled.inject({ method: "GET", url: `/api/slack/oauth/${path}?code=${marker}&state=${marker}` });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes(marker), false);
  }
  assert.equal(await sessionCount(), beforeDisabled);

  const noKey = app(db, null);
  const countBeforeMissingKey = await sessionCount();
  const unavailable = await noKey.inject({ method: "GET", url: "/api/slack/oauth/start" });
  assert.equal(unavailable.statusCode, 503); safeResponse(unavailable);
  assert.equal(await sessionCount(), countBeforeMissingKey);
  const unavailableCallback = await noKey.inject({ method: "GET", url: `/api/slack/oauth/callback?code=${marker}` });
  assert.equal(unavailableCallback.statusCode, 503); safeResponse(unavailableCallback, true);

  const wrongKeyApp = app(db, Buffer.alloc(32, 38));
  const wrongKeySession = await start(wrongKeyApp);
  const previouslyPending = await raw(accepted[0].session.id);
  await failed(await callback(wrongKeyApp, wrongKeySession, fixture("TWRONGKEY")), wrongKeySession.id);
  assert.deepEqual(await raw(accepted[0].session.id), previouslyPending);
  assert.equal((await raw(wrongKeySession.id)).bot_token_ciphertext, null);
  // Carry these exact HTTP-created records through operator provisioning.
  // The first updates an existing pairing; the other two create independent
  // tenants, including a provider-validation retry and a two-replica race.
  const pairings = accepted.map(({ session, fixture: value }, index) => ({
    session, value, installationId: String(71 + index), accountId: String(81 + index),
    repositoryId: String(91 + index), owner: `Workspace${index}`, repo: "Product", channelId: `C${value.teamId}`,
  }));
  const adminProviders: AdminProviders = {
    inspectSlackToken: async (token) => {
      const pairing = pairings.find(({ value }) => value.token === token);
      assert.ok(pairing);
      const identity = await new SlackClient(token).botIdentity();
      return { teamId: identity.teamId, botUserId: identity.userId, channelIds: [pairing.channelId] };
    },
    resolveRepository: async () => { throw new Error("Provisioning must inspect the specified installation"); },
    inspectInstallationRepository: async (installationId, owner, repo) => {
      const pairing = pairings.find((candidate) => candidate.installationId === installationId);
      assert.ok(pairing);
      assert.equal(owner, pairing.owner); assert.equal(repo, pairing.repo);
      return { installationId, githubAccountId: pairing.accountId, repositoryId: pairing.repositoryId,
        repositoryOwnerId: pairing.accountId, owner, repo, fullName: `${owner}/${repo}` };
    },
  };
  const provisionInputs = pairings.map((pairing) => ({
    db, providers: adminProviders, slackInstallationId: pairing.session.id, encryptionKey: key,
    installationId: pairing.installationId, repository: { owner: pairing.owner, repo: pairing.repo }, selectedChannelId: pairing.channelId,
  }));
  const expectedEnvelopes = await Promise.all(pairings.map(async (pairing) => (await raw(pairing.session.id)).bot_token_ciphertext));
  const pendingBeforeValidation = await raw(pairings[2].session.id);
  const activeBeforeValidation = await db.selectFrom("slack_workspaces").selectAll().execute();
  await assert.rejects(provisionTenant({ ...provisionInputs[2], selectedChannelId: "CUNAVAILABLE" }), /not a member/);
  assert.deepEqual(await raw(pairings[2].session.id), pendingBeforeValidation);
  assert.deepEqual(await db.selectFrom("slack_workspaces").selectAll().execute(), activeBeforeValidation);

  const activated = [await provisionTenant(provisionInputs[0])];
  assert.equal(activated[0].tenantId, tenantId, "Reinstallation retains the existing tenant pairing");
  const bothValidated = deferred();
  let validations = 0;
  const concurrentProviders: AdminProviders = {
    ...adminProviders,
    inspectSlackToken: async (token) => {
      const identity = await adminProviders.inspectSlackToken(token);
      if (++validations === 2) bothValidated.resolve();
      await bothValidated.promise;
      return identity;
    },
  };
  const provisioning = await Promise.allSettled([db, replicaDb].map((database) => provisionTenant({
    ...provisionInputs[1], db: database, providers: concurrentProviders,
  })));
  const winners = provisioning.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1, "Concurrent provisioning consumes the HTTP installation once");
  assert.match(String(provisioning.find((result) => result.status === "rejected")?.reason), /unavailable/);
  activated.push(winners[0].value, await provisionTenant(provisionInputs[2]));
  assert.equal(new Set(activated.map((report) => report.tenantId)).size, 3);
  for (const [index, pairing] of pairings.entries()) {
    const status = await raw(pairing.session.id);
    assert.equal(status.status, "consumed"); assert.equal(status.bot_token_ciphertext, null);
    assert.equal(status.consumed_tenant_id, activated[index].tenantId);
    assert.equal(status.consumed_github_installation_id, pairing.installationId);
    const workspace = await db.selectFrom("slack_workspaces").selectAll().where("team_id", "=", pairing.value.teamId).executeTakeFirstOrThrow();
    assert.equal(workspace.bot_token_ciphertext, expectedEnvelopes[index], "Activation copies the exact verified callback envelope");
    const github = await store.getEnabledGitHubInstallationByAccountId(pairing.accountId);
    assert.equal(github?.tenantId, activated[index].tenantId);
    assert.equal(github?.installationId, pairing.installationId);
    let selectedToken: string | undefined;
    const routed = new SlackResolver(store, key, (token) => { selectedToken = token; return new SlackClient(token); });
    const byTeam = await routed.forTeam(pairing.value.teamId);
    assert.equal(byTeam?.workspace.tenantId, activated[index].tenantId);
    assert.equal(selectedToken, pairing.value.token);
    assert.deepEqual(await byTeam?.client.botIdentity(), { teamId: pairing.value.teamId, userId: pairing.value.botUserId });
    const byTenant = await routed.forTenant(activated[index].tenantId);
    assert.equal(byTenant?.workspace.teamId, pairing.value.teamId);
    assert.equal(selectedToken, pairing.value.token);
    await assert.rejects(provisionTenant(provisionInputs[index]), /unavailable/);
  }

  // Capture the scheduled callback while retaining its real timer handle. Drive
  // it directly so this checks the scheduler without a sixty-second sleep.
  const schedulerDb = connect("feature-rec-oauth-cleanup-selftest");
  const blocker = new Client({ connectionString: testUrl });
  let tick: (() => void) | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;
  const originalSetInterval = globalThis.setInterval;
  const intervalMock = mock.method(globalThis, "setInterval", (callback: () => void, milliseconds: number) => {
    const timer = originalSetInterval(callback, milliseconds);
    if (milliseconds === 60_000) { tick = callback; cleanupTimer = timer; }
    return timer;
  });
  let scheduled: App;
  try { scheduled = app(schedulerDb); } finally { intervalMock.mock.restore(); }
  assert.ok(tick); assert.ok(cleanupTimer);
  const schedulerSession = await start(scheduled);
  await db.updateTable("slack_oauth_installations").set({ expires_at: sql`clock_timestamp() - interval '1 second'` })
    .where("id", "=", schedulerSession.id).execute();
  const transactionMock = mock.method(schedulerDb, "transaction");
  const clearIntervalMock = mock.method(globalThis, "clearInterval");
  let closing: Promise<void> | undefined;
  await blocker.connect();
  try {
    await blocker.query("begin");
    await blocker.query("lock table slack_oauth_installations in access exclusive mode");
    tick(); tick();
    assert.equal(transactionMock.mock.callCount(), 1, "Cleanup ticks never overlap transactions");
    const deadline = Date.now() + 5_000;
    let blocked = false;
    while (Date.now() < deadline) {
      const result = await sql<{ count: string }>`select count(*)::text as count from pg_stat_activity
        where datname = current_database() and application_name = 'feature-rec-oauth-cleanup-selftest'
          and wait_event_type = 'Lock'`.execute(db);
      if (Number(result.rows[0]?.count) === 1) { blocked = true; break; }
      await delay(10);
    }
    assert.ok(blocked, "The captured cleanup tick runs against the real database");
    let closed = false;
    closing = scheduled.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(closed, false, "Closing waits for the in-flight cleanup transaction");
    assert.ok(clearIntervalMock.mock.calls.some((call) => call.arguments[0] === cleanupTimer), "Closing cancels future cleanup ticks");
  } finally {
    await blocker.query("commit");
    await closing;
    await scheduled.close();
    transactionMock.mock.restore(); clearIntervalMock.mock.restore();
    await blocker.end();
    await schedulerDb.destroy();
  }
  const cleaned = await raw(schedulerSession.id);
  assert.equal(cleaned.status, "expired");
  assert.equal(cleaned.state_hash, null); assert.equal(cleaned.browser_binding_hash, null);
  assert.deepEqual(providerErrors, []);
  const serializedLogs = logs.join("");
  for (const secret of secrets) assert.equal(serializedLogs.includes(secret), false, "Production Fastify and SDK logs redact OAuth/provider secrets");
  assert.ok(serializedLogs.includes("/api/slack/oauth/callback"), "Redaction retains useful route diagnostics");
  console.log("service Slack OAuth HTTP selftest passed");
} finally {
  for (const value of fixtures.values()) value.gate?.resolve();
  await Promise.allSettled(apps.map((instance) => instance.close()));
  globalThis.fetch = originalFetch;
  provider.closeAllConnections();
  await new Promise<void>((resolve, reject) => { provider.close((error) => error ? reject(error) : resolve()); });
  await store.close().catch(() => {});
  await replicaDb.destroy().catch(() => {});
  await db.destroy().catch(() => {});
  const dropper = new Client({ connectionString: adminUrl });
  await dropper.connect();
  await dropper.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await dropper.end();
}
