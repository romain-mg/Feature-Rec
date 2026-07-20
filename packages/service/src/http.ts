import Fastify from "fastify";
import crypto from "node:crypto";
import {
  buildCycleKey,
  ClassifierResultSchema,
  renderTemplate,
  RunStartRequestSchema,
  SlackApprovalPayloadSchema,
  SLACK_GREETING_ACTIVE,
  SLACK_GREETING_NEXT_IN_LINE,
  SLACK_GREETING_QUEUED,
  SLACK_NO_CHANNEL_MESSAGE,
  SLACK_PROMOTION_NOTICE,
} from "@feature-rec/core";
import type { ServiceEnv } from "./env";
import { ChannelResolutionError, resolveChannel, syncTenantChannels } from "./channels";
import { GitHubClient } from "./github";
import { withRetry } from "./retry";
import { SlackClient, verifySlackSignature } from "./slack";
import type { SlackUsergroup } from "./slack";
import type { BotChannel, CycleStore } from "./storage";

const VIDEO_BODY_LIMIT_BYTES = 500 * 1024 * 1024;

type SlackPayload = {
  type: "block_actions" | "view_submission";
  trigger_id?: string;
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
  enterprise_id?: string | null;
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
// enabled on the command, user mentions arrive as <@U…|name>; usergroups and
// @here/@channel arrive as typed.
const USER_MENTION_RE = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/;
const SUBTEAM_MENTION_RE = /^<!subteam\^(S[A-Z0-9]+)(?:\|[^>]*)?>$/;

// A user-correctable command mistake: the message goes back ephemerally
// instead of becoming a 500.
class CommandError extends Error {}

const COMMAND_USAGE = [
  "Usage:",
  "`/feature-rec mention @here|@channel|@usergroup|@user…|off` — who validation requests mention; no target shows the current value",
  "`/feature-rec approvers @usergroup|@user…|everyone` — restrict who can approve; no argument shows the current value",
  "`/feature-rec status` — show routing, mention, and approvers",
].join("\n");

function describeMention(mention: string | null): string {
  if (mention === null) return "@here (default)";
  if (mention === "") return "off";
  return mention;
}

function renderApproverIds(ids: string[]): string {
  return ids.map((id) => (id.startsWith("S") ? `<!subteam^${id}>` : `<@${id}>`)).join(", ");
}

function describeApprovers(approvers: string[] | null): string {
  return approvers && approvers.length > 0
    ? `Approvers: ${renderApproverIds(approvers)}`
    : "Approvers: everyone in the channel.";
}

function rawJsonBody(body: unknown): string {
  if (body && typeof body === "object") {
    const raw = (body as { __rawBody?: unknown }).__rawBody;
    if (typeof raw === "string") return raw;
  }
  return "";
}

function slackTsToIso(ts: string | undefined): string {
  const seconds = Number(ts);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
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

function runnerAuthorized(env: ServiceEnv, header: unknown): boolean {
  if (!env.runnerToken || typeof header !== "string") return false;
  return timingSafeStringEqual(header, `Bearer ${env.runnerToken}`);
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
  github?: GitHubClient;
  slack?: SlackClient;
}) {
  const env = input.env;
  const store = input.store;
  const github = input.github ?? new GitHubClient(env);
  const slack = input.slack ?? new SlackClient(env);
  const app = Fastify({ logger: true });

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

  app.post("/api/runs/start", async (request, reply) => {
    if (!runnerAuthorized(env, request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const start = RunStartRequestSchema.parse(request.body);
    const cycleKey = buildCycleKey(start);
    const result = await store.startCycle({ ...start, cycleKey });

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
            }),
          ),
          withRetry(() =>
            slack.finalize(oldCycle, "superseded", "A newer commit started a fresh validation cycle."),
          ),
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

    // Takeover of a previously `failed` cycle: reuse its existing check run
    // (set it back to in_progress) instead of creating a second one, so a
    // re-run recovers a red check rather than exiting green over a red run.
    if (result.cycle.checkRunId) {
      await withRetry(() =>
        github.updateCheckRun(result.cycle, {
          status: "in_progress",
          output: {
            title: "Feature-Rec: analyzing",
            summary: "Re-running Feature-Rec after a previous failure.",
          },
        }),
      );
      return {
        cycleId: result.cycle.id,
        cycleKey,
        checkRunId: result.cycle.checkRunId,
        attemptId: result.attemptId,
      };
    }

    // Fresh create: only the creator creates the check run, then attaches it atomically.
    // If GitHub rejects creation, release this attempt by marking it failed so
    // a same-head workflow rerun can take over instead of exiting as a duplicate.
    let checkRunId: number;
    try {
      checkRunId = await github.createCheckRun({ ...start, cycleKey });
    } catch (err) {
      await store.transitionRunnerStatus({
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
            { owner: start.owner, repo: start.repo, checkRunId },
            {
              conclusion: "neutral",
              output: {
                title: "Feature-Rec: superseded",
                summary: "Superseded by a newer PR head SHA before validation started.",
              },
            },
          ),
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
    };
  });

  app.post("/api/runs/:cycleId/accepted", async (request, reply) => {
    if (!runnerAuthorized(env, request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const attemptId = bodyAttemptId(request.body);
    if (!attemptId) return reply.code(400).send({ error: "attemptId is required" });
    const cycle = await store.transitionRunnerStatus({
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
      }),
    );
    return { ok: true };
  });

  app.post("/api/runs/:cycleId/failed", async (request, reply) => {
    if (!runnerAuthorized(env, request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = request.body as { message?: string } | undefined;
    const attemptId = bodyAttemptId(request.body);
    if (!attemptId) return reply.code(400).send({ error: "attemptId is required" });
    const cycle = await store.transitionRunnerStatus({
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
      }),
    );
    return { ok: true };
  });

  app.post(
    "/api/runs/:cycleId/video",
    { bodyLimit: VIDEO_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (!runnerAuthorized(env, request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const video = Buffer.isBuffer(request.body) ? request.body : Buffer.from([]);
      if (video.byteLength === 0) return reply.code(400).send({ error: "empty video body" });
      const attemptId = headerAttemptId(request.headers["x-feature-rec-attempt"]);
      if (!attemptId) return reply.code(400).send({ error: "attemptId is required" });

      // Transition first (guards against stale/duplicate runners and gives
      // first-writer-wins idempotency), then run side effects.
      const cycle = await store.transitionRunnerStatus({
        cycleId: param(request.params, "cycleId"),
        attemptId,
        from: ["analyzing"],
        to: "pending_validation",
      });
      if (!cycle) return reply.send({ ok: false, stale: true });

      // Resolve the review channel before any side effect: with no channel
      // there is nowhere to post, so fail the cycle with an actionable
      // check-run message. The runner's follow-up /failed call then no-ops on
      // the status guard, preserving that message.
      let resolved: { teamId: string; channelId: string };
      try {
        resolved = await resolveChannel(store, slack);
      } catch (err) {
        if (!(err instanceof ChannelResolutionError)) throw err;
        const failed = await store.transitionRunnerStatus({
          cycleId: cycle.id,
          attemptId,
          from: ["pending_validation"],
          to: "failed",
        });
        // Superseded while resolving: the superseder already neutralized the
        // check run — don't clobber its conclusion with a failure.
        if (!failed) return reply.send({ ok: false, stale: true });
        await withRetry(() =>
          github.updateCheckRun(cycle, {
            conclusion: "failure",
            output: {
              title: "Feature-Rec: no Slack review channel",
              summary: err.message,
            },
          }),
        );
        return reply.code(422).send({ error: "no_slack_channel", message: err.message });
      }

      await withRetry(() =>
        github.updateCheckRun(cycle, {
          status: "in_progress",
          output: {
            title: "Feature-Rec: pending validation",
            summary: "Frontend-visible change rendered and sent to Slack for validation.",
          },
        }),
      );

      await slack.uploadVideo(cycle, resolved.channelId, video);
      const message = await slack.postValidation(cycle, resolved.channelId, null);
      const statusAfter = await store.attachSlackMessage(cycle.id, message.channel, message.ts);
      if (statusAfter === "superseded") {
        // Superseded after the transition but before the Slack post landed:
        // finalize the message we just posted so it can't strand in Slack.
        // Retried: nobody else will ever repair this message (the superseder's
        // cleanup already ran and saw no coordinates), and chat.update is idempotent.
        await withRetry(() =>
          slack.finalize(
            { ...cycle, slackChannelId: message.channel, slackMessageTs: message.ts },
            "superseded",
            "A newer commit started a fresh validation cycle.",
          ),
        );
      }
      return { ok: true, channel: message.channel, ts: message.ts };
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
      void handleViewSubmission(payload, comment).catch((err) => app.log.error(err));
      return reply.send("");
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

    // Drop everything that isn't a bot membership change, without logging it:
    // membership events fire for every user entering a bot channel and their
    // payloads must never reach the logs.
    const event = body.event ?? {};
    const isJoin = event.type === "member_joined_channel";
    const isLeave = event.type === "member_left_channel";
    if ((!isJoin && !isLeave) || !event.user || !event.channel) return reply.send({ ok: true });
    const identity = await slack.botIdentity();
    if (event.user !== identity.userId) return reply.send({ ok: true });

    const teamId = body.team_id ?? identity.teamId;
    const channelId = event.channel;
    const eventAt = slackTsToIso(event.event_ts);

    // The idempotent DB write lands before the 200, so a pre-ack crash rides
    // Slack's retries; greetings and notices run detached so Slack API latency
    // cannot consume the 3-second deadline.
    if (isJoin) {
      await store.recordChannelJoin({
        teamId,
        enterpriseId: body.enterprise_id ?? null,
        channelId,
        joinedAt: eventAt,
      });
      void greetJoinedChannel(teamId, channelId).catch((err) => app.log.error(err));
      return reply.send({ ok: true });
    }

    const activeBefore = await store.activeBotChannels(teamId);
    await store.recordChannelLeave({ teamId, channelId, leftAt: eventAt });
    void notifyPromotion(teamId, channelId, activeBefore).catch((err) => app.log.error(err));
    return reply.send({ ok: true });
  });

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
    if (!teamId || !channelId || !userId) {
      return reply.code(400).send({ error: "malformed command payload" });
    }

    const ephemeral = (text: string) => reply.send({ response_type: "ephemeral", text });
    const [subcommand, ...args] = (form.get("text") ?? "").trim().split(/\s+/).filter(Boolean);
    try {
      if (subcommand === "mention") {
        return ephemeral(await mentionCommand({ teamId, channelId, userId, args }));
      }
      if (subcommand === "approvers") {
        return ephemeral(await approversCommand({ teamId, channelId, userId, args }));
      }
      if (subcommand === "status") {
        return ephemeral(await statusCommand(teamId, channelId));
      }
      return ephemeral(COMMAND_USAGE);
    } catch (err) {
      if (err instanceof CommandError) return ephemeral(err.message);
      throw err;
    }
  });

  async function mentionCommand(input: {
    teamId: string;
    channelId: string;
    userId: string;
    args: string[];
  }): Promise<string> {
    if (input.args.length === 0) {
      const settings = await store.getChannelSettings(input.teamId, input.channelId);
      return `Mention: ${describeMention(settings?.mention ?? null)}`;
    }
    if (input.args.includes("off")) {
      if (input.args.length > 1) {
        throw new CommandError('Use "off" by itself: `/feature-rec mention off`.');
      }
      await store.setMention({
        teamId: input.teamId,
        channelId: input.channelId,
        mention: "",
        updatedBy: input.userId,
      });
      return "Mention turned off for validation requests in this channel.";
    }
    const mention = (await resolveMentionTargets(input.args)).join(" ");
    await store.setMention({
      teamId: input.teamId,
      channelId: input.channelId,
      mention,
      updatedBy: input.userId,
    });
    return `Validation requests in this channel will mention ${mention}.`;
  }

  async function resolveMentionTargets(tokens: string[]): Promise<string[]> {
    const rendered: string[] = [];
    let usergroups: SlackUsergroup[] | null = null;
    for (const token of tokens) {
      if (token === "@here" || token === "<!here>") {
        rendered.push("<!here>");
        continue;
      }
      if (token === "@channel" || token === "<!channel>") {
        rendered.push("<!channel>");
        continue;
      }
      const user = USER_MENTION_RE.exec(token);
      if (user) {
        rendered.push(`<@${user[1]}>`);
        continue;
      }
      if (SUBTEAM_MENTION_RE.test(token)) {
        rendered.push(token);
        continue;
      }
      usergroups ??= await slack.listUsergroups();
      const handle = token.replace(/^@/, "");
      const group = usergroups.find((candidate) => candidate.handle === handle);
      if (!group) {
        throw new CommandError(
          `Unknown mention target ${token}. Use @here, @channel, a usergroup handle, user mentions, or "off".`,
        );
      }
      rendered.push(`<!subteam^${group.id}|@${group.handle}>`);
    }
    return rendered;
  }

  async function approversCommand(input: {
    teamId: string;
    channelId: string;
    userId: string;
    args: string[];
  }): Promise<string> {
    if (input.args.length === 0) {
      const settings = await store.getChannelSettings(input.teamId, input.channelId);
      return describeApprovers(settings?.approvers ?? null);
    }
    if (input.args.includes("everyone") || input.args.includes("off")) {
      if (input.args.length > 1) {
        throw new CommandError('Use "everyone" by itself: `/feature-rec approvers everyone`.');
      }
      await store.setApprovers({
        teamId: input.teamId,
        channelId: input.channelId,
        approvers: null,
        updatedBy: input.userId,
      });
      return "Everyone in the channel can now approve.";
    }
    const ids = await resolveApproverTargets(input.args);
    await store.setApprovers({
      teamId: input.teamId,
      channelId: input.channelId,
      approvers: ids,
      updatedBy: input.userId,
    });
    return `Only ${renderApproverIds(ids)} can approve.`;
  }

  async function resolveApproverTargets(tokens: string[]): Promise<string[]> {
    const ids = new Set<string>();
    let usergroups: SlackUsergroup[] | null = null;
    for (const token of tokens) {
      const user = USER_MENTION_RE.exec(token);
      if (user) {
        ids.add(user[1]);
        continue;
      }
      const subteam = SUBTEAM_MENTION_RE.exec(token);
      if (subteam) {
        ids.add(subteam[1]);
        continue;
      }
      usergroups ??= await slack.listUsergroups();
      const handle = token.replace(/^@/, "");
      const group = usergroups.find((candidate) => candidate.handle === handle);
      if (!group) {
        throw new CommandError(
          `Unknown approver ${token}. Use usergroup handles, user mentions, or "everyone".`,
        );
      }
      ids.add(group.id);
    }
    return [...ids];
  }

  async function statusCommand(teamId: string, channelId: string): Promise<string> {
    const tenant = await syncTenantChannels(store, slack);
    const active = tenant.channels[0];
    if (!active) return SLACK_NO_CHANNEL_MESSAGE;
    const settings = await store.getChannelSettings(teamId, channelId);
    const lines = [
      `Validations go to <#${active.channelId}>.`,
      `Mention: ${describeMention(settings?.mention ?? null)}`,
      describeApprovers(settings?.approvers ?? null),
    ];
    const queue = tenant.channels.slice(1);
    if (queue.length > 0) {
      lines.push(`Fallback queue: ${queue.map((channel) => `<#${channel.channelId}>`).join(", ")}.`);
    }
    return lines.join("\n");
  }

  async function greetJoinedChannel(teamId: string, channelId: string): Promise<void> {
    const active = await store.activeBotChannels(teamId);
    const rank = active.findIndex((channel) => channel.channelId === channelId) + 1;
    if (rank === 0) return; // already left again; nothing to greet
    const text =
      rank === 1
        ? SLACK_GREETING_ACTIVE
        : renderTemplate(rank === 2 ? SLACK_GREETING_NEXT_IN_LINE : SLACK_GREETING_QUEUED, {
            active_channel: `<#${active[0].channelId}>`,
          });
    await slack.postMessage(channelId, text);
  }

  async function notifyPromotion(
    teamId: string,
    leftChannelId: string,
    activeBefore: BotChannel[],
  ): Promise<void> {
    if (activeBefore[0]?.channelId !== leftChannelId) return;
    const promoted = (await store.activeBotChannels(teamId))[0];
    if (promoted) await slack.postMessage(promoted.channelId, SLACK_PROMOTION_NOTICE);
  }

  async function handleBlockAction(payload: SlackPayload): Promise<void> {
    const action = payload.actions?.[0];
    const value = SlackApprovalPayloadSchema.parse(JSON.parse(action?.value ?? "{}"));
    const interactionId = `block:${payload.trigger_id ?? ""}:${action?.action_ts ?? ""}:${value.action}`;

    const cycle = await store.getCycle(value.cycleId);
    if (!cycle) return;
    if (!(await slack.isApprover(null, payload.user?.id))) {
      app.log.warn({ cycleId: cycle.id, slackUserId: payload.user?.id }, "unauthorized Slack approver");
      return;
    }
    if (!(await store.recordProcessedInteraction(interactionId, value.cycleId))) return;

    if (value.action === "accept") {
      // Transition-first: two distinct clicks both pass dedupe, so the status
      // guard is what serializes them. Stop on null (stale or lost the race).
      const accepted = await store.transitionSlackStatus({
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
        ["github accept", github.accept(accepted)],
        ["slack finalize", withRetry(() => slack.finalize(accepted, "accepted", "Validation passed."))],
      ]);
      return;
    }

    if (payload.trigger_id) {
      await slack.openRequestChangesModal(payload.trigger_id, cycle, undefined);
    }
  }

  async function handleViewSubmission(payload: SlackPayload, comment: string): Promise<void> {
    const meta = JSON.parse(payload.view?.private_metadata ?? "{}") as { cycleId?: string; headSha?: string };
    const cycleId = meta.cycleId ?? "";
    const interactionId = `view:${payload.view?.id ?? ""}:${payload.view?.hash ?? ""}`;
    const cycle = await store.getCycle(cycleId);
    if (!cycle) return;
    if (!(await slack.isApprover(null, payload.user?.id))) {
      app.log.warn({ cycleId: cycle.id, slackUserId: payload.user?.id }, "unauthorized Slack approver");
      return;
    }
    if (!(await store.recordProcessedInteraction(interactionId, cycleId))) return;

    const rejected = await store.transitionSlackStatus({
      cycleId: cycle.id,
      from: ["pending_validation"],
      to: "rejected",
    });
    if (!rejected) return;
    // No withRetry around reject: comment POST is not idempotent; the check-run
    // PATCH retries internally (see GitHubClient.reject). GitHub and Slack
    // effects run independently (see accept path for rationale).
    await settleSideEffects(rejected.id, [
      ["github reject", github.reject(rejected, comment.trim())],
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
