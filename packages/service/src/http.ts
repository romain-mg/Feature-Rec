import Fastify, { type FastifyRequest, type FastifyServerOptions } from "fastify";
import {
  buildCycleKey,
  ClassifierResultSchema,
  RunStartRequestSchema,
  SlackApprovalPayloadSchema,
  SLACK_GREETING_ACTIVE,
  SLACK_MULTIPLE_CHANNELS_MESSAGE,
  SLACK_NO_CHANNEL_MESSAGE,
  slackSelectedChannelUnavailableMessage,
} from "@feature-rec/core";
import type { ServiceEnv } from "./env";
import {
  describeApproversLine,
  describeChannelSettings,
  describeNotificationsLine,
  effectiveMention,
  formatApproverList,
  joinList,
} from "./channel-settings";
import { ChannelResolutionError, resolveChannel } from "./channels";
import { GitHubClient, GitHubAuthorizationError, GitHubRequestError, type RepositoryAccess } from "./github";
import { GitHubOidcVerifier, OidcAuthenticationError, OidcProviderError, type RunnerIdentity, type RunnerIdentityVerifier } from "./oidc";
import { SlackResolver } from "./slack-resolver";
import { withRetry } from "./retry";
import { SlackClient, isRevokedSlackToken, respondEphemeral, verifySlackSignature } from "./slack";
import type { SlackUsergroup } from "./slack";
import { SlackWorkspaceUnavailableError, type CycleRecord, type CycleStore } from "./storage";

import type { Kysely } from "kysely";
import type { DB } from "./storage/schema";
import { registerSlackOAuthRoutes } from "./slack-oauth-http";

const VIDEO_BODY_LIMIT_BYTES = 500 * 1024 * 1024;

type SlackPayload = {
  type: "block_actions" | "view_submission";
  trigger_id?: string;
  response_url?: string;
  team?: { id?: string };
  user?: { id?: string; username?: string; name?: string };
  actions?: Array<{ action_id?: string; action_ts?: string; value?: string }>;
  view?: {
    id?: string;
    hash?: string;
    private_metadata?: string;
    state?: {
      values?: Record<string, Record<string, { value?: string }>>;
    };
  };
};

type SlackEventEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    user?: string;
    channel?: string;
    event_ts?: string;
  };
};

function param(params: unknown, key: string): string {
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing parameter ${key}`);
  return value;
}

// Slash-command target syntax. With "Escape channels, users, and links"
// enabled on the command, channel/user mentions arrive with stable IDs;
// usergroups and @here/@channel arrive as typed.
const USER_MENTION_RE = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/;
const SUBTEAM_MENTION_RE = /^<!subteam\^(S[A-Z0-9]+)(?:\|[^>]*)?>$/;
const CHANNEL_MENTION_RE = /^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/;

// A user-correctable command mistake: the message goes back ephemerally
// instead of becoming a 500.
class CommandError extends Error {}
class ApprovalError extends Error {}

function retryAuthorization(error: unknown): boolean {
  // Do not hammer a rate-limited provider: longer waits are returned to the
  // caller rather than sleeping inside a request (especially a Slack ack).
  return error instanceof OidcProviderError || (error instanceof GitHubRequestError && error.retryable && !error.retryAfterSeconds);
}

function approvalFailureMessage(error: unknown): string {
  if (error instanceof ApprovalError) return error.message;
  if (error instanceof GitHubAuthorizationError) {
    return "Feature-Rec no longer has access to this repository. Ask an administrator to restore the GitHub App installation, then try again.";
  }
  return "Feature-Rec could not verify approval access. Please try again; if this continues, ask an administrator to check the integration.";
}

const GENERAL_HELP = [
  "Feature-Rec commands:",
  "`/feature-rec channel [#channel]` — select or show the review channel",
  "`/feature-rec mention [approvers|off|@audience…]` — who validation requests mention",
  "`/feature-rec approvers [@channel|@audience…]` — who may approve",
  "`/feature-rec status` — show the selected channel and settings",
  "`/feature-rec help` — show this help",
].join("\n");

const CHANNEL_HELP = [
  "Usage: `/feature-rec channel #channel-name`",
  "Select a public or private channel that @Feature-Rec has joined.",
  "Each channel keeps its own approver and notification settings.",
].join("\n");

const MENTION_HELP = [
  "Usage:",
  "`/feature-rec mention approvers` — mention the channel's current approvers (default)",
  "`/feature-rec mention off` — post validation requests without mentioning anyone",
  "`/feature-rec mention @here|@channel|@usergroup|@user…` — mention a custom audience",
  "`@channel` must be used alone; `@here` may be combined with users or groups.",
].join("\n");

const APPROVERS_HELP = [
  "Usage: `/feature-rec approvers @channel|@usergroup|@user…`",
  "`@channel` allows anyone in the channel to approve.",
  "Otherwise only the listed users and usergroup members may approve.",
].join("\n");

const COMMAND_FAILED = "Something went wrong. Please try again.";

function rawJsonBody(body: unknown): string {
  if (body && typeof body === "object") {
    const raw = (body as { __rawBody?: unknown }).__rawBody;
    if (typeof raw === "string") return raw;
  }
  return "";
}

function classifierSummary(raw: unknown): string {
  const result = ClassifierResultSchema.safeParse(raw);
  if (!result.success) return "";
  return [
    `Classifier: ${result.data.frontendVisible ? "frontend-visible" : "not frontend-visible"}`,
    `Confidence: ${result.data.confidence}`,
    result.data.reason,
    result.data.userImpact,
  ]
    .filter(Boolean)
    .join("\n");
}

function bodyAttemptId(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const value = (body as { attemptId?: unknown }).attemptId;
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function headerAttemptId(header: unknown): string | undefined {
  return typeof header === "string" && header ? header : undefined;
}

export function buildServer(input: {
  env: ServiceEnv;
  store: CycleStore;
  slackOAuthDb?: Kysely<DB>;
  logger?: FastifyServerOptions["logger"];
  github?: GitHubClient;
  oidc?: RunnerIdentityVerifier;
  slackClientFactory?: (token: string) => SlackClient;
  respondEphemeral?: typeof respondEphemeral;
}) {
  const env = input.env;
  const store = input.store;
  const github = input.github ?? new GitHubClient(env);
  const oidc = input.oidc ?? new GitHubOidcVerifier(env);
  const slackResolver = new SlackResolver(store, env.slackTokenEncryptionKey, input.slackClientFactory);
  const ephemeral = input.respondEphemeral ?? respondEphemeral;
  const requestSerializer = (request: FastifyRequest) => ({
    method: request.method, url: request.url.split("?")[0],
    remoteAddress: request.ip, remotePort: request.socket.remotePort,
  });
  const app = Fastify({ logger: input.logger === false ? false : {
    ...(typeof input.logger === "object" ? input.logger : {}),
    serializers: {
      ...(typeof input.logger === "object" ? input.logger.serializers : {}),
      // Request logging happens before hooks; never log OAuth code/state queries.
      req: requestSerializer,
    },
  } });
  // Fastify's default 404 logs and echoes raw URLs independently of serializers.
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not_found" }));
  if (env.slackOAuth && input.slackOAuthDb) {
    registerSlackOAuthRoutes(app, { db: input.slackOAuthDb, config: env.slackOAuth,
      encryptionKey: env.slackTokenEncryptionKey, slackClientFactory: input.slackClientFactory });
  }

  const runnerIdentities = new WeakMap<FastifyRequest, RunnerIdentity>();
  async function authenticateRunner(request: FastifyRequest): Promise<void> {
    // Verify at arrival, before body parsing/buffering. A valid token must not
    // expire merely because an authenticated video upload takes several minutes.
    const identity = await withRetry(() => oidc.verify(request.headers.authorization), 3, 200, retryAuthorization);
    runnerIdentities.set(request, identity);
  }

  // Use the verified runner identity to authorize its tenant/cycle and obtain
  // repository-scoped GitHub App access. Request bodies never supply authority.
  async function authorizeRunnerAndGetRepositoryAccess(request: FastifyRequest, cycleId?: string) {
    const identity = runnerIdentities.get(request);
    if (!identity) throw new OidcAuthenticationError();
    if (!/^[0-9]+$/.test(identity.repositoryOwnerId) || BigInt(identity.repositoryOwnerId) > 9223372036854775807n) {
      throw new GitHubAuthorizationError();
    }
    const installation = await store.getEnabledGitHubInstallationByAccountId(identity.repositoryOwnerId);
    if (!installation) throw new GitHubAuthorizationError();
    if (cycleId) {
      const cycle = await store.getCycle(cycleId);
      if (!cycle || cycle.tenantId !== installation.tenantId || cycle.repositoryId !== identity.repositoryId) {
        throw new GitHubAuthorizationError();
      }
    }
    const access = await withRetry(() => github.authorizeRepository(installation.installationId, identity.repositoryId), 3, 200, retryAuthorization);
    if (access.repositoryId !== identity.repositoryId || access.repositoryOwnerId !== identity.repositoryOwnerId) {
      throw new GitHubAuthorizationError();
    }
    request.log.info({
      category: "runner_authorized", tenantId: installation.tenantId,
      repositoryId: identity.repositoryId, githubAccountId: installation.githubAccountId,
      installationId: installation.installationId,
    }, "Runner repository authorized");
    return { tenantId: installation.tenantId, repositoryId: identity.repositoryId, access };
  }

  // Provider failures remain retryable even if access-token creation succeeded
  // and a later PR/check request failed. Never return tenant/provider details.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof OidcAuthenticationError) {
      request.log.warn({ category: "oidc_invalid", reason: error.reason }, "Runner authentication rejected");
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (error instanceof OidcProviderError || (error instanceof GitHubRequestError && error.retryable)) {
      request.log.warn({ category: error instanceof OidcProviderError ? "oidc_unavailable" : "github_unavailable" }, "Provider temporarily unavailable");
      return reply.header("retry-after", String(error instanceof GitHubRequestError ? Math.max(10, error.retryAfterSeconds ?? 0) : 10)).code(503).send({ error: "authorization_temporarily_unavailable" });
    }
    if (error instanceof GitHubAuthorizationError) {
      request.log.warn({ category: "repository_forbidden" }, "Repository authorization rejected");
      return reply.code(403).send({ error: "forbidden" });
    }
    if (error instanceof GitHubRequestError) {
      request.log.error({ category: "github_request_failed", status: error.status }, "GitHub integration request failed");
      return reply.code(502).send({ error: "github_request_failed" });
    }
    return reply.send(error);
  });

  async function authorizeCycle(cycle: CycleRecord): Promise<RepositoryAccess> {
    const installation = await store.getGitHubInstallationByTenantId(cycle.tenantId);
    if (!installation?.enabled) throw new GitHubAuthorizationError();
    const access = await withRetry(() => github.authorizeRepository(installation.installationId, cycle.repositoryId), 3, 200, retryAuthorization);
    if (access.repositoryId !== cycle.repositoryId || access.repositoryOwnerId !== installation.githubAccountId) {
      throw new GitHubAuthorizationError();
    }
    return access;
  }

  async function finalizeCycle(cycle: CycleRecord, state: "superseded", detail: string): Promise<void> {
    const resolvedSlack = await slackResolver.forTenant(cycle.tenantId);
    if (resolvedSlack) await withRetry(() => resolvedSlack.client.finalize(cycle, state, detail));
  }

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const rawBody = String(body);
        const parsed = rawBody ? JSON.parse(rawBody) : {};
        if (parsed && typeof parsed === "object") {
          Object.defineProperty(parsed, "__rawBody", {
            value: rawBody,
            enumerable: false,
          });
        }
        done(null, parsed);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/runs/start", { onRequest: authenticateRunner }, async (request, reply) => {
    const authorized = await authorizeRunnerAndGetRepositoryAccess(request);
    const { tenantId, repositoryId, access } = authorized;
    const parsed = RunStartRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid start request" });
    const start = parsed.data;
    const pr = await withRetry(() => github.getPullRequest(access, start.prNumber), 3, 200, retryAuthorization);
    if (pr.state !== "open") return { skipped: true, reason: "closed" };
    if (pr.draft) return { skipped: true, reason: "draft" };
    if (pr.headSha !== start.headSha) return { skipped: true, reason: "stale_head" };
    const cycleKey = buildCycleKey({ tenantId, repositoryId, ...start });
    const result = await store.startCycle({
      ...start, tenantId, repositoryId, cycleKey,
      prTitle: pr.prTitle, prAuthor: pr.prAuthor, owner: access.owner, repo: access.repo,
    });

    // Duplicate start for the same head: clean no-op exit. No check run is
    // created and no attemptId is issued, so this runner holds no ownership.
    // (Duplicates always have an empty superseded[], so no cleanup is skipped.)
    if (!result.created) {
      return { duplicate: true, cycleId: result.cycle.id, cycleKey };
    }

    // Finalize the superseded losers. Fire-and-forget, best-effort by design:
    // cleanup of old cycles must never delay or fail the active runner's /start
    // response. The committed DB status (superseded) is authoritative; each
    // cycle's errors are caught and logged, so the Promise.all cannot reject.
    void Promise.all(
      result.superseded.map(async (oldCycle) => {
        // GitHub and Slack repairs are independent: neither gates the other,
        // so a GitHub outage can't leave live Slack buttons (or vice versa).
        const [gh, sl] = await Promise.allSettled([
          withRetry(() =>
            github.updateCheckRun(oldCycle, {
              conclusion: "neutral",
              output: {
                title: "Feature-Rec: superseded",
                summary: `Superseded by a newer PR head SHA: ${start.headSha}.`,
              },
            }, access),
          ),
          finalizeCycle(oldCycle, "superseded", "A newer commit started a fresh validation cycle."),
        ]);
        if (gh.status === "rejected") {
          request.log.warn(
            { err: gh.reason, supersededCycleId: oldCycle.id },
            "best-effort check-run neutralize of superseded cycle failed",
          );
        }
        if (sl.status === "rejected") {
          request.log.warn(
            { err: sl.reason, supersededCycleId: oldCycle.id },
            "best-effort Slack finalize of superseded cycle failed",
          );
        }
      }),
    );

    // Advisory onboarding flag: inspect the explicit route and live membership
    // without initializing a route. The runner can then fail frontend-visible
    // PRs before rendering while auto-accepted PRs stay unaffected. Advisory
    // only: video-time resolution stays authoritative because routes and
    // membership can change mid-cycle, and it retains the missed-event fallback.
    //
    // Advisory means it must never fail the start: a Slack outage here would
    // otherwise strand the cycle as `analyzing` with no attemptId returned, and
    // every retry would exit as a duplicate. Unknown → omit the flag and let
    // video-time resolution decide.
    const onboarded = await tenantHasChannels(tenantId).catch((err: unknown) => {
      request.log.warn({ err }, "advisory onboarding check failed; deferring to video-time resolution");
      return undefined;
    });

    // Takeover of a previously `failed` cycle: reuse its existing check run
    // (set it back to in_progress) instead of creating a second one, so a
    // re-run recovers a red check rather than exiting green over a red run.
    if (result.cycle.checkRunId) {
      try {
        await withRetry(() =>
          github.updateCheckRun(result.cycle, {
            status: "in_progress",
            output: {
              title: "Feature-Rec: analyzing",
              summary: "Re-running Feature-Rec after a previous failure.",
            },
          }, access),
        );
      } catch (error) {
        await store.transitionRunnerStatus({
          tenantId, repositoryId, cycleId: result.cycle.id,
          attemptId: result.attemptId, from: ["analyzing"], to: "failed",
        });
        throw error;
      }
      return {
        cycleId: result.cycle.id,
        cycleKey,
        checkRunId: result.cycle.checkRunId,
        attemptId: result.attemptId,
        onboarded,
      };
    }

    // Fresh create: only the creator creates the check run, then attaches it atomically.
    // If GitHub rejects creation, release this attempt by marking it failed so
    // a same-head workflow rerun can take over instead of exiting as a duplicate.
    let checkRunId: number;
    try {
      checkRunId = await github.createCheckRun({ ...start, cycleKey }, access);
    } catch (err) {
      await store.transitionRunnerStatus({
        tenantId, repositoryId,
        cycleId: result.cycle.id,
        attemptId: result.attemptId,
        from: ["analyzing"],
        to: "failed",
      });
      throw err;
    }
    const statusAfterAttach = await store.attachCheckRun(result.cycle.id, checkRunId);
    if (statusAfterAttach === "superseded") {
      // A newer head superseded us between the transaction and the attach; its
      // neutralize loop saw check_run_id = null, so neutralize what we created.
      // Best-effort with retry: a transient PATCH failure must not 500 this
      // request — the runner's start already effectively lost (its results will
      // no-op as stale), and a retried /start would exit duplicate without
      // repairing. Now that the ID is attached, a later superseding head can
      // also see and neutralize it, so a dropped repair here isn't permanent.
      try {
        await withRetry(() =>
          github.updateCheckRun(
            { checkRunId },
            {
              conclusion: "neutral",
              output: {
                title: "Feature-Rec: superseded",
                summary: "Superseded by a newer PR head SHA before validation started.",
              },
            }, access),
        );
      } catch (err) {
        request.log.warn(
          { err, cycleId: result.cycle.id, checkRunId },
          "best-effort neutralize of own superseded check run failed",
        );
      }
    }

    return {
      cycleId: result.cycle.id,
      cycleKey,
      checkRunId,
      attemptId: result.attemptId,
      onboarded,
    };
  });

  // Whether video delivery could resolve a channel now, without mutating the
  // route. A sole membership is usable through video delivery's missed-event
  // fallback, while join events remain the primary initialization path.
  async function tenantHasChannels(tenantId: string): Promise<boolean> {
    const resolvedSlack = await slackResolver.forTenant(tenantId);
    if (!resolvedSlack) return false;
    const channelIds = await resolvedSlack.client.listBotChannels();
    const selectedChannelId = await store.getSelectedChannelId(resolvedSlack.workspace.teamId);
    return selectedChannelId ? channelIds.includes(selectedChannelId) : channelIds.length === 1;
  }

  app.post("/api/runs/:cycleId/accepted", { onRequest: authenticateRunner }, async (request, reply) => {
    const authorized = await authorizeRunnerAndGetRepositoryAccess(request, param(request.params, "cycleId"));
    const { tenantId, repositoryId, access } = authorized;
    const attemptId = bodyAttemptId(request.body);
    if (!attemptId) return reply.code(400).send({ error: "attemptId is required" });
    const cycle = await store.transitionRunnerStatus({
        tenantId, repositoryId,
      cycleId: param(request.params, "cycleId"),
      attemptId,
      from: ["analyzing"],
      to: "accepted",
    });
    if (!cycle) return reply.send({ ok: false, stale: true });
    await withRetry(() =>
      github.updateCheckRun(cycle, {
        conclusion: "success",
        output: {
          title: "Feature-Rec: accepted",
          summary: classifierSummary(request.body) || "No frontend-visible validation needed.",
        },
      }, access),
    );
    return { ok: true };
  });

  app.post("/api/runs/:cycleId/failed", { onRequest: authenticateRunner }, async (request, reply) => {
    const authorized = await authorizeRunnerAndGetRepositoryAccess(request, param(request.params, "cycleId"));
    const { tenantId, repositoryId, access } = authorized;
    const body = request.body as { message?: string } | undefined;
    const attemptId = bodyAttemptId(request.body);
    if (!attemptId) return reply.code(400).send({ error: "attemptId is required" });
    const cycle = await store.transitionRunnerStatus({
        tenantId, repositoryId,
      cycleId: param(request.params, "cycleId"),
      attemptId,
      from: ["analyzing", "pending_validation"],
      to: "failed",
    });
    if (!cycle) return reply.send({ ok: false, stale: true });
    await withRetry(() =>
      github.updateCheckRun(cycle, {
        conclusion: "failure",
        output: {
          title: "Feature-Rec: failed",
          summary: body?.message ?? "Feature-Rec failed.",
        },
      }, access),
    );
    return { ok: true };
  });

  app.post(
    "/api/runs/:cycleId/video",
    { onRequest: authenticateRunner, bodyLimit: VIDEO_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const authorized = await authorizeRunnerAndGetRepositoryAccess(request, param(request.params, "cycleId"));
      const { tenantId, repositoryId, access } = authorized;
      const video = Buffer.isBuffer(request.body) ? request.body : Buffer.from([]);
      if (video.byteLength === 0) return reply.code(400).send({ error: "empty video body" });
      const attemptId = headerAttemptId(request.headers["x-feature-rec-attempt"]);
      if (!attemptId) return reply.code(400).send({ error: "attemptId is required" });

      // Transition first (guards against stale/duplicate runners and gives
      // first-writer-wins idempotency), then run side effects.
      const cycle = await store.transitionRunnerStatus({
        tenantId, repositoryId,
        cycleId: param(request.params, "cycleId"),
        attemptId,
        from: ["analyzing"],
        to: "pending_validation",
      });
      if (!cycle) return reply.send({ ok: false, stale: true });

      // Once delivery owns the pending cycle, settle any caught failure here.
      // Recovery must not depend on the runner making another HTTP request.
      let slackClient: SlackClient | undefined;
      let slackMessage: { channel: string; ts: string } | undefined;
      try {
        const resolvedSlack = await slackResolver.forTenant(tenantId);
        if (!resolvedSlack) throw new SlackWorkspaceUnavailableError();
        slackClient = resolvedSlack.client;
        const resolved = await resolveChannel(store, slackClient, resolvedSlack.workspace.teamId);

        if (resolved.initializedRoute) {
          await greetJoinedChannel(resolved.teamId, resolved.channelId, slackClient).catch((err: unknown) => {
            request.log.warn(
              { err, teamId: resolved.teamId, channelId: resolved.channelId },
              "missed-event fallback greeting failed",
            );
          });
        }
        await withRetry(() =>
          github.updateCheckRun(cycle, {
            status: "in_progress",
            output: {
              title: "Feature-Rec: pending validation",
              summary: "Frontend-visible change rendered and sent to Slack for validation.",
            },
          }, access),
        );

        const settings = await withRetry(() =>
          store.getChannelSettings(resolved.teamId, resolved.channelId),
        );

        await slackClient.uploadVideo(cycle, resolved.channelId, video, access.fullName);
        const message = await slackClient.postValidation(
          cycle,
          resolved.channelId,
          effectiveMention(settings),
          access.fullName,
        );
        slackMessage = message;
        // Persisting the same Slack coordinates is idempotent. Retry so a
        // transient DB failure does not leave a live validation message untracked.
        const statusAfter = await withRetry(() =>
          store.attachSlackMessage(cycle.id, message.channel, message.ts),
        );
        if (statusAfter === "superseded") {
          // Superseded after the transition but before the Slack post landed:
          // finalize the message we just posted so it can't strand in Slack.
          // Retried: nobody else will ever repair this message (the superseder's
          // cleanup already ran and saw no coordinates), and chat.update is idempotent.
          await withRetry(() =>
            resolvedSlack.client.finalize(
              { ...cycle, slackChannelId: message.channel, slackMessageTs: message.ts },
              "superseded",
              "A newer commit started a fresh validation cycle.",
            ),
          );
        }
        return { ok: true, channel: message.channel, ts: message.ts };
      } catch (err) {
        const unavailable = err instanceof SlackWorkspaceUnavailableError || isRevokedSlackToken(err);
        const channelError = err instanceof ChannelResolutionError;
        request.log.warn({ err, cycleId: cycle.id, tenantId, repositoryId }, "Video delivery failed");
        const message = unavailable
          ? "The Slack workspace was uninstalled or its token was revoked during delivery. Restore the Slack integration and rerun Feature-Rec."
          : channelError
            ? err.message
            : "Feature-Rec could not complete video delivery. Rerun the workflow; if this continues, ask an administrator to check the service logs.";
        const failed = await store.transitionRunnerStatus({
          tenantId, repositoryId,
          cycleId: cycle.id,
          attemptId,
          from: ["pending_validation"],
          to: "failed",
        });
        // A concurrent approval, supersession, or new attempt owns its result.
        // A superseder may have seen no coordinates if attachment failed, so
        // repair our known post without overwriting another decision's message.
        if (!failed) {
          if (slackClient && slackMessage) {
            const client = slackClient;
            const postedCycle = { ...cycle, slackChannelId: slackMessage.channel, slackMessageTs: slackMessage.ts };
            await settleSideEffects(cycle.id, [["slack superseded delivery", withRetry(async () => {
              const current = await store.getCycle(cycle.id);
              if (current?.status === "superseded") {
                await client.finalize(postedCycle, "superseded", "A newer commit started a fresh validation cycle.");
              }
            })]]);
          }
          return reply.send({ ok: false, stale: true });
        }
        // Reuse only this request's grant, leaving time for the bounded GitHub
        // retries. Long Slack delivery may require a fresh grant; its failure
        // must not prevent independent Slack cleanup.
        const failureAccess = access.expiresAt > Date.now() + 60_000
          ? Promise.resolve(access)
          : authorizeCycle(failed);
        const effects: Array<[string, Promise<unknown>]> = [
          ["github delivery failure", failureAccess.then((repositoryAccess) =>
            withRetry(() =>
              github.updateCheckRun(failed, {
                conclusion: "failure",
                output: {
                  title: unavailable
                    ? "Feature-Rec: Slack integration unavailable"
                    : channelError ? "Feature-Rec: no Slack review channel" : "Feature-Rec: video delivery failed",
                  summary: message,
                },
              }, repositoryAccess),
            ),
          )],
        ];
        if (slackClient && slackMessage) {
          const client = slackClient;
          const postedCycle = { ...failed, slackChannelId: slackMessage.channel, slackMessageTs: slackMessage.ts };
          effects.push(["slack delivery failure", withRetry(() => client.finalize(postedCycle, "failed", message))]);
        }
        await settleSideEffects(failed.id, effects);
        if (err instanceof GitHubRequestError && err.retryable) {
          reply.header("retry-after", String(Math.max(10, err.retryAfterSeconds ?? 0)));
        }
        // settled describes the committed cycle. Provider repair can fail;
        // a workflow rerun can now take over this failed cycle and retry it.
        return reply
          .code(unavailable || channelError ? 422 : err instanceof GitHubRequestError ? (err.retryable ? 503 : 502) : 500)
          .send({ ok: false, error: unavailable ? "slack_unavailable" : channelError ? "no_slack_channel" : "video_delivery_failed", message, settled: true });
      }
    },
  );

  app.post("/api/slack/interactivity", async (request, reply) => {
    const rawBody = String(request.body ?? "");
    const signatureOk = verifySlackSignature({
      signingSecret: env.slackSigningSecret,
      timestamp: request.headers["x-slack-request-timestamp"] as string | undefined,
      signature: request.headers["x-slack-signature"] as string | undefined,
      rawBody,
    });
    if (!signatureOk) return reply.code(401).send({ error: "invalid slack signature" });

    const payloadParam = new URLSearchParams(rawBody).get("payload");
    if (!payloadParam) return reply.code(400).send({ error: "missing payload" });
    const payload = JSON.parse(payloadParam) as SlackPayload;
    if (payload.type === "block_actions") {
      void handleBlockAction(payload).catch((err) => app.log.error(err));
      return reply.send("");
    }
    if (payload.type === "view_submission") {
      const comment = extractModalComment(payload);
      if (!comment.trim()) {
        return reply.send({
          response_action: "errors",
          errors: { comment: "Please describe what needs to change." },
        });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const prepared = await Promise.race([
          prepareViewSubmission(payload),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ApprovalError("Approval access checks are taking too long. Your comment is preserved; please try again.")), 2_000);
          }),
        ]);
        void handleViewSubmission(prepared, comment).catch((err) => app.log.error(err));
        return reply.send("");
      } catch (error) {
        app.log.warn({ err: error, teamId: payload.team?.id, viewId: payload.view?.id }, "Slack approval preparation failed");
        return reply.send({ response_action: "errors", errors: { comment: approvalFailureMessage(error) } });
      } finally {
        clearTimeout(timer);
      }
    }

    return reply.send("");
  });

  app.post("/api/slack/events", async (request, reply) => {
    const signatureOk = verifySlackSignature({
      signingSecret: env.slackSigningSecret,
      timestamp: request.headers["x-slack-request-timestamp"] as string | undefined,
      signature: request.headers["x-slack-signature"] as string | undefined,
      rawBody: rawJsonBody(request.body),
    });
    if (!signatureOk) return reply.code(401).send({ error: "invalid slack signature" });

    const body = request.body as SlackEventEnvelope;
    if (body.type === "url_verification") return reply.send({ challenge: body.challenge ?? "" });
    if (body.type !== "event_callback") return reply.send({ ok: true });

    const event = body.event ?? {};
    const teamId = body.team_id;
    if (!teamId) return reply.send({ ok: true });
    if (event.type === "app_uninstalled" || event.type === "tokens_revoked") {
      const workspace = await store.getSlackWorkspaceByTeamId(teamId);
      if (!workspace) return reply.send({ ok: true });
      try {
        if (!(await slackResolver.tokenIsRevoked(workspace))) {
          request.log.info({ category: "slack_lifecycle_stale", teamId }, "Lifecycle event does not revoke the current Slack credential");
          return reply.send({ ok: true });
        }
      } catch (err) {
        // The resolver strips provider and decryption details before throwing.
        request.log.warn({ err, category: "slack_lifecycle_unverified", teamId }, "Slack lifecycle cleanup could not verify current credentials");
        return reply.header("retry-after", "10").code(503).send({ error: "slack_lifecycle_temporarily_unavailable" });
      }
      try {
        await store.deleteSlackWorkspace(teamId, workspace.botTokenCiphertext);
      } catch (err) {
        // Database errors can contain SQL values; retain only a diagnostic code,
        // never transaction details that could include the checked ciphertext.
        const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
        request.log.warn({
          category: "slack_lifecycle_cleanup_failed", teamId,
          errorCode: typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined,
        }, "Slack lifecycle workspace deletion failed");
        return reply.header("retry-after", "10").code(503).send({ error: "slack_lifecycle_temporarily_unavailable" });
      }
      return reply.send({ ok: true });
    }
    if (event.type !== "member_joined_channel" || !event.user || !event.channel) return reply.send({ ok: true });
    // Filter human joins from signed team metadata before decrypting credentials.
    const workspace = await slackResolver.workspaceForTeam(teamId);
    if (!workspace || event.user !== workspace.botUserId) return reply.send({ ok: true });
    const channelId = event.channel;

    // The first observed join wins under the per-team route lock. Later joins
    // are deliberately silent and do not persist membership state.
    const initialized = await store.initializeTeamChannelRoute({ teamId, channelId });
    if (initialized.initializedRoute && (await isFirstEventDelivery(body.event_id))) {
      void (async () => {
        await greetJoinedChannel(teamId, channelId, slackResolver.forWorkspace(workspace));
      })().catch((err: unknown) => app.log.error({ err, teamId, channelId }, "Slack greeting failed"));
    }
    return reply.send({ ok: true });
  });

  // Route initialization is idempotent; the first greeting is not. Slack
  // retries therefore dedupe that side effect on the globally unique event ID.
  async function isFirstEventDelivery(eventId: string | undefined): Promise<boolean> {
    if (!eventId) return true;
    return store.recordProcessedInteraction(`slack-event:${eventId}`, "slack-event");
  }

  app.post("/api/slack/commands", async (request, reply) => {
    const rawBody = String(request.body ?? "");
    const signatureOk = verifySlackSignature({
      signingSecret: env.slackSigningSecret,
      timestamp: request.headers["x-slack-request-timestamp"] as string | undefined,
      signature: request.headers["x-slack-signature"] as string | undefined,
      rawBody,
    });
    if (!signatureOk) return reply.code(401).send({ error: "invalid slack signature" });

    const form = new URLSearchParams(rawBody);
    const teamId = form.get("team_id") ?? "";
    const channelId = form.get("channel_id") ?? "";
    const userId = form.get("user_id") ?? "";
    const responseUrl = form.get("response_url") ?? "";
    if (!teamId || !channelId || !userId || !responseUrl) {
      return reply.code(400).send({ error: "malformed command payload" });
    }

    const [subcommand, ...args] = (form.get("text") ?? "").trim().split(/\s+/).filter(Boolean);
    // Slack requires the command ack within three seconds. All command work,
    // including Slack API lookups and channel reconciliation, runs after this
    // empty 200 and delivers its result through the signed response_url.
    reply.send("");
    void handleCommand({ teamId, channelId, userId, responseUrl, subcommand, args });
    return reply;
  });

  async function handleCommand(input: {
    teamId: string;
    channelId: string;
    userId: string;
    responseUrl: string;
    subcommand: string | undefined;
    args: string[];
  }): Promise<void> {
    let text: string;
    try {
      const resolvedSlack = await slackResolver.forTeam(input.teamId);
      if (!resolvedSlack) throw new CommandError("Feature-Rec is not enabled for this Slack workspace.");
      const botChannelIds = await resolvedSlack.client.listBotChannels();
      const context = { ...input, botChannelIds, slack: resolvedSlack.client };
      if (input.subcommand === "channel") {
        text = await channelCommand(context);
      } else if (input.subcommand === "mention") {
        text = await mentionCommand(context);
      } else if (input.subcommand === "approvers") {
        text = await approversCommand(context);
      } else if (input.subcommand === "status") {
        text = await statusCommand(context);
      } else {
        // Absent subcommand, `help`, and unknown subcommands share general help.
        text = GENERAL_HELP;
      }
    } catch (err) {
      if (err instanceof CommandError) {
        text = err.message;
      } else {
        app.log.error(
          { err, teamId: input.teamId, channelId: input.channelId },
          "Slack command failed",
        );
        text = COMMAND_FAILED;
      }
    }

    await ephemeral(input.responseUrl, text).catch((err: unknown) => {
      app.log.warn(
        { err, teamId: input.teamId, channelId: input.channelId },
        "Slack command ephemeral reply failed",
      );
    });
  }

  type CommandContext = {
    teamId: string;
    channelId: string;
    userId: string;
    args: string[];
    botChannelIds: string[];
    slack: SlackClient;
  };

  async function channelCommand(input: CommandContext): Promise<string> {
    if (input.args.length === 0) {
      const selectedChannelId = await store.getSelectedChannelId(input.teamId);
      if (!selectedChannelId) {
        return [`No review channel is selected.`, CHANNEL_HELP].join("\n");
      }
      const present = input.botChannelIds.includes(selectedChannelId);
      const lines = [
        `Selected review channel: <#${selectedChannelId}> (${present ? "available" : "unavailable"}).`,
        CHANNEL_HELP,
      ];
      if (!present) lines.push(slackSelectedChannelUnavailableMessage(selectedChannelId));
      return lines.join("\n");
    }
    if (input.args.length !== 1) {
      throw new CommandError(CHANNEL_HELP);
    }
    const target = CHANNEL_MENTION_RE.exec(input.args[0]);
    if (!target) throw new CommandError(CHANNEL_HELP);
    const channelId = target[1];
    if (!input.botChannelIds.includes(channelId)) {
      throw new CommandError(`Invite @Feature-Rec to <#${channelId}>, then try again.`);
    }
    await store.selectTeamChannel({ teamId: input.teamId, channelId });
    const settings = await store.getChannelSettings(input.teamId, channelId);
    return [
      `Feature-Rec videos will now be sent to <#${channelId}>.`,
      describeChannelSettings(settings),
    ].join("\n");
  }

  function missingSelectedChannelMessage(botChannelIds: string[]): string {
    if (botChannelIds.length === 0) return SLACK_NO_CHANNEL_MESSAGE;
    if (botChannelIds.length > 1) return SLACK_MULTIPLE_CHANNELS_MESSAGE;
    return "No review channel is selected. Run `/feature-rec channel #channel-name` first.";
  }

  // Reads (status/help) only need a selected channel id. Writes still require
  // the bot to be present so membership checks and delivery stay coherent.
  async function requireSelectedChannelId(input: CommandContext): Promise<string> {
    const selectedChannelId = await store.getSelectedChannelId(input.teamId);
    if (!selectedChannelId) {
      throw new CommandError(missingSelectedChannelMessage(input.botChannelIds));
    }
    return selectedChannelId;
  }

  async function selectedCommandChannel(input: CommandContext): Promise<string> {
    const selectedChannelId = await requireSelectedChannelId(input);
    if (!input.botChannelIds.includes(selectedChannelId)) {
      throw new CommandError(slackSelectedChannelUnavailableMessage(selectedChannelId));
    }
    return selectedChannelId;
  }

  function assertGuardedSettingWrite(written: boolean): void {
    if (!written) {
      throw new CommandError(
        "The selected Feature-Rec channel changed while the command was running. Please try again.",
      );
    }
  }

  async function confirmChannelSettings(
    teamId: string,
    channelId: string,
    written: boolean,
    headline: string,
  ): Promise<string> {
    assertGuardedSettingWrite(written);
    const settings = await store.getChannelSettings(teamId, channelId);
    return [headline, describeChannelSettings(settings)].join("\n");
  }

  async function mentionCommand(input: CommandContext): Promise<string> {
    if (input.args.length === 0) {
      const channelId = await store.getSelectedChannelId(input.teamId);
      if (!channelId) {
        return [missingSelectedChannelMessage(input.botChannelIds), MENTION_HELP].join("\n");
      }
      const settings = await store.getChannelSettings(input.teamId, channelId);
      const lines = [`For <#${channelId}>:`, describeNotificationsLine(settings), MENTION_HELP];
      if (!input.botChannelIds.includes(channelId)) {
        lines.push(slackSelectedChannelUnavailableMessage(channelId));
      }
      return lines.join("\n");
    }

    const channelId = await selectedCommandChannel(input);
    if (input.args.some((token) => token === "approvers" || token === "off")) {
      if (input.args.length !== 1) {
        throw new CommandError(
          "`approvers` and `off` must be used alone: `/feature-rec mention approvers` or `/feature-rec mention off`.",
        );
      }
      const mode = input.args[0] as "approvers" | "off";
      const written = await store.setSelectedChannelMentionSetting({
        teamId: input.teamId,
        expectedChannelId: channelId,
        mention: { mode },
        updatedBy: input.userId,
      });
      return confirmChannelSettings(
        input.teamId,
        channelId,
        written,
        mode === "off"
          ? `Validation requests in <#${channelId}> will not mention anyone.`
          : `Validation notifications in <#${channelId}> now follow approvers.`,
      );
    }

    if (
      input.args.length > 1 &&
      input.args.some((token) => token === "@channel" || token === "<!channel>")
    ) {
      throw new CommandError("Use @channel by itself: `/feature-rec mention @channel`.");
    }

    const targets = await resolveTargets(input.slack, input.args, "mention");
    await validateTargetMembership(input.slack, channelId, targets.concreteUserIds, "mentions");
    const audience = targets.rendered.join(" ");
    const written = await store.setSelectedChannelMentionSetting({
      teamId: input.teamId,
      expectedChannelId: channelId,
      mention: { mode: "custom", audience },
      updatedBy: input.userId,
    });
    return confirmChannelSettings(
      input.teamId,
      channelId,
      written,
      `Validation requests in <#${channelId}> will mention ${audience}.`,
    );
  }

  async function approversCommand(input: CommandContext): Promise<string> {
    if (input.args.length === 0) {
      const channelId = await store.getSelectedChannelId(input.teamId);
      if (!channelId) {
        return [missingSelectedChannelMessage(input.botChannelIds), APPROVERS_HELP].join("\n");
      }
      const settings = await store.getChannelSettings(input.teamId, channelId);
      const lines = [`For <#${channelId}>:`, describeApproversLine(settings), APPROVERS_HELP];
      if (!input.botChannelIds.includes(channelId)) {
        lines.push(slackSelectedChannelUnavailableMessage(channelId));
      }
      return lines.join("\n");
    }

    const channelId = await selectedCommandChannel(input);
    if (input.args.some((token) => token === "@channel" || token === "<!channel>")) {
      if (input.args.length > 1) {
        throw new CommandError("Use @channel by itself: `/feature-rec approvers @channel`.");
      }
      const written = await store.setSelectedChannelApprovers({
        teamId: input.teamId,
        expectedChannelId: channelId,
        approvers: null,
        updatedBy: input.userId,
      });
      return confirmChannelSettings(
        input.teamId,
        channelId,
        written,
        `Everyone in <#${channelId}> can now approve.`,
      );
    }
    const targets = await resolveTargets(input.slack, input.args, "approver");
    await validateTargetMembership(input.slack, channelId, targets.concreteUserIds, "approvers");
    const written = await store.setSelectedChannelApprovers({
      teamId: input.teamId,
      expectedChannelId: channelId,
      approvers: targets.storedIds,
      updatedBy: input.userId,
    });
    return confirmChannelSettings(
      input.teamId,
      channelId,
      written,
      `Only ${joinList(targets.rendered)} can approve in <#${channelId}>.`,
    );
  }

  async function resolveTargets(
    slack: SlackClient,
    tokens: string[],
    kind: "mention" | "approver",
  ): Promise<{ rendered: string[]; storedIds: string[]; concreteUserIds: string[] }> {
    const rendered = new Set<string>();
    const storedIds = new Set<string>();
    const concreteUserIds = new Set<string>();
    let usergroups: SlackUsergroup[] | null = null;
    for (const token of tokens) {
      if (kind === "mention" && (token === "@here" || token === "<!here>")) {
        rendered.add("<!here>");
        continue;
      }
      if (kind === "mention" && (token === "@channel" || token === "<!channel>")) {
        rendered.add("<!channel>");
        continue;
      }
      const user = USER_MENTION_RE.exec(token);
      if (user) {
        rendered.add(`<@${user[1]}>`);
        storedIds.add(user[1]);
        concreteUserIds.add(user[1]);
        continue;
      }
      const subteam = SUBTEAM_MENTION_RE.exec(token);
      usergroups ??= await slack.listUsergroups();
      const handle = token.replace(/^@/, "");
      const group = subteam
        ? usergroups.find((candidate) => candidate.id === subteam[1])
        : usergroups.find((candidate) => candidate.handle === handle);
      if (!group) {
        const help =
          kind === "mention"
            ? "Use @here, @channel, a usergroup handle, or user mentions."
            : "Use @channel, usergroup handles, or user mentions.";
        throw new CommandError(
          `Unknown ${kind === "mention" ? "mention target" : "approver"} ${token}. ${help}`,
        );
      }
      const members = await slack.listUsergroupMembers(group.id);
      if (members.length === 0) {
        throw new CommandError(`Usergroup @${group.handle} has no users and cannot be selected.`);
      }
      rendered.add(`<!subteam^${group.id}|@${group.handle}>`);
      storedIds.add(group.id);
      members.forEach((member) => concreteUserIds.add(member));
    }
    return {
      rendered: [...rendered],
      storedIds: [...storedIds],
      concreteUserIds: [...concreteUserIds],
    };
  }

  async function validateTargetMembership(
    slack: SlackClient,
    channelId: string,
    userIds: string[],
    setting: "mentions" | "approvers",
  ): Promise<void> {
    if (userIds.length === 0) return;
    const channelMembers = new Set(await slack.listChannelMembers(channelId));
    const missing = userIds.filter((userId) => !channelMembers.has(userId));
    if (missing.length === 0) return;
    const visible = missing.slice(0, 5).map((userId) => `<@${userId}>`).join(", ");
    const remainder = missing.length > 5 ? ` and ${missing.length - 5} more` : "";
    const verb = missing.length === 1 ? "is not a member" : "are not members";
    throw new CommandError(
      `Cannot update ${setting} for <#${channelId}>: ${visible}${remainder} ${verb} of that channel.`,
    );
  }

  async function statusCommand(input: CommandContext): Promise<string> {
    const selectedChannelId = await store.getSelectedChannelId(input.teamId);
    if (!selectedChannelId) {
      if (input.botChannelIds.length > 1) return SLACK_MULTIPLE_CHANNELS_MESSAGE;
      if (input.botChannelIds.length === 1) {
        return `Feature-Rec is already present in <#${input.botChannelIds[0]}>, but no review channel is selected. Run \`/feature-rec channel #channel-name\` to select it.`;
      }
      return SLACK_NO_CHANNEL_MESSAGE;
    }
    const settings = await store.getChannelSettings(input.teamId, selectedChannelId);
    const present = input.botChannelIds.includes(selectedChannelId);
    const lines = [
      `Selected review channel: <#${selectedChannelId}> (${present ? "available" : "unavailable"}).`,
      describeChannelSettings(settings),
    ];
    if (!present) {
      lines.push(slackSelectedChannelUnavailableMessage(selectedChannelId));
    }
    return lines.join("\n");
  }

  async function greetJoinedChannel(teamId: string, channelId: string, slack: SlackClient): Promise<void> {
    const memberships = await slack.listBotChannels();
    const selectedChannelId = await store.getSelectedChannelId(teamId);
    if (selectedChannelId !== channelId || !memberships.includes(channelId)) return;
    await slack.postMessage(channelId, SLACK_GREETING_ACTIVE);
  }

  // Approval authorization comes from the channel's settings at click time:
  // no list means everyone in the channel may approve; otherwise expand the
  // stored usergroups/users and answer unauthorized clicks ephemerally —
  // never drop them silently.
  async function approvalGate(
    payload: SlackPayload,
    cycle: CycleRecord,
    responseUrl: string | undefined,
  ): Promise<{ slack: SlackClient; tenantId: string } | null> {
    const teamId = payload.team?.id;
    if (!teamId || !payload.user?.id || !cycle.slackChannelId) {
      app.log.warn({ category: "slack_approval_context_missing", cycleId: cycle.id, teamId }, "Slack approval rejected");
      return null;
    }
    const workspace = await slackResolver.workspaceForTeam(teamId);
    if (!workspace || workspace.tenantId !== cycle.tenantId) {
      app.log.warn({ category: workspace ? "slack_approval_tenant_mismatch" : "slack_approval_workspace_unavailable", cycleId: cycle.id, teamId }, "Slack approval rejected");
      return null;
    }
    const slack = slackResolver.forWorkspace(workspace);
    const settings = await store.getChannelSettings(teamId, cycle.slackChannelId);
    const approvers = settings.approvers;
    if (await slack.isApprover(approvers, payload.user?.id)) return { slack, tenantId: workspace.tenantId };
    app.log.warn({ cycleId: cycle.id, slackUserId: payload.user?.id }, "unauthorized Slack approver");
    if (responseUrl && approvers) {
      // Best-effort: a modal can outlive its stashed response_url (30 min),
      // and a dead URL must not turn the rejection into a handler error.
      await slack
        .respondEphemeral(
          responseUrl,
          `Only ${formatApproverList(approvers)} can approve.`,
        )
        .catch((err: unknown) =>
          app.log.warn({ err, cycleId: cycle.id }, "unauthorized-approver ephemeral reply failed"),
        );
    }
    return null;
  }

  async function handleBlockAction(payload: SlackPayload): Promise<void> {
    const action = payload.actions?.[0];
    const value = SlackApprovalPayloadSchema.parse(JSON.parse(action?.value ?? "{}"));
    const interactionId = `block:${payload.trigger_id ?? ""}:${action?.action_ts ?? ""}:${value.action}`;

    const cycle = await store.getCycle(value.cycleId);
    if (!cycle || cycle.headSha !== value.headSha || cycle.status !== "pending_validation") return;
    const authorizedSlack = await approvalGate(payload, cycle, payload.response_url);
    if (!authorizedSlack) return;
    const { slack, tenantId } = authorizedSlack;
    let access: RepositoryAccess | null;
    try {
      access = value.action === "accept" ? await authorizeCycle(cycle) : null;
    } catch (error) {
      app.log.warn({ err: error, cycleId: cycle.id, tenantId }, "Slack approval GitHub authorization failed");
      if (payload.response_url) {
        await ephemeral(payload.response_url, approvalFailureMessage(error)).catch((err: unknown) =>
          app.log.warn({ err, cycleId: cycle.id }, "Slack approval failure reply failed"));
      }
      return;
    }
    if (!(await store.recordProcessedInteraction(interactionId, value.cycleId))) return;

    if (value.action === "accept" && access) {
      // Transition-first: two distinct clicks both pass dedupe, so the status
      // guard is what serializes them. Stop on null (stale or lost the race).
      const accepted = await store.transitionSlackStatus({
        tenantId,
        cycleId: cycle.id,
        from: ["pending_validation"],
        to: "accepted",
      });
      if (!accepted) return;
      // No withRetry around accept: the comment POST inside is not idempotent;
      // the check-run PATCH retries internally (see GitHubClient.accept).
      // GitHub and Slack effects run independently: the DB already settled the
      // cycle, so a GitHub failure must not skip the Slack finalize (live
      // buttons on a decided cycle), nor vice versa.
      await settleSideEffects(accepted.id, [
        ["github accept", github.accept(accepted, access)],
        ["slack finalize", withRetry(() => slack.finalize(accepted, "accepted", "Validation passed."))],
      ]);
      return;
    }

    if (payload.trigger_id) {
      await slack.openRequestChangesModal(payload.trigger_id, cycle, payload.response_url);
    }
  }

  async function prepareViewSubmission(payload: SlackPayload) {
    const meta = JSON.parse(payload.view?.private_metadata ?? "{}") as {
      cycleId?: string;
      headSha?: string;
      responseUrl?: string;
    };
    const cycleId = meta.cycleId ?? "";
    const interactionId = `view:${payload.view?.id ?? ""}:${payload.view?.hash ?? ""}`;
    const cycle = await store.getCycle(cycleId);
    if (!cycle || cycle.headSha !== meta.headSha || cycle.status !== "pending_validation") {
      throw new ApprovalError("This review is no longer pending. Close this dialog and use the latest validation message.");
    }
    const authorizedSlack = await approvalGate(payload, cycle, meta.responseUrl);
    if (!authorizedSlack) throw new ApprovalError("You cannot approve this review from this workspace. Ask an administrator to check the integration and channel approvers.");
    const access = await authorizeCycle(cycle);
    return { cycle, ...authorizedSlack, access, interactionId };
  }

  async function handleViewSubmission(prepared: Awaited<ReturnType<typeof prepareViewSubmission>>, comment: string): Promise<void> {
    const { cycle, slack, tenantId, access, interactionId } = prepared;
    if (!(await store.recordProcessedInteraction(interactionId, cycle.id))) return;
    const rejected = await store.transitionSlackStatus({
      tenantId,
      cycleId: cycle.id,
      from: ["pending_validation"],
      to: "rejected",
    });
    if (!rejected) return;
    // No withRetry around reject: comment POST is not idempotent; the check-run
    // PATCH retries internally (see GitHubClient.reject). GitHub and Slack
    // effects run independently (see accept path for rationale).
    await settleSideEffects(rejected.id, [
      ["github reject", github.reject(rejected, comment.trim(), access)],
      ["slack finalize", withRetry(() => slack.finalize(rejected, "rejected", comment.trim()))],
    ]);
  }

  // Runs post-commit side effects independently and logs each failure without
  // letting one channel's outage suppress the other's repair.
  async function settleSideEffects(cycleId: string, effects: Array<[string, Promise<unknown>]>): Promise<void> {
    const results = await Promise.allSettled(effects.map(([, p]) => p));
    results.forEach((res, i) => {
      if (res.status === "rejected") {
        app.log.warn({ err: res.reason, cycleId, effect: effects[i][0] }, "post-commit side effect failed");
      }
    });
  }

  return app;
}

function extractModalComment(payload: SlackPayload): string {
  const values = payload.view?.state?.values ?? {};
  return values.comment?.value?.value ?? "";
}
