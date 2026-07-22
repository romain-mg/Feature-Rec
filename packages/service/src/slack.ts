import crypto from "node:crypto";
import type { SlackApprovalPayload } from "@feature-rec/core";
import type { ServiceEnv } from "./env";
import type { CycleRecord } from "./storage";

type SlackResponse<T> = T & { ok: boolean; error?: string };

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

async function slackApi<T>(
  env: ServiceEnv,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  if (!env.slackBotToken) throw new Error("SLACK_BOT_TOKEN is not set.");
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as SlackResponse<T>;
  if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error ?? response.statusText}`);
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

function actionValue(payload: SlackApprovalPayload): string {
  return JSON.stringify(payload);
}

function validationBlocks(cycle: CycleRecord, mention: string | null): unknown[] {
  const title = `Feature-Rec validation needed for ${cycle.owner}/${cycle.repo}#${cycle.prNumber}`;
  const prefix = mention ?? "<!here>";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${prefix ? `${prefix}\n` : ""}*${title}*\n${cycle.prTitle || "Frontend-visible change detected."}`,
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
  channels?: Array<{
    id: string;
    is_ext_shared?: boolean;
    is_pending_ext_shared?: boolean;
  }>;
  response_metadata?: { next_cursor?: string };
};

export class SlackClient {
  #env: ServiceEnv;
  #identity: Promise<BotIdentity> | null = null;

  constructor(env: ServiceEnv) {
    this.#env = env;
  }

  // Cached for the process lifetime: the bot token's identity never changes
  // while the token is valid. Failures clear the cache so the next call retries.
  botIdentity(): Promise<BotIdentity> {
    this.#identity ??= slackApi<{
      user_id: string;
      team_id: string;
    }>(this.#env, "auth.test", {}).then(
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

  // Channels the bot is a member of, excluding externally shared or pending
  // Slack Connect channels: they must not leak PR titles or videos outside
  // the organization.
  async listBotChannels(): Promise<string[]> {
    const channelIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await slackApi<ConversationsPage>(this.#env, "users.conversations", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const channel of page.channels ?? []) {
        if (channel.is_ext_shared || channel.is_pending_ext_shared) continue;
        channelIds.push(channel.id);
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return channelIds;
  }

  async listUsergroups(): Promise<SlackUsergroup[]> {
    const res = await slackApi<{ usergroups?: Array<{ id: string; handle: string }> }>(
      this.#env,
      "usergroups.list",
      { include_disabled: false },
    );
    return (res.usergroups ?? []).map((group) => ({ id: group.id, handle: group.handle }));
  }

  async postMessage(channelId: string, text: string): Promise<void> {
    await slackApi(this.#env, "chat.postMessage", { channel: channelId, text });
  }

  // response_url replies bypass the Web API: they are short-lived webhook URLs
  // scoped to the triggering interaction.
  async respondEphemeral(responseUrl: string, text: string): Promise<void> {
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
    });
    if (!response.ok) {
      throw new Error(`Slack response_url reply failed: ${response.status} ${await response.text()}`);
    }
  }

  async uploadVideo(cycle: CycleRecord, channelId: string, file: Buffer): Promise<void> {
    if (!this.#env.slackBotToken) throw new Error("SLACK_BOT_TOKEN is not set.");
    const params = new URLSearchParams({
      filename: `feature-rec-${cycle.prNumber}-${cycle.headSha.slice(0, 8)}.mp4`,
      length: String(file.byteLength),
    });
    const uploadUrlResp = await fetch(`https://slack.com/api/files.getUploadURLExternal?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.#env.slackBotToken}` },
    });
    const upload = await uploadUrlResp.json() as { ok: boolean; upload_url: string; file_id: string; error?: string };
    if (!upload.ok) throw new Error(`Slack files.getUploadURLExternal failed: ${upload.error}`);

    const uploadResponse = await fetch(upload.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([new Uint8Array(file)]),
    });
    if (!uploadResponse.ok) {
      throw new Error(`Slack file upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);
    }

    await slackApi(this.#env, "files.completeUploadExternal", {
      files: [{ id: upload.file_id, title: `Feature-Rec PR #${cycle.prNumber}` }],
      channel_id: channelId,
      initial_comment: `Feature-Rec video for ${cycle.owner}/${cycle.repo}#${cycle.prNumber}`,
    });
  }

  async postValidation(
    cycle: CycleRecord,
    channelId: string,
    mention: string | null,
  ): Promise<{ channel: string; ts: string }> {
    const message = await slackApi<{ channel: string; ts: string }>(this.#env, "chat.postMessage", {
      channel: channelId,
      text: `Feature-Rec validation needed for ${cycle.owner}/${cycle.repo}#${cycle.prNumber}`,
      blocks: validationBlocks(cycle, mention),
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
      usergroups.map((usergroup) =>
        slackApi<{ users: string[] }>(this.#env, "usergroups.users.list", {
          usergroup,
          include_disabled: false,
        }),
      ),
    );
    return memberships.some((membership) => membership.users.includes(userId));
  }

  async finalize(
    cycle: CycleRecord,
    state: "accepted" | "rejected" | "superseded",
    detail: string,
  ): Promise<void> {
    if (!cycle.slackChannelId || !cycle.slackMessageTs) return;
    await slackApi(this.#env, "chat.update", {
      channel: cycle.slackChannelId,
      ts: cycle.slackMessageTs,
      text: `Feature-Rec ${state} for ${cycle.owner}/${cycle.repo}#${cycle.prNumber}`,
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
    await slackApi(this.#env, "views.open", {
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
