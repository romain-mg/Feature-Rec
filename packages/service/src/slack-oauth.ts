import {
  InstallProvider,
  LogLevel,
  type InstallationStore,
  type Logger,
  type StateStore,
} from "@slack/oauth";
import type { FastifyBaseLogger } from "fastify";
import type { ServiceEnv } from "./env";

export const SLACK_OAUTH_SCOPES = ["chat:write", "files:write", "usergroups:read", "channels:read", "groups:read", "commands"];

export function createSlackOAuthLogger(log: Pick<FastifyBaseLogger, "warn" | "error">): Logger {
  // SDK arguments can contain codes, URLs, credentials, and provider bodies. Drop
  // them entirely, including logger names; lowering verbosity alone is insufficient.
  return {
    debug() {},
    info() {},
    warn() {
      log.warn({ event: "SLACK_OAUTH_SDK_WARNING" }, "Slack OAuth SDK warning");
    },
    error() {
      log.error({ event: "SLACK_OAUTH_SDK_ERROR" }, "Slack OAuth SDK error");
    },
    setLevel() {},
    getLevel() { return LogLevel.WARN; },
    setName() {},
  };
}

// Require both adapters so this boundary cannot silently use SDK memory stores.
export function createSlackOAuthInstaller(input: {
  config: NonNullable<ServiceEnv["slackOAuth"]>;
  stateStore: StateStore;
  installationStore: InstallationStore;
  logger: Pick<FastifyBaseLogger, "warn" | "error">;
}): InstallProvider {
  return new InstallProvider({
    clientId: input.config.clientId,
    clientSecret: input.config.clientSecret,
    authVersion: "v2",
    directInstall: true,
    stateVerification: true,
    legacyStateVerification: false,
    stateStore: input.stateStore,
    installationStore: input.installationStore,
    installUrlOptions: {
      redirectUri: input.config.redirectUri,
      scopes: SLACK_OAUTH_SCOPES,
    },
    logger: createSlackOAuthLogger(input.logger),
    clientOptions: {
      timeout: 10_000,
      // A code exchange may already have succeeded when its response is lost.
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    },
  });
}
