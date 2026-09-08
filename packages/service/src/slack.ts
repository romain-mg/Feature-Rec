import crypto from "node:crypto";
import type { SlackApprovalPayload } from "@feature-rec/core";
import type { CycleRecord } from "./storage";

type SlackResponse<T> = T & {
  ok: boolean;
  error?: string;
  response_metadata?: {
    messages?: string[];
    next_cursor?: string;
  };
};

export type BotIdentity = {
  userId: string;
  teamId: string;
};

export type SlackUsergroup = {
  id: string;
  handle: string;
};

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

export class SlackApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function isRevokedSlackToken(error: unknown): boolean {
  // invalid_auth can also mean an IP allowlist rejection. It does not prove
  // that the current credential was revoked and must never authorize deletion.
  return error instanceof SlackApiError && ["token_revoked", "account_inactive"].includes(error.code);
}

async function slackApi<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal,
  });
  return readSlackResponse<T>(method, response);
}

async function slackApiGet<T>(
  botToken: string,
  method: string,
  query: Record<string, string | number>,
): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${botToken}` },
  });
  return readSlackResponse<T>(method, response);
}

async function readSlackResponse<T>(method: string, response: Response): Promise<T> {
  const json = (await response.json()) as SlackResponse<T>;
  if (!json.ok) {
    const details = json.response_metadata?.messages?.filter(Boolean).join("; ");
    const reason = json.error ?? response.statusText;
    throw new SlackApiError(json.error ?? "unknown", `Slack ${method} failed: ${reason}${details ? ` (${details})` : ""}`);
  }
  return json as T;
}

export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
}): boolean {
  if (!input.signingSecret) return false;
  if (!input.timestamp || !input.signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(input.timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;
  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const digest = `v0=${crypto
    .createHmac("sha256", input.signingSecret)
    .update(base)
    .digest("hex")}`;
  return timingSafeStringEqual(digest, input.signature);
}

// A response URL comes only from a verified Slack payload. Replying does not
// require an installed workspace or a decrypted bot token.
export async function respondEphemeral(responseUrl: string, text: string): Promise<void> {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
  });
  if (!response.ok) {
    throw new Error(`Slack response_url reply failed: ${response.status} ${await response.text()}`);
  }
}

function actionValue(payload: SlackApprovalPayload): string {
  return JSON.stringify(payload);
}

function validationBlocks(cycle: CycleRecord, mention: string | null, fullName: string): unknown[] {
  const title = `Feature-Rec validation needed for ${fullName}#${cycle.prNumber}`;
  const body = `*${title}*\n${cycle.prTitle || "Frontend-visible change detected."}`;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        // Caller resolves the effective mention; null means no mention prefix.
        text: mention ? `${mention}\n${body}` : body,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Head SHA: \`${cycle.headSha.slice(0, 12)}\``,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Good to merge" },
          style: "primary",
          action_id: "feature_rec_accept",
          value: actionValue({ action: "accept", cycleId: cycle.id, headSha: cycle.headSha }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Needs changes" },
          style: "danger",
          action_id: "feature_rec_request_changes",
          value: actionValue({
            action: "request_changes",
            cycleId: cycle.id,
            headSha: cycle.headSha,
          }),
        },
      ],
    },
  ];
}

type ConversationsPage = {
  channels?: Array<{ id: string }>;
  response_metadata?: { next_cursor?: string };
};

type ConversationMembersPage = {
  members?: string[];
  response_metadata?: { next_cursor?: string };
};

export class SlackClient {
  #botToken: string;
  #identity: Promise<BotIdentity> | null = null;

  constructor(botToken: string) {
    if (!botToken) throw new Error("Slack bot token must not be empty");
    this.#botToken = botToken;
  }

  // Identity is checked for provisioning and lifecycle revocation checks.
  // Ordinary runtime operations use the persisted bot user ID.
  botIdentity(timeoutMs = 5_000): Promise<BotIdentity> {
    this.#identity ??= slackApi<{
      user_id: string;
      team_id: string;
    }>(this.#botToken, "auth.test", {}, AbortSignal.timeout(timeoutMs)).then(
      (res) => ({
        userId: res.user_id,
        teamId: res.team_id,
      }),
      (err: unknown) => {
        this.#identity = null;
        throw err;
      },
    );
    return this.#identity;
  }

  // Every channel the bot is a member of, as reported by users.conversations.
  // No shared-channel filtering: inviting the bot IS the routing decision, so
  // membership is honored as-is. Consequence (documented in the setup guide):
  // do not invite @Feature-Rec to externally shared (Slack Connect) channels —
  // validation videos and PR information would be posted where an external
  // organization can see them.
  async listBotChannels(): Promise<string[]> {
    const channelIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await slackApi<ConversationsPage>(this.#botToken, "users.conversations", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const channel of page.channels ?? []) {
        channelIds.push(channel.id);
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return channelIds;
  }

  async listChannelMembers(channelId: string): Promise<string[]> {
    const members: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await slackApiGet<ConversationMembersPage>(
        this.#botToken,
        "conversations.members",
        {
          channel: channelId,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        },
      );
      members.push(...(page.members ?? []));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return members;
  }

  async listUsergroups(): Promise<SlackUsergroup[]> {
    const res = await slackApi<{
      usergroups?: Array<{ id: string; handle: string }>;
    }>(this.#botToken, "usergroups.list", { include_disabled: false });
    return (res.usergroups ?? []).map((group) => ({
      id: group.id,
      handle: group.handle,
    }));
  }

  async listUsergroupMembers(usergroupId: string): Promise<string[]> {
    const res = await slackApi<{ users?: string[] }>(this.#botToken, "usergroups.users.list", {
      usergroup: usergroupId,
      include_disabled: false,
    });
    return res.users ?? [];
  }

  async postMessage(channelId: string, text: string): Promise<void> {
    await slackApi(this.#botToken, "chat.postMessage", { channel: channelId, text });
  }

  // response_url replies bypass the Web API: they are short-lived webhook URLs
  // scoped to the triggering interaction.
  async respondEphemeral(responseUrl: string, text: string): Promise<void> {
    await respondEphemeral(responseUrl, text);
  }

  async uploadVideo(
    cycle: CycleRecord,
    channelId: string,
    file: Buffer,
    fullName: string,
  ): Promise<void> {
    const upload = await slackApiGet<{ upload_url: string; file_id: string }>(this.#botToken, "files.getUploadURLExternal", {
      filename: `feature-rec-${cycle.prNumber}-${cycle.headSha.slice(0, 8)}.mp4`,
      length: file.byteLength,
    });

    const uploadResponse = await fetch(upload.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([new Uint8Array(file)]),
    });
    if (!uploadResponse.ok) {
      // This upload URL reports HTTP status, not Web API error codes. A failed
      // upload does not establish that the workspace token was revoked.
      throw new Error(`Slack file upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);
    }

    await slackApi(this.#botToken, "files.completeUploadExternal", {
      files: [{ id: upload.file_id, title: `Feature-Rec PR #${cycle.prNumber}` }],
      channel_id: channelId,
      initial_comment: `Feature-Rec video for ${fullName}#${cycle.prNumber}`,
    });
  }

  async postValidation(
    cycle: CycleRecord,
    channelId: string,
    mention: string | null,
    fullName: string,
  ): Promise<{ channel: string; ts: string }> {
    const message = await slackApi<{ channel: string; ts: string }>(this.#botToken, "chat.postMessage", {
      channel: channelId,
      text: `Feature-Rec validation needed for ${fullName}#${cycle.prNumber}`,
      blocks: validationBlocks(cycle, mention, fullName),
    });
    return { channel: message.channel, ts: message.ts };
  }

  // approvers: S…/U… ids from channel settings; null or empty means everyone
  // in the channel may approve.
  async isApprover(approvers: string[] | null, userId: string | undefined): Promise<boolean> {
    if (!approvers || approvers.length === 0) return true;
    if (!userId) return false;
    if (approvers.includes(userId)) return true;

    const usergroups = approvers.filter((id) => /^S[A-Z0-9]+$/.test(id));
    if (usergroups.length === 0) return false;
    const memberships = await Promise.all(
      usergroups.map((usergroup) => this.listUsergroupMembers(usergroup)),
    );
    return memberships.some((membership) => membership.includes(userId));
  }

  async finalize(
    cycle: CycleRecord,
    state: "accepted" | "rejected" | "superseded" | "failed",
    detail: string,
  ): Promise<void> {
    if (!cycle.slackChannelId || !cycle.slackMessageTs) return;
    await slackApi(this.#botToken, "chat.update", {
      channel: cycle.slackChannelId,
      ts: cycle.slackMessageTs,
      text: `Feature-Rec ${state} for PR #${cycle.prNumber}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Feature-Rec: ${state}*\n${detail}`,
          },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Head SHA: \`${cycle.headSha.slice(0, 12)}\`` }],
        },
      ],
    });
  }

  async openRequestChangesModal(
    triggerId: string,
    cycle: CycleRecord,
    responseUrl: string | undefined,
  ): Promise<void> {
    await slackApi(this.#botToken, "views.open", {
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "feature_rec_request_changes_modal",
        // responseUrl rides along so the submission handler can still reply
        // ephemerally (view_submission payloads carry no response_url).
        private_metadata: JSON.stringify({
          cycleId: cycle.id,
          headSha: cycle.headSha,
          responseUrl,
        }),
        title: { type: "plain_text", text: "Needs changes" },
        submit: { type: "plain_text", text: "Submit" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "comment",
            label: { type: "plain_text", text: "Required comment" },
            element: {
              type: "plain_text_input",
              action_id: "value",
              multiline: true,
            },
          },
        ],
      },
    });
  }
}
