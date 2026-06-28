import crypto from "node:crypto";
import type { FeatureRecConfig, SlackApprovalPayload } from "@feature-rec/core";
import type { ServiceEnv } from "./env";
import type { CycleRecord } from "./storage";

type SlackResponse<T> = T & { ok: boolean; error?: string };

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

function validationBlocks(config: FeatureRecConfig, cycle: CycleRecord): unknown[] {
  const title = `Feature-Rec validation needed for ${cycle.owner}/${cycle.repo}#${cycle.prNumber}`;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${config.slack.mention ? `${config.slack.mention}\n` : ""}*${title}*\n${cycle.prTitle || "Frontend-visible change detected."}`,
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

export class SlackClient {
  #env: ServiceEnv;

  constructor(env: ServiceEnv) {
    this.#env = env;
  }

  async uploadVideo(config: FeatureRecConfig, cycle: CycleRecord, file: Buffer): Promise<void> {
    const upload = await slackApi<{ upload_url: string; file_id: string }>(
      this.#env,
      "files.getUploadURLExternal",
      {
        filename: `feature-rec-${cycle.prNumber}-${cycle.headSha.slice(0, 8)}.mp4`,
        length: file.byteLength,
      },
    );

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
      channel_id: config.slack.channel,
      initial_comment: `Feature-Rec video for ${cycle.owner}/${cycle.repo}#${cycle.prNumber}`,
    });
  }

  async postValidation(config: FeatureRecConfig, cycle: CycleRecord): Promise<{ channel: string; ts: string }> {
    const message = await slackApi<{ channel: string; ts: string }>(this.#env, "chat.postMessage", {
      channel: config.slack.channel,
      text: `Feature-Rec validation needed for ${cycle.owner}/${cycle.repo}#${cycle.prNumber}`,
      blocks: validationBlocks(config, cycle),
    });
    return { channel: message.channel, ts: message.ts };
  }

  async isApprover(config: FeatureRecConfig, userId: string | undefined): Promise<boolean> {
    const usergroups = config.slack.approverUsergroups;
    if (usergroups.length === 0) return true;
    if (!userId) return false;

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

  async openRequestChangesModal(triggerId: string, cycle: CycleRecord): Promise<void> {
    await slackApi(this.#env, "views.open", {
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "feature_rec_request_changes_modal",
        private_metadata: JSON.stringify({ cycleId: cycle.id, headSha: cycle.headSha }),
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
