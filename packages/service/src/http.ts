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
import { SlackClient, verifySlackSignature } from "./slack";
import type { CycleStore } from "./storage";

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

function runnerAuthorized(env: ServiceEnv, header: unknown): boolean {
  if (!env.runnerToken) return true;
  return header === `Bearer ${env.runnerToken}`;
}

function verifyGitHubWebhook(secret: string, rawBody: string, signature: string): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
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
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          (parsed as Record<string, unknown>).__rawBody = rawBody;
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

  app.post("/api/github/webhook", async (request, reply) => {
    const rawBody =
      typeof request.body === "object" && request.body
        ? String((request.body as Record<string, unknown>).__rawBody ?? "{}")
        : "{}";
    const signature = String(request.headers["x-hub-signature-256"] ?? "");
    if (env.githubWebhookSecret && !verifyGitHubWebhook(env.githubWebhookSecret, rawBody, signature)) {
      return reply.code(401).send({ error: "invalid signature" });
    }
    return { ok: true };
  });

  app.post("/api/runs/start", async (request, reply) => {
    if (!runnerAuthorized(env, request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const start = RunStartRequestSchema.parse(request.body);
    const cycleKey = buildCycleKey(start);
    const cycle = store.upsertCycle({ ...start, cycleKey });

    const superseded = store.markSupersededForPr({
      owner: start.owner,
      repo: start.repo,
      prNumber: start.prNumber,
      exceptHeadSha: start.headSha,
    });
    await Promise.all(
      superseded.map(async (oldCycle) => {
        await github.updateCheckRun(oldCycle, {
          conclusion: "neutral",
          output: {
            title: "Feature-Rec: superseded",
            summary: `Superseded by a newer PR head SHA: ${start.headSha}.`,
          },
        });
        await slack.finalize(oldCycle, "superseded", "A newer commit started a fresh validation cycle.");
      }),
    );

    if (!cycle.checkRunId) {
      const checkRunId = await github.createCheckRun({ ...start, cycleKey });
      store.updateCheckRun(cycle.id, checkRunId);
      return { cycleId: cycle.id, cycleKey, checkRunId };
    }

    return { cycleId: cycle.id, cycleKey, checkRunId: cycle.checkRunId };
  });

  app.post("/api/runs/:cycleId/accepted", async (request, reply) => {
    if (!runnerAuthorized(env, request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const cycle = store.getCycle(param(request.params, "cycleId"));
    if (!cycle) return reply.code(404).send({ error: "cycle not found" });
    await github.updateCheckRun(cycle, {
      conclusion: "success",
      output: {
        title: "Feature-Rec: accepted",
        summary: classifierSummary(request.body) || "No frontend-visible validation needed.",
      },
    });
    store.updateStatus(cycle.id, "accepted");
    return { ok: true };
  });

  app.post("/api/runs/:cycleId/failed", async (request, reply) => {
    if (!runnerAuthorized(env, request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const cycle = store.getCycle(param(request.params, "cycleId"));
    if (!cycle) return reply.code(404).send({ error: "cycle not found" });
    const body = request.body as { message?: string } | undefined;
    await github.updateCheckRun(cycle, {
      conclusion: "failure",
      output: {
        title: "Feature-Rec: failed",
        summary: body?.message ?? "Feature-Rec failed.",
      },
    });
    store.updateStatus(cycle.id, "failed");
    return { ok: true };
  });

  app.post("/api/runs/:cycleId/video", async (request, reply) => {
    if (!runnerAuthorized(env, request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const cycle = store.getCycle(param(request.params, "cycleId"));
    if (!cycle) return reply.code(404).send({ error: "cycle not found" });
    const video = Buffer.isBuffer(request.body) ? request.body : Buffer.from([]);
    if (video.byteLength === 0) return reply.code(400).send({ error: "empty video body" });

    await github.updateCheckRun(cycle, {
      status: "in_progress",
      output: {
        title: "Feature-Rec: pending validation",
        summary: "Frontend-visible change rendered and sent to Slack for validation.",
      },
    });
    store.updateStatus(cycle.id, "pending_validation");

    await slack.uploadVideo(cycle.config, cycle, video);
    const message = await slack.postValidation(cycle.config, cycle);
    store.updateSlackMessage(cycle.id, message.channel, message.ts);
    return { ok: true, channel: message.channel, ts: message.ts };
  });

  app.post("/api/slack/interactivity", async (request, reply) => {
    const rawBody = String(request.body ?? "");
    const valid = verifySlackSignature({
      signingSecret: env.slackSigningSecret,
      timestamp: String(request.headers["x-slack-request-timestamp"] ?? ""),
      signature: String(request.headers["x-slack-signature"] ?? ""),
      rawBody,
    });
    if (!valid) return reply.code(401).send("invalid signature");

    const form = new URLSearchParams(rawBody);
    const payload = JSON.parse(String(form.get("payload") ?? "{}")) as SlackPayload;

    if (payload.type === "block_actions") {
      reply.send("");
      void handleBlockAction(payload).catch((err) => app.log.error(err));
      return;
    }

    if (payload.type === "view_submission") {
      const comment = extractModalComment(payload);
      if (!comment.trim()) {
        return reply.send({
          response_action: "errors",
          errors: { comment: "A comment is required." },
        });
      }
      reply.send({});
      void handleViewSubmission(payload, comment).catch((err) => app.log.error(err));
      return;
    }

    return reply.send("");
  });

  async function handleBlockAction(payload: SlackPayload): Promise<void> {
    const action = payload.actions?.[0];
    const value = SlackApprovalPayloadSchema.parse(JSON.parse(action?.value ?? "{}"));
    const interactionId = `block:${payload.trigger_id ?? ""}:${action?.action_ts ?? ""}:${value.action}`;
    if (!store.recordProcessedInteraction(interactionId, value.cycleId)) return;

    const cycle = store.getCycle(value.cycleId);
    if (!cycle) return;
    if (cycle.status === "superseded" || cycle.headSha !== value.headSha) {
      await slack.finalize(cycle, "superseded", "This validation request is stale.");
      return;
    }

    if (value.action === "accept") {
      await github.accept(cycle, cycle.config.github.acceptComment);
      store.updateStatus(cycle.id, "accepted");
      await slack.finalize(cycle, "accepted", "Validation passed.");
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
    if (!store.recordProcessedInteraction(interactionId, cycleId)) return;
    const cycle = store.getCycle(cycleId);
    if (!cycle) return;
    if (cycle.status === "superseded" || cycle.headSha !== meta.headSha) {
      await slack.finalize(cycle, "superseded", "This validation request is stale.");
      return;
    }
    await github.reject(cycle, cycle.config.github.rejectComment, comment.trim());
    store.updateStatus(cycle.id, "rejected");
    await slack.finalize(cycle, "rejected", comment.trim());
  }

  return app;
}

function extractModalComment(payload: SlackPayload): string {
  const values = payload.view?.state?.values ?? {};
  return values.comment?.value?.value ?? "";
}
