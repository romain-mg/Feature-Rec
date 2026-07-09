import crypto from "node:crypto";
import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const FeatureRecConfigSchema = z.object({
  version: z.literal(1),
  github: z.object({
    checkName: z.string().min(1).default("Feature-Rec"),
    mention: z.string().default("@claude"),
    acceptComment: z.string().min(1).default("@{pr_author} validation passed; you can merge."),
    rejectComment: z
      .string()
      .min(1)
      .default("{mention} make the following changes:\n\n{review_comment}"),
  }),
  slack: z.object({
    channel: z.string().min(1),
    mention: z.string().default(""),
    approverUsergroups: z.array(z.string()).default([]),
  }),
});
export type FeatureRecConfig = z.infer<typeof FeatureRecConfigSchema>;

export const ClassifierResultSchema = z.object({
  frontendVisible: z.boolean(),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().default(""),
  userImpact: z.string().default(""),
  files: z.array(z.string()).default([]),
});
export type ClassifierResult = z.infer<typeof ClassifierResultSchema>;

export const ReviewCycleStatusSchema = z.enum([
  "analyzing",
  "pending_validation",
  "accepted",
  "rejected",
  "superseded",
  "failed",
]);
export type ReviewCycleStatus = z.infer<typeof ReviewCycleStatusSchema>;

export const RunStartRequestSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  prTitle: z.string().default(""),
  prAuthor: z.string().default(""),
  headSha: z.string().min(7),
  baseSha: z.string().min(7),
  configHash: z.string().min(8),
  checkName: z.string().min(1).default("Feature-Rec"),
  config: FeatureRecConfigSchema,
});
export type RunStartRequest = z.infer<typeof RunStartRequestSchema>;

export const RunStartResponseSchema = z.object({
  cycleId: z.string().min(1),
  cycleKey: z.string().min(1),
  checkRunId: z.number().int().positive().optional(),
  duplicate: z.boolean().optional(),
  attemptId: z.string().min(1).optional(),
});
export type RunStartResponse = z.infer<typeof RunStartResponseSchema>;

export const SlackApprovalPayloadSchema = z.object({
  action: z.enum(["accept", "request_changes"]),
  cycleId: z.string().min(1),
  headSha: z.string().min(7),
});
export type SlackApprovalPayload = z.infer<typeof SlackApprovalPayloadSchema>;

export const ReviewCycleSchema = z.object({
  id: z.string(),
  cycleKey: z.string(),
  owner: z.string(),
  repo: z.string(),
  prNumber: z.number().int().positive(),
  headSha: z.string(),
  configHash: z.string(),
  status: ReviewCycleStatusSchema,
  checkRunId: z.number().int().positive().nullable(),
  slackChannelId: z.string().nullable(),
  slackMessageTs: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReviewCycle = z.infer<typeof ReviewCycleSchema>;

export function buildCycleKey(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  configHash: string;
}): string {
  return `${input.owner}/${input.repo}#${input.prNumber}:${input.headSha}:${input.configHash}`;
}

export function configHash(config: FeatureRecConfig): string {
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}

export function isAllowedPullRequestEvent(event: {
  action?: string;
  pull_request?: { state?: string; draft?: boolean };
}): boolean {
  const action = event.action;
  const pr = event.pull_request;
  if (!pr || pr.state !== "open" || pr.draft) return false;
  return action === "opened" || action === "ready_for_review" || action === "synchronize";
}

export function parseFeatureRecConfig(source: string): FeatureRecConfig {
  return FeatureRecConfigSchema.parse(parseYaml(source) ?? {});
}

export function loadFeatureRecConfig(path: string): FeatureRecConfig {
  return parseFeatureRecConfig(fs.readFileSync(path, "utf8"));
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => values[key] ?? "");
}
