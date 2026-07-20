import { SLACK_NO_CHANNEL_MESSAGE } from "@feature-rec/core";
import type { SlackClient } from "./slack";
import type { BotChannel, CycleStore } from "./storage";

export class ChannelResolutionError extends Error {}

export type TenantChannels = {
  teamId: string;
  channels: BotChannel[];
};

// One membership sweep per call: poll Slack, reconcile bot_channels, and
// return the tenant's active channels, oldest introduction first. The tenant
// is the bot token's workspace today; multitenancy replaces only that lookup.
export async function syncTenantChannels(
  store: CycleStore,
  slack: SlackClient,
): Promise<TenantChannels> {
  const identity = await slack.botIdentity();
  const seenAt = new Date().toISOString();
  const channelIds = await slack.listBotChannels();
  await store.syncBotChannels({
    teamId: identity.teamId,
    enterpriseId: identity.enterpriseId,
    channelIds,
    seenAt,
  });
  const channels = await store.activeBotChannels(identity.teamId);
  return { teamId: identity.teamId, channels };
}

// Resolved at post time, never from cached config: removing the bot from the
// active channel promotes the next oldest on the very next post.
export async function resolveChannel(
  store: CycleStore,
  slack: SlackClient,
): Promise<{ teamId: string; channelId: string }> {
  const { teamId, channels } = await syncTenantChannels(store, slack);
  const active = channels[0];
  if (!active) throw new ChannelResolutionError(SLACK_NO_CHANNEL_MESSAGE);
  return { teamId, channelId: active.channelId };
}
