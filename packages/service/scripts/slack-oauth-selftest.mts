import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mock } from "node:test";
import { InstallProvider, LogLevel, type CodedError, type Installation, type InstallationStore, type InstallURLOptions, type StateStore } from "@slack/oauth";
import type { FastifyBaseLogger } from "fastify";
import { readEnv } from "../src/env";
import { buildServer } from "../src/http";
import { createSlackOAuthInstaller, createSlackOAuthLogger } from "../src/slack-oauth";
import type { CycleStore } from "../src/storage";

const baseEnv = {
  DATABASE_URL: "postgres://localhost/unused",
  FEATURE_REC_BASE_URL: "HTTPS://SERVICE.EXAMPLE:443///",
};
const credentials = {
  SLACK_APP_ID: "A0123456789",
  SLACK_CLIENT_ID: "123456789.987654321",
  SLACK_CLIENT_SECRET: "fixture-nonhex+client/secret=",
};
const disabled = readEnv(baseEnv);
const configured = readEnv({ ...baseEnv, ...credentials });
assert.equal(disabled.slackOAuth, null);
assert.equal(readEnv({ ...baseEnv, SLACK_APP_ID: "", SLACK_CLIENT_ID: "", SLACK_CLIENT_SECRET: "" }).slackOAuth, null);
assert.deepEqual(configured.slackOAuth, {
  appId: credentials.SLACK_APP_ID,
  clientId: credentials.SLACK_CLIENT_ID,
  clientSecret: credentials.SLACK_CLIENT_SECRET,
  redirectUri: "https://service.example/api/slack/oauth/callback",
});
assert.equal(configured.slackTokenEncryptionKey, null, "SDK configuration alone does not need a token encryption key");
assert.equal(readEnv({
  ...baseEnv, ...credentials, FEATURE_REC_BASE_URL: "http://127.0.0.1:3000/", NODE_ENV: "test",
}).slackOAuth?.redirectUri, "http://127.0.0.1:3000/api/slack/oauth/callback");

function configurationFails(env: NodeJS.ProcessEnv): void {
  assert.throws(() => readEnv(env), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /SLACK_/);
    assert.equal(error.cause, undefined);
    const diagnostic = `${error.stack}\n${JSON.stringify(error)}`;
    for (const value of Object.values(credentials)) assert.equal(diagnostic.includes(value), false);
    for (const [name, value] of Object.entries(env)) {
      if (name.startsWith("SLACK_") && value && value.length > 4) assert.equal(diagnostic.includes(value), false);
    }
    return true;
  });
}
const credentialNames = Object.keys(credentials) as Array<keyof typeof credentials>;
for (let mask = 1; mask < 7; mask++) {
  const partial: NodeJS.ProcessEnv = { ...baseEnv };
  credentialNames.forEach((name, index) => { if (mask & (1 << index)) partial[name] = credentials[name]; });
  configurationFails(partial);
}
for (const [name, values] of [
  ["SLACK_APP_ID", ["", " ", "invalid-app-id", "T012345", "Aabc123", "A012345\n"]],
  ["SLACK_CLIENT_ID", ["", " ", "invalid-client-id", "123456", "123.456.789", "123.456\n"]],
  ["SLACK_CLIENT_SECRET", ["", " ", "secret with spaces", "secret\nwith-newline", "secret\twith-tab", "secret\n"]],
] as const) {
  for (const value of values) configurationFails({ ...baseEnv, ...credentials, [name]: value });
}

const logEntries: Array<{ level: string; args: unknown[] }> = [];
const logger: Pick<FastifyBaseLogger, "warn" | "error"> = {
  warn: (...args: unknown[]) => { logEntries.push({ level: "warn", args }); },
  error: (...args: unknown[]) => { logEntries.push({ level: "error", args }); },
};
const sdkLogger = createSlackOAuthLogger(logger);
const sensitive = [
  credentials.SLACK_CLIENT_SECRET, "fixture-authorization-code", "fixture-oauth-state",
  "xoxb-fixture-bot-token", "fixture-session-cookie", "fixture-install-secret", "fixture-ciphertext",
];
const rawError = new Error(sensitive.join(" "), { cause: { response: sensitive } });
const rawObject = { request: { headers: { cookie: sensitive[4] } }, response: sensitive, error: rawError };
sdkLogger.setName(sensitive.join(" "));
for (const level of [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR]) {
  sdkLogger.setLevel(level);
  assert.equal(sdkLogger.getLevel(), LogLevel.WARN);
}
sdkLogger.debug(...sensitive, rawObject, rawError);
sdkLogger.info(...sensitive, rawObject, rawError);
assert.equal(logEntries.length, 0);
sdkLogger.warn(...sensitive, rawObject, rawError);
sdkLogger.warn("unrelated SDK message");
sdkLogger.error(...sensitive, rawObject, rawError);
sdkLogger.error("unrelated SDK message");
assert.equal(logEntries.length, 4);
assert.deepEqual(logEntries[0], logEntries[1], "Warnings emit a fixed event/message independent of raw SDK arguments");
assert.deepEqual(logEntries[2], logEntries[3], "Errors emit a fixed event/message independent of raw SDK arguments");
assert.ok(logEntries.every(entry => entry.args.length > 0));

let stateOptions: InstallURLOptions | undefined;
let verifications = 0;
const stateStore: StateStore = {
  generateStateParam: async (options) => { stateOptions = options; return sensitive[2]; },
  verifyStateParam: async (_now, state) => {
    verifications++;
    assert.equal(state, sensitive[2]);
    assert.ok(stateOptions);
    return stateOptions;
  },
};
const installations: Installation[] = [];
const installationStore: InstallationStore = {
  storeInstallation: async (installation) => { installations.push(installation); },
  fetchInstallation: async () => { throw new Error("Installation reads are not expected during setup"); },
};
function httpPair(url: string, cookie?: string) {
  const request = new IncomingMessage(new Socket());
  request.url = url;
  request.method = "GET";
  if (cookie !== undefined) request.headers.cookie = cookie;
  return { request, response: new ServerResponse(request) };
}

let networkCalls = 0;
let transport: typeof fetch = async () => { throw new Error("No network request is expected during setup"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => { networkCalls++; return transport(input, init); };
try {
  assert.ok(configured.slackOAuth);
  const installer = createSlackOAuthInstaller({ config: configured.slackOAuth, stateStore, installationStore, logger });
  assert.ok(installer instanceof InstallProvider);
  assert.equal(networkCalls, 0, "Constructing the SDK must not contact Slack");
  const install = httpPair("/unused-install-test");
  await installer.handleInstallPath(install.request, install.response);
  assert.equal(install.response.statusCode, 302, "Direct install skips the SDK landing page");
  const location = install.response.getHeader("location");
  assert.equal(typeof location, "string");
  const authorization = new URL(String(location));
  assert.equal(authorization.origin, "https://slack.com");
  assert.equal(authorization.pathname, "/oauth/v2/authorize");
  assert.equal(authorization.searchParams.get("client_id"), credentials.SLACK_CLIENT_ID);
  assert.equal(authorization.searchParams.get("redirect_uri"), configured.slackOAuth.redirectUri);
  assert.deepEqual(authorization.searchParams.get("scope")?.split(",").sort(), [
    "channels:read", "chat:write", "commands", "files:write", "groups:read", "usergroups:read",
  ]);
  assert.equal(authorization.searchParams.has("user_scope"), false);
  assert.equal(authorization.searchParams.get("state"), sensitive[2]);
  assert.equal(authorization.toString().includes(credentials.SLACK_CLIENT_SECRET), false);
  const stateCookie = String(install.response.getHeader("set-cookie")).split(";")[0];
  assert.equal(stateCookie.split("=")[1], sensitive[2]);
  assert.equal(networkCalls, 0);

  for (const env of [disabled, configured]) {
    const unusedStore = new Proxy({} as CycleStore, { get: () => { throw new Error("Health must not touch storage"); } });
    const app = buildServer({ env, store: unusedStore });
    app.log.level = "silent";
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200);
      assert.deepEqual(health.json(), { ok: true });
      for (const url of ["/api/slack/oauth/start", "/api/slack/oauth/callback"]) {
        assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
      }
    } finally {
      await app.close();
    }
  }
  assert.equal(networkCalls, 0, "Both health configurations stay independent of Slack and OIDC network calls");

  async function callback(cookie: string | undefined) {
    const query = new URLSearchParams({ code: sensitive[1], state: sensitive[2] });
    const pair = httpPair(`/api/slack/oauth/callback?${query}`, cookie);
    let failure: CodedError | undefined;
    let succeeded = false;
    await installer.handleCallback(pair.request, pair.response, {
      failure: (error, _options, _request, response) => { failure = error; response.end(); },
      success: (_installation, _options, _request, response) => { succeeded = true; response.end(); },
    });
    return { failure, succeeded };
  }
  for (const cookie of [undefined, "slack-app-oauth-state=wrong-browser-state"]) {
    const result = await callback(cookie);
    assert.ok(result.failure);
    assert.equal(result.succeeded, false);
  }
  const missingState = httpPair(`/api/slack/oauth/callback?code=${sensitive[1]}`, stateCookie);
  let missingStateRejected = false;
  await installer.handleCallback(missingState.request, missingState.response, {
    failure: (_error, _options, _request, response) => { missingStateRejected = true; response.end(); },
  });
  assert.equal(missingStateRejected, true);
  assert.equal(verifications, 0, "Missing/mismatched browser state must fail before claiming state");
  assert.equal(networkCalls, 0, "Invalid browser state must not exchange an authorization code");

  for (const mode of ["transient", "rate-limit", "network"] as const) {
    transport = async () => {
      if (mode === "network") throw rawError;
      if (mode === "rate-limit") return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
      return new Response(sensitive.join(" "), { status: 503 });
    };
    const before: number = networkCalls;
    const result = await callback(stateCookie);
    assert.ok(result.failure);
    assert.equal(result.succeeded, false);
    assert.equal(networkCalls - before, 1, `${mode} failures must not replay a single-use authorization code`);
    if (mode === "rate-limit") assert.equal(result.failure.code, "slack_webapi_rate_limited_error", "Rate limits take the SDK immediate-rejection path");
    assert.equal(installations.length, 0);
  }

  const deadlines: number[] = [];
  const timeoutMock = mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadlines.push(milliseconds);
    const controller = new AbortController();
    setTimeout(() => { controller.abort(new DOMException("Fixture timeout", "TimeoutError")); }, 5);
    return controller.signal;
  });
  try {
    transport = async (_input, init) => {
      assert.ok(init?.signal, "OAuth HTTP requests must have an abort deadline");
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => { reject(init.signal!.reason); }, { once: true });
      });
    };
    const before = networkCalls;
    assert.ok((await callback(stateCookie)).failure);
    assert.deepEqual(deadlines, [10_000], "The SDK request deadline is ten seconds");
    assert.equal(networkCalls - before, 1, "An aborted code exchange must not be retried");
    assert.equal(installations.length, 0);
  } finally {
    timeoutMock.mock.restore();
  }

  const endpoints: string[] = [];
  transport = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://slack.com");
    endpoints.push(url.pathname);
    if (url.pathname === "/api/oauth.v2.access") {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("code"), sensitive[1]);
      assert.equal(body.get("client_id"), credentials.SLACK_CLIENT_ID);
      assert.equal(body.get("client_secret"), credentials.SLACK_CLIENT_SECRET);
      assert.equal(body.get("redirect_uri"), configured.slackOAuth!.redirectUri);
      return Response.json({
        ok: true, app_id: credentials.SLACK_APP_ID, access_token: sensitive[3], token_type: "bot",
        bot_user_id: "UBOT123", team: { id: "TTEAM123", name: "Fixture team" }, enterprise: null,
        is_enterprise_install: false, authed_user: { id: "UINSTALLER123" }, scope: Array.isArray(stateOptions!.scopes) ? stateOptions!.scopes.join(",") : stateOptions!.scopes,
      });
    }
    assert.equal(url.pathname, "/api/auth.test");
    return Response.json({ ok: true, bot_id: "BBOT123", user_id: "UBOT123", team_id: "TTEAM123" });
  };
  const result = await callback(stateCookie);
  assert.equal(result.failure, undefined);
  assert.equal(result.succeeded, true);
  assert.deepEqual(endpoints, ["/api/oauth.v2.access", "/api/auth.test"]);
  assert.equal(installations.length, 1, "The SDK uses the supplied installation store");
  assert.equal(installations[0].authVersion, "v2");
  assert.equal(installations[0].bot?.token, sensitive[3]);
} finally {
  globalThis.fetch = originalFetch;
}

const serializedLogs = JSON.stringify(logEntries);
for (const value of sensitive) assert.equal(serializedLogs.includes(value), false, "SDK diagnostics must not expose request or credential values");
console.log("Slack OAuth configuration and SDK selftest passed");
