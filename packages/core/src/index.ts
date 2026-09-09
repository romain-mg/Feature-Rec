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
  prNumber: z.number().int().positive(),
  headSha: z.string().min(7),
});
export type RunStartRequest = z.infer<typeof RunStartRequestSchema>;

export const RunStartResponseSchema = z.union([
  z.object({
    skipped: z.literal(true),
    reason: z.enum(["closed", "draft", "stale_head"]),
  }),
  z.object({
    skipped: z.literal(false).optional(),
    cycleId: z.string().min(1),
    cycleKey: z.string().min(1),
    checkRunId: z.number().int().positive().optional(),
    duplicate: z.boolean().optional(),
    attemptId: z.string().min(1).optional(),
    // Advisory: whether the tenant has any Slack review channel. Lets the
    // runner fail a frontend-visible PR before rendering; video-time channel
    // resolution stays authoritative.
    onboarded: z.boolean().optional(),
  }),
]);
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
  tenantId: z.string().uuid(),
  repositoryId: z.string().regex(/^[0-9]+$/),
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
  tenantId: string;
  repositoryId: string;
  prNumber: number;
  headSha: string;
}): string {
  return `${input.tenantId}/${input.repositoryId}#${input.prNumber}:${input.headSha}`;
}

export function normalizeOidcAudience(
  value: string,
  options: { allowLoopbackHttp?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Feature-Rec base URL must be an explicit valid HTTPS URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(options.allowLoopbackHttp && loopback && url.protocol === "http:")) ||
    url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")
  ) {
    throw new Error("Feature-Rec base URL must use HTTPS without credentials, query, or fragment; loopback HTTP is allowed only in local development or tests.");
  }
  return url.toString().replace(/\/+$/, "");
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
export const GITHUB_ACCEPT_COMMENT = "@{pr_author} validation passed, you can merge.";
export const GITHUB_REJECT_COMMENT = "@{pr_author} make the following changes:\n\n{review_comment}";

export const SLACK_GREETING_ACTIVE =
  "Connected. Use `/feature-rec channel`, `mention`, `approvers`, or `status` — see `/feature-rec help`.";
export const SLACK_NO_CHANNEL_MESSAGE =
  "Invite @Feature-Rec to your Slack review channel, then re-run.";
export const SLACK_MULTIPLE_CHANNELS_MESSAGE =
  "Feature-Rec is present in multiple channels. Run `/feature-rec channel #channel-name` to choose where videos should be sent.";

export function slackSelectedChannelUnavailableMessage(channelId: string): string {
  return `Feature-Rec is not currently in the selected review channel <#${channelId}>. Invite @Feature-Rec back or run \`/feature-rec channel #another-channel\` from any workspace conversation, then re-run.`;
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => values[key] ?? "");
}
