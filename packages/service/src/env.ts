import { z } from "zod";
import { normalizeOidcAudience } from "@feature-rec/core";
import { parseSlackTokenEncryptionKey } from "./slack-token-crypto";

export const DEFAULT_GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

const SlackOAuthCredentialsSchema = z.object({
  appId: z.string().regex(/^A[A-Z0-9]+$/),
  clientId: z.string().regex(/^[0-9]+\.[0-9]+$/),
  clientSecret: z.string().min(1),
}).refine((credentials) => Object.values(credentials).every((value) => !/\s/.test(value)));

export type ServiceEnv = {
  port: number;
  baseUrl: string;
  databaseUrl: string;
  githubAppId: string;
  githubPrivateKey: string;
  slackSigningSecret: string;
  slackOAuth: (z.infer<typeof SlackOAuthCredentialsSchema> & { redirectUri: string }) | null;
  slackTokenEncryptionKey: Buffer | null;
  githubOidcIssuer: string;
};

function readOidcIssuer(value: string | undefined): string {
  const raw = value ?? DEFAULT_GITHUB_OIDC_ISSUER;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("GITHUB_OIDC_ISSUER must be a valid HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    raw.includes("?") || raw.includes("#")
  ) {
    throw new Error("GITHUB_OIDC_ISSUER must be an HTTPS URL without credentials, query, or fragment");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function readSlackOAuth(env: NodeJS.ProcessEnv, baseUrl: string): ServiceEnv["slackOAuth"] {
  const credentials = {
    appId: env.SLACK_APP_ID,
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
  };
  // Empty template values are disabled; a partially configured app must fail at startup.
  if (Object.values(credentials).every((value) => value === undefined || value === "")) return null;
  const parsed = SlackOAuthCredentialsSchema.safeParse(credentials);
  if (!parsed.success) {
    // Never include supplied values or the validation error in startup diagnostics.
    throw new Error("Slack OAuth requires valid SLACK_APP_ID, SLACK_CLIENT_ID, and SLACK_CLIENT_SECRET together");
  }
  return { ...parsed.data, redirectUri: `${baseUrl}/api/slack/oauth/callback` };
}

export function readEnv(env = process.env): ServiceEnv {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (!env.FEATURE_REC_BASE_URL) throw new Error("FEATURE_REC_BASE_URL is required");
  const baseUrl = normalizeOidcAudience(env.FEATURE_REC_BASE_URL, {
    allowLoopbackHttp: env.NODE_ENV === "development" || env.NODE_ENV === "test",
  });
  return {
    port: Number(env.PORT) || 3000,
    baseUrl,
    databaseUrl,
    githubAppId: env.GITHUB_APP_ID ?? "",
    githubPrivateKey: (env.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    slackSigningSecret: env.SLACK_SIGNING_SECRET ?? "",
    slackOAuth: readSlackOAuth(env, baseUrl),
    slackTokenEncryptionKey: parseSlackTokenEncryptionKey(
      env.FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY,
    ),
    githubOidcIssuer: readOidcIssuer(env.GITHUB_OIDC_ISSUER),
  };
}
