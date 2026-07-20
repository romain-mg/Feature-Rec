import { z } from "zod";

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
}): string {
  return `${input.owner}/${input.repo}#${input.prNumber}:${input.headSha}`;
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

export const GITHUB_CHECK_NAME = "Feature-Rec";
export const GITHUB_ACCEPT_COMMENT = "@{pr_author} validation passed; you can merge.";
export const GITHUB_REJECT_COMMENT = "@{pr_author} make the following changes:\n\n{review_comment}";

export const SLACK_GREETING_ACTIVE =
  "Connected, validation requests will appear in this channel.";
export const SLACK_GREETING_NEXT_IN_LINE =
  "Connected, validations currently go to {active_channel}. Remove me from that channel if you want reviews to happen here instead.";
export const SLACK_GREETING_QUEUED =
  "Connected but currently unused, validations go to {active_channel}. Remove me from other channels to use this one.";
export const SLACK_PROMOTION_NOTICE =
  "This channel now receives Feature-Rec validation requests.";
export const SLACK_NO_CHANNEL_MESSAGE =
  "Invite @Feature-Rec to your Slack review channel, then re-run.";

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => values[key] ?? "");
}
