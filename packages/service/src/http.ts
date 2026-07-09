import Fastify from "fastify";
import crypto from "node:crypto";
import {
  buildCycleKey,
  ClassifierResultSchema,
  RunStartRequestSchema,
  SlackApprovalPayloadSchema,
} from "@feature-rec/core";
import type { ServiceEnv } from "./env";
import { GitHubClient } from "./github";
import { withRetry } from "./retry";
import { SlackClient, verifySlackSignature } from "./slack";
import type { CycleStore } from "./storage";

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

function param(params: unknown, key: string): string {
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing parameter ${key}`);
  return value;
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
        try {
          await withRetry(() =>
            github.updateCheckRun(oldCycle, {
              conclusion: "neutral",
              output: {
                title: "Feature-Rec: superseded",
                summary: `Superseded by a newer PR head SHA: ${start.headSha}.`,
              },
            }),
          );
          await withRetry(() =>
            slack.finalize(oldCycle, "superseded", "A newer commit started a fresh validation cycle."),
          );
        } catch (err) {
          request.log.warn(
            { err, supersededCycleId: oldCycle.id },
            "best-effort finalize of superseded cycle failed",
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
        attemptId: result.attemptId ?? undefined,
      };
    }

    // Fresh create: only the creator creates the check run, then attaches it atomically.
    const checkRunId = await github.createCheckRun({ ...start, cycleKey });
    const statusAfterAttach = await store.attachCheckRun(result.cycle.id, checkRunId);
    if (statusAfterAttach === "superseded") {
      // A newer head superseded us between the transaction and the attach; its
      // neutralize loop saw check_run_id = null, so neutralize what we created.
      await github.updateCheckRun(
        { owner: start.owner, repo: start.repo, checkRunId },
        {
          conclusion: "neutral",
          output: {
            title: "Feature-Rec: superseded",
            summary: "Superseded by a newer PR head SHA before validation started.",
          },
        },
      );
    }

    return {
      cycleId: result.cycle.id,
      cycleKey,
      checkRunId,
      attemptId: result.attemptId ?? undefined,
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

      await withRetry(() =>
        github.updateCheckRun(cycle, {
          status: "in_progress",
          output: {
            title: "Feature-Rec: pending validation",
            summary: "Frontend-visible change rendered and sent to Slack for validation.",
          },
        }),
      );

      await slack.uploadVideo(cycle.config, cycle, video);
      const message = await slack.postValidation(cycle.config, cycle);
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

  async function handleBlockAction(payload: SlackPayload): Promise<void> {
    const action = payload.actions?.[0];
    const value = SlackApprovalPayloadSchema.parse(JSON.parse(action?.value ?? "{}"));
    const interactionId = `block:${payload.trigger_id ?? ""}:${action?.action_ts ?? ""}:${value.action}`;

    const cycle = await store.getCycle(value.cycleId);
    if (!cycle) return;
    if (!(await slack.isApprover(cycle.config, payload.user?.id))) {
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
      await github.accept(accepted, accepted.config.github.acceptComment);
      await withRetry(() => slack.finalize(accepted, "accepted", "Validation passed."));
      return;
    }

    if (payload.trigger_id) {
      await slack.openRequestChangesModal(payload.trigger_id, cycle);
    }
  }

  async function handleViewSubmission(payload: SlackPayload, comment: string): Promise<void> {
    const meta = JSON.parse(payload.view?.private_metadata ?? "{}") as { cycleId?: string; headSha?: string };
    const cycleId = meta.cycleId ?? "";
    const interactionId = `view:${payload.view?.id ?? ""}:${payload.view?.hash ?? ""}`;
    const cycle = await store.getCycle(cycleId);
    if (!cycle) return;
    if (!(await slack.isApprover(cycle.config, payload.user?.id))) {
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
    // PATCH retries internally (see GitHubClient.reject).
    await github.reject(rejected, rejected.config.github.rejectComment, comment.trim());
    await withRetry(() => slack.finalize(rejected, "rejected", comment.trim()));
  }

  return app;
}

function extractModalComment(payload: SlackPayload): string {
  const values = payload.view?.state?.values ?? {};
  return values.comment?.value?.value ?? "";
}
