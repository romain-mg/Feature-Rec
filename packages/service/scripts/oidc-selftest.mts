import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { DEFAULT_GITHUB_OIDC_ISSUER, readEnv } from "../src/env";
import { GitHubOidcVerifier, OidcAuthenticationError, OidcProviderError } from "../src/oidc";

const database = { DATABASE_URL: "postgres://localhost/test" };
assert.throws(() => readEnv(database), /FEATURE_REC_BASE_URL is required/);
for (const value of ["invalid", "http://localhost:3000", "http://example.com", "https://u:p@example.com", "https://example.com?x=1", "https://example.com#f"]) {
  assert.throws(() => readEnv({ ...database, FEATURE_REC_BASE_URL: value, NODE_ENV: "production" }), /base URL/);
}
for (const nodeEnv of ["development", "test"]) {
  assert.equal(readEnv({ ...database, FEATURE_REC_BASE_URL: "http://127.0.0.1:3000/", NODE_ENV: nodeEnv }).baseUrl, "http://127.0.0.1:3000");
}
const serviceEnv = readEnv({ ...database, FEATURE_REC_BASE_URL: "HTTPS://SERVICE.EXAMPLE:443///", FEATURE_REC_RUNNER_TOKEN: "unused", GITHUB_TOKEN: "unused", FEATURE_REC_GITHUB_TOKEN: "unused", SLACK_BOT_TOKEN: "unused" });
assert.equal(serviceEnv.baseUrl, "https://service.example");
assert.equal(serviceEnv.githubOidcIssuer, DEFAULT_GITHUB_OIDC_ISSUER);
assert.equal("runnerToken" in serviceEnv, false);
assert.equal("githubToken" in serviceEnv, false);
assert.equal("slackBotToken" in serviceEnv, false);
assert.equal(readEnv({ ...database, FEATURE_REC_BASE_URL: serviceEnv.baseUrl, GITHUB_OIDC_ISSUER: "https://issuer.example///" }).githubOidcIssuer, "https://issuer.example");
for (const issuer of ["http://issuer.example", "https://u:p@issuer.example", "https://issuer.example?", "https://issuer.example#", "invalid"]) {
  assert.throws(() => readEnv({ ...database, FEATURE_REC_BASE_URL: serviceEnv.baseUrl, GITHUB_OIDC_ISSUER: issuer }), /GITHUB_OIDC_ISSUER/);
}

const issuer = "https://issuer.example";
const audience = "https://service.example";
const keyA = await generateKeyPair("RS256");
const keyB = await generateKeyPair("RS256");
let keys = [{ ...await exportJWK(keyA.publicKey), kid: "a", alg: "RS256" }];
let discoveryStatus = 200;
let jwksStatus = 200;
let discoveryIssuer = issuer;
let discoveryJwks = `${issuer}/keys`;
let invalidJwks = false;
const requests: string[] = [];
const server = createServer((request, response) => {
  const pathname = new URL(request.url!, "http://localhost").pathname;
  response.setHeader("content-type", "application/json");
  if (pathname === "/.well-known/openid-configuration") {
    response.writeHead(discoveryStatus).end(JSON.stringify({ issuer: discoveryIssuer, jwks_uri: discoveryJwks }));
  } else if (pathname === "/keys") {
    response.writeHead(jwksStatus).end(invalidJwks ? "invalid json" : JSON.stringify({ keys }));
  } else {
    response.writeHead(404).end("{}");
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const transport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  requests.push(url.toString());
  assert.equal(url.origin, issuer, "Only configured discovery and its JWKS may be fetched");
  assert.equal(init?.redirect === "error" || init?.redirect === "manual", true);
  return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
};
const verifier = () => new GitHubOidcVerifier({ baseUrl: audience, githubOidcIssuer: issuer }, { fetch: transport, jwksCooldownDurationMs: 0 });
const now = Math.floor(Date.now() / 1000);
const defaults: JWTPayload = { iss: issuer, aud: audience, iat: now, exp: now + 300, repository_id: "9223372036854775807", repository_owner_id: "001234", event_name: "pull_request" };
async function token(overrides: JWTPayload = {}, key = keyA.privateKey, kid = "a", header: Record<string, string> = {}) {
  return new SignJWT({ ...defaults, ...overrides }).setProtectedHeader({ alg: "RS256", kid, ...header }).sign(key);
}
async function authFails(jwt: string, reason?: OidcAuthenticationError["reason"], instance = verifier()) {
  await assert.rejects(instance.verify(`Bearer ${jwt}`), (error: unknown) => {
    assert.ok(error instanceof OidcAuthenticationError);
    if (reason !== undefined) assert.equal(error.reason, reason);
    assert.equal(error.message.includes(jwt), false);
    assert.equal(error.cause, undefined);
    return true;
  });
}

try {
  for (const [claims, reason] of [
    [{ exp: now - 60 }, "expired"], [{ iss: "https://wrong.example" }, "issuer"],
    [{ aud: "https://wrong.example" }, "audience"], [{ event_name: "push" }, "event"],
    [{ repository_id: 123 }, "claims"],
  ] as const) {
    await assert.rejects(verifier().verify(`Bearer ${await token(claims)}`), (error: unknown) => {
      assert.ok(error instanceof OidcAuthenticationError);
      assert.equal(error.reason, reason);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  requests.length = 0;
  const cached = verifier();
  assert.equal(requests.length, 0, "Discovery stays lazy until verification");
  for (const auth of [undefined, "", "token", "Basic token", "Bearer malformed", "Bearer a.b.c extra"]) {
    await assert.rejects(cached.verify(auth), (error: unknown) => {
      assert.ok(error instanceof OidcAuthenticationError);
      assert.equal(error.reason, "header");
      return true;
    });
  }
  assert.equal(requests.length, 0);
  const good = await token();
  const expected = { repositoryId: "9223372036854775807", repositoryOwnerId: "001234", eventName: "pull_request" };
  assert.deepEqual(await cached.verify(`Bearer ${good}`), expected);
  assert.deepEqual(await cached.verify(`bearer ${good}`), expected);
  assert.equal(requests.length, 2, "Reuse both discovery and the remote JWKS cache");
  await authFails("a.b.c", "malformed");
  await authFails(await token({}, keyB.privateKey), "signature");
  await authFails(await token({}, keyB.privateKey, "unknown"), "key");
  for (const claims of [
    { iss: "https://attacker.example" }, { aud: "https://other.example" }, { aud: [audience, "other"] },
    { exp: now - 10 }, { iat: now + 30 }, { nbf: now + 30 }, { exp: now - 1, iat: now },
    { exp: undefined }, { iat: undefined }, { repository_id: undefined }, { repository_owner_id: undefined },
    { repository_id: 123 }, { repository_id: "1e3" }, { repository_id: "" }, { repository_id: "-12" },
    { repository_owner_id: 123 }, { repository_owner_id: "1.2" }, { event_name: "pull_request_target" },
    { event_name: "push" }, { event_name: undefined },
  ]) await authFails(await token(claims));
  assert.deepEqual(await cached.verify(`Bearer ${await token({ exp: now - 2, iat: now - 100 })}`), expected);
  assert.deepEqual(await cached.verify(`Bearer ${await token({ iat: now + 2, nbf: now + 2 })}`), expected);
  const hmac = await new SignJWT(defaults).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32));
  await authFails(hmac, "algorithm");
  const beforeUrls = requests.length;
  assert.deepEqual(await cached.verify(`Bearer ${await token({ sub: "attacker-controlled ignored identity" }, keyA.privateKey, "a", { jku: "https://attacker.example/jwks", x5u: "https://attacker.example/cert" })}`), expected);
  assert.equal(requests.length, beforeUrls);

  keys = [{ ...await exportJWK(keyB.publicKey), kid: "b", alg: "RS256" }];
  assert.deepEqual(await cached.verify(`Bearer ${await token({}, keyB.privateKey, "b")}`), expected);
  assert.equal(requests.filter(url => url.endsWith("/.well-known/openid-configuration")).length >= 1, true);
  keys = [{ ...await exportJWK(keyA.publicKey), kid: "a", alg: "RS256" }];

  const retryDiscovery = verifier();
  discoveryStatus = 503;
  await assert.rejects(retryDiscovery.verify(`Bearer ${good}`), OidcProviderError);
  discoveryStatus = 200;
  assert.deepEqual(await retryDiscovery.verify(`Bearer ${good}`), expected);
  const retryJwks = verifier();
  jwksStatus = 503;
  await assert.rejects(retryJwks.verify(`Bearer ${good}`), OidcProviderError);
  jwksStatus = 200;
  assert.deepEqual(await retryJwks.verify(`Bearer ${good}`), expected);
  invalidJwks = true;
  await assert.rejects(verifier().verify(`Bearer ${good}`), OidcProviderError);
  invalidJwks = false;
  discoveryIssuer = "https://other.example";
  await assert.rejects(verifier().verify(`Bearer ${good}`), OidcProviderError);
  discoveryIssuer = issuer;
  discoveryJwks = "http://issuer.example/keys";
  await assert.rejects(verifier().verify(`Bearer ${good}`), OidcProviderError);
  const offline = new GitHubOidcVerifier({ baseUrl: audience, githubOidcIssuer: issuer }, { fetch: async () => { throw new Error("network failed"); } });
  await assert.rejects(offline.verify(`Bearer ${good}`), OidcProviderError);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log("OIDC and environment selftest passed");
