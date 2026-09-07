import { createRemoteJWKSet, customFetch, errors, jwtVerify, type RemoteJWKSet } from "jose";
import type { ServiceEnv } from "./env";

export type RunnerIdentity = {
  repositoryId: string;
  repositoryOwnerId: string;
  eventName: string;
};

export type RunnerIdentityVerifier = {
  verify(authorization: string | undefined): Promise<RunnerIdentity>;
};

// Deliberately contain no provider response or JWT claims: these errors can be
// logged or returned by the HTTP boundary without exposing credentials.
export class OidcAuthenticationError extends Error {
  constructor(readonly reason: "header" | "expired" | "issuer" | "audience" | "signature" | "algorithm" | "claims" | "key" | "event" | "malformed" = "malformed") {
    super("Invalid GitHub Actions OIDC token");
  }
}

export class OidcProviderError extends Error {
  constructor() { super("GitHub Actions OIDC provider is temporarily unavailable"); }
}

const CLOCK_TOLERANCE_SECONDS = 5;

export class GitHubOidcVerifier implements RunnerIdentityVerifier {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #fetch: typeof fetch;
  readonly #cooldownDuration: number;
  #resolver: Promise<RemoteJWKSet> | undefined;

  constructor(
    env: Pick<ServiceEnv, "baseUrl" | "githubOidcIssuer">,
    options: { fetch?: typeof fetch; jwksCooldownDurationMs?: number } = {},
  ) {
    this.#issuer = env.githubOidcIssuer;
    this.#audience = env.baseUrl;
    this.#fetch = options.fetch ?? fetch;
    this.#cooldownDuration = options.jwksCooldownDurationMs ?? 30_000;
  }

  async #discover(): Promise<RemoteJWKSet> {
    try {
      const response = await this.#fetch(`${this.#issuer}/.well-known/openid-configuration`, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new OidcProviderError();
      const discovery = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
      if (discovery.issuer !== this.#issuer || typeof discovery.jwks_uri !== "string") {
        throw new OidcProviderError();
      }
      const jwksUrl = new URL(discovery.jwks_uri);
      if (jwksUrl.protocol !== "https:" || jwksUrl.username || jwksUrl.password || jwksUrl.hash) {
        throw new OidcProviderError();
      }
      return createRemoteJWKSet(jwksUrl, {
        cooldownDuration: this.#cooldownDuration,
        timeoutDuration: 5_000,
        [customFetch]: this.#fetch,
      });
    } catch {
      throw new OidcProviderError();
    }
  }

  async verify(authorization: string | undefined): Promise<RunnerIdentity> {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization ?? "");
    if (!match) throw new OidcAuthenticationError("header");
    try {
      const { payload } = await jwtVerify(match[1], async (header, token) => {
        // Discovery is lazy: startup and /health do not need a live provider.
        // Failed discovery is not cached, while the successful JWKS resolver is
        // reused in memory across requests and handles key rotation itself.
        this.#resolver ??= this.#discover().catch((error: unknown) => {
          this.#resolver = undefined;
          throw error;
        });
        const resolver = await this.#resolver;
        try {
          return await resolver(header, token);
        } catch (error) {
          if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
            throw new OidcAuthenticationError("key");
          }
          throw new OidcProviderError();
        }
      }, {
        issuer: this.#issuer,
        audience: this.#audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "repository_id", "repository_owner_id", "event_name"],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      if (payload.aud !== this.#audience) throw new OidcAuthenticationError("audience");
      if (payload.event_name !== "pull_request") throw new OidcAuthenticationError("event");
      if (
        typeof payload.iat !== "number" || !Number.isFinite(payload.iat) ||
        typeof payload.exp !== "number" || !Number.isFinite(payload.exp) ||
        payload.exp <= payload.iat ||
        payload.iat > Date.now() / 1_000 + CLOCK_TOLERANCE_SECONDS ||
        typeof payload.repository_id !== "string" || !/^[0-9]+$/.test(payload.repository_id) ||
        typeof payload.repository_owner_id !== "string" || !/^[0-9]+$/.test(payload.repository_owner_id)
      ) {
        throw new OidcAuthenticationError("claims");
      }
      return {
        repositoryId: payload.repository_id,
        repositoryOwnerId: payload.repository_owner_id,
        eventName: payload.event_name,
      };
    } catch (error) {
      if (error instanceof OidcProviderError || error instanceof OidcAuthenticationError) throw error;
      if (error instanceof errors.JWTExpired) throw new OidcAuthenticationError("expired");
      if (error instanceof errors.JWTClaimValidationFailed) {
        throw new OidcAuthenticationError(error.claim === "iss" ? "issuer" : error.claim === "aud" ? "audience" : "claims");
      }
      if (error instanceof errors.JWSSignatureVerificationFailed) throw new OidcAuthenticationError("signature");
      if (error instanceof errors.JOSEAlgNotAllowed) throw new OidcAuthenticationError("algorithm");
      throw new OidcAuthenticationError("malformed");
    }
  }
}
