import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import type { Installation, InstallURLOptions } from "@slack/oauth";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { ServiceEnv } from "./env";
import { SlackClient } from "./slack";
import { createSlackOAuthInstaller, SLACK_OAUTH_SCOPES } from "./slack-oauth";
import type { DB } from "./storage/schema";
import {
  claimSlackOAuthSession, cleanupSlackOAuthInstallations, createSlackOAuthSession,
  hasSlackOAuthBrowserBinding, stageSlackOAuthInstallation,
} from "./storage/slack-oauth";

export const SLACK_OAUTH_START_LIMIT = 30;
export const SLACK_OAUTH_CALLBACK_LIMIT = 120;
const BIND_COOKIE = "feature-rec-slack-oauth-bind";
const STATE_COOKIE = "slack-app-oauth-state";
const secret = /^[A-Za-z0-9_-]{43}$/;
const InstallationSchema = z.object({
  authVersion: z.literal("v2"), appId: z.string(), tokenType: z.literal("bot"),
  isEnterpriseInstall: z.literal(false),
  team: z.object({ id: z.string().regex(/^T[A-Z0-9]+$/) }),
  user: z.object({ id: z.string().regex(/^[UW][A-Z0-9]+$/), token: z.undefined(),
    refreshToken: z.undefined(), expiresAt: z.undefined(), scopes: z.array(z.string()).max(0).optional() }),
  bot: z.object({ token: z.string().min(1).max(4096).regex(/^\S+$/),
    userId: z.string().regex(/^[UW][A-Z0-9]+$/), id: z.string().regex(/^B[A-Z0-9]+$/),
    scopes: z.array(z.string()), refreshToken: z.undefined(), expiresAt: z.undefined() }),
});

function cookieValue(header: string | undefined, name: string): string | null {
  const values = (header ?? "").split(";").map((c) => c.trim()).filter((c) => c.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}

const originalHeaderSetters = new WeakMap<ServerResponse, ServerResponse["setHeader"]>();
function prepareResponse(response: ServerResponse, binding?: string, cookies = true): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (!cookies) return;
  const bindingCookie = `${BIND_COOKIE}=${binding ?? ""}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${binding ? 600 : 0}`;
  // A failed start can replace an already prepared creation response with cookie
  // deletions. Rewrap the original setter, never an adapter retaining the old BIND.
  const setHeader = originalHeaderSetters.get(response) ?? response.setHeader.bind(response);
  originalHeaderSetters.set(response, setHeader);
  // The SDK replaces Set-Cookie during callbacks. Preserve our independent
  // cookie deletion and add its missing SameSite attribute before sending headers.
  response.setHeader = (name, value) => {
    if (name.toLowerCase() !== "set-cookie") return setHeader(name, value);
    const cookies = (Array.isArray(value) ? value : [String(value)])
      .filter((c) => !c.startsWith(`${BIND_COOKIE}=`))
      .map((c) => c.startsWith(`${STATE_COOKIE}=`) && !/;\s*SameSite=/i.test(c) ? `${c}; SameSite=Lax` : c);
    return setHeader(name, [...cookies, bindingCookie]);
  };
  response.setHeader("Set-Cookie", binding ? [] : `${STATE_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function complete(response: ServerResponse, status: number, message: string): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(message);
}

export function registerSlackOAuthRoutes(app: FastifyInstance, input: {
  db: Kysely<DB>;
  config: NonNullable<ServiceEnv["slackOAuth"]>;
  encryptionKey: Buffer | null;
  slackClientFactory?: (token: string) => SlackClient;
}): void {
  // Fixed per-process budgets bound public work without storing attacker-chosen
  // IP keys or trusting proxy headers. Replicas each have their own budget.
  let windowStart = Date.now();
  let starts = 0;
  let callbacks = 0;
  function allowed(start: boolean): boolean {
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); starts = 0; callbacks = 0; }
    if (start) return ++starts <= SLACK_OAUTH_START_LIMIT;
    return ++callbacks <= SLACK_OAUTH_CALLBACK_LIMIT;
  }
  const options: InstallURLOptions = { scopes: SLACK_OAUTH_SCOPES, redirectUri: input.config.redirectUri };
  const failure = "Slack installation could not be completed. Start again at /api/slack/oauth/start.\n";

  app.get("/api/slack/oauth/start", { exposeHeadRoute: false }, async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    try {
      if (!allowed(true)) {
        prepareResponse(response, undefined, false); response.setHeader("Retry-After", "60");
        complete(response, 429, "Too many installation attempts. Try again shortly.\n"); return;
      }
      if (!input.encryptionKey) {
        prepareResponse(response, undefined, false); complete(response, 503, "Slack installation is not configured.\n"); return;
      }
      const installer = createSlackOAuthInstaller({ config: input.config, logger: app.log,
        stateStore: {
          generateStateParam: async () => {
            const session = await createSlackOAuthSession(input.db);
            prepareResponse(response, session.browserBinding);
            return session.state;
          },
          verifyStateParam: async () => { throw new Error("Unexpected callback on start"); },
        },
        installationStore: {
          storeInstallation: async () => { throw new Error("Unexpected installation on start"); },
          fetchInstallation: async () => { throw new Error("Pending tokens cannot authorize runtime requests"); },
        },
      });
      await installer.handleInstallPath(request.raw, response, undefined, options);
    } catch {
      app.log.error({ event: "SLACK_OAUTH_START_FAILED" }, "Slack installation start failed");
      if (!response.headersSent) prepareResponse(response);
      complete(response, 503, failure);
    }
  });

  app.get("/api/slack/oauth/callback", { exposeHeadRoute: false }, async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    prepareResponse(response);
    try {
      if (!allowed(false)) {
        response.setHeader("Retry-After", "60"); complete(response, 429, "Too many installation callbacks. Try again shortly.\n"); return;
      }
      if (!input.encryptionKey) { complete(response, 503, "Slack installation is not configured.\n"); return; }
      const encryptionKey = input.encryptionKey;
      const params = new URL(request.raw.url ?? "", input.config.redirectUri).searchParams;
      const state = params.get("state");
      const binding = cookieValue(request.headers.cookie, BIND_COOKIE);
      const stateCookie = cookieValue(request.headers.cookie, STATE_COOKIE);
      if (params.has("error") || params.getAll("code").length !== 1 || !params.get("code") ||
          params.get("code")!.length > 4096 || params.getAll("state").length !== 1 || !state || !secret.test(state) ||
          !binding || !secret.test(binding) || stateCookie !== state ||
          !await hasSlackOAuthBrowserBinding(input.db, { state, browserBinding: binding })) {
        complete(response, 400, failure); return;
      }
      // Each request owns its installer, claim and verified identity. A shared
      // installer with mutable callback fields could cross-wire concurrent users.
      let claim: Awaited<ReturnType<typeof claimSlackOAuthSession>> = null;
      let verified: { teamId: string; botUserId: string; token: string } | null = null;
      let stored = false;
      const installer = createSlackOAuthInstaller({ config: input.config, logger: app.log,
        stateStore: {
          generateStateParam: async () => { throw new Error("Unexpected start on callback"); },
          verifyStateParam: async (_now, returnedState) => {
            if (returnedState !== state) throw new Error("Invalid state");
            claim = await claimSlackOAuthSession(input.db, { state, browserBinding: binding });
            if (!claim) throw new Error("Session unavailable");
            return options;
          },
        },
        installationStore: {
          storeInstallation: async () => {
            if (!claim || !verified || !await stageSlackOAuthInstallation(input.db, { ...claim, ...verified, encryptionKey })) {
              throw new Error("Installation unavailable");
            }
            stored = true;
          },
          fetchInstallation: async () => { throw new Error("Pending tokens cannot authorize runtime requests"); },
        },
      });
      await installer.handleCallback(request.raw, response, {
        afterInstallation: async (installation: Installation) => {
          const result = InstallationSchema.safeParse(installation);
          if (!result.success || result.data.appId !== input.config.appId ||
              !SLACK_OAUTH_SCOPES.every((scope) => result.data.bot.scopes.includes(scope))) throw new Error("Unsupported installation");
          const data = result.data;
          const identity = await (input.slackClientFactory?.(data.bot.token) ?? new SlackClient(data.bot.token)).botIdentity();
          if (identity.teamId !== data.team.id || identity.userId !== data.bot.userId) throw new Error("Slack identity mismatch");
          verified = { teamId: data.team.id, botUserId: data.bot.userId, token: data.bot.token };
          return true;
        },
        success: (_installation, _options, _request, res) => {
          if (!stored || !claim || !verified) { complete(res, 400, failure); return; }
          complete(res, 200, `Slack app installed. Feature-Rec activation is pending operator provisioning.\nInstallation ID: ${claim.id}\nWorkspace ID: ${verified.teamId}\n`);
        },
        failure: (_error, _options, _request, res) => {
          app.log.warn({ event: "SLACK_OAUTH_CALLBACK_FAILED" }, "Slack installation callback failed");
          complete(res, 400, failure);
        },
      });
    } catch {
      app.log.warn({ event: "SLACK_OAUTH_CALLBACK_FAILED" }, "Slack installation callback failed");
      complete(response, 400, failure);
    }
  });

  let cleanup: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (cleanup) return;
    cleanup = cleanupSlackOAuthInstallations(input.db).catch(() => {
      app.log.error({ event: "SLACK_OAUTH_CLEANUP_FAILED" }, "Slack OAuth session cleanup failed");
    }).finally(() => { cleanup = null; });
  }, 60_000);
  timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); await cleanup; });
}
