import {
  SLACK_MULTIPLE_CHANNELS_MESSAGE,
  SLACK_NO_CHANNEL_MESSAGE,
  slackSelectedChannelUnavailableMessage,
} from "@feature-rec/core";
import type { SlackClient } from "./slack";
import type { CycleStore } from "./storage";

export class ChannelResolutionError extends Error {}

// Resolved at post time from the explicit workspace route and a transient live
// membership poll. Slack membership snapshots are never persisted.
export async function resolveChannel(
  store: Pick<CycleStore, "getSelectedChannelId" | "initializeTeamChannelRoute">,
  slack: SlackClient,
  teamId: string,
): Promise<{ teamId: string; channelId: string; initializedRoute: boolean }> {
  const channelIds = await slack.listBotChannels();
  const selectedChannelId = await store.getSelectedChannelId(teamId);

  if (selectedChannelId) {
    if (!channelIds.includes(selectedChannelId)) {
      throw new ChannelResolutionError(
        slackSelectedChannelUnavailableMessage(selectedChannelId),
      );
    }
    return { teamId, channelId: selectedChannelId, initializedRoute: false };
  }

  if (channelIds.length === 0) throw new ChannelResolutionError(SLACK_NO_CHANNEL_MESSAGE);
  if (channelIds.length > 1) {
    throw new ChannelResolutionError(SLACK_MULTIPLE_CHANNELS_MESSAGE);
  }

  const channelId = channelIds[0];
  const initialized = await store.initializeTeamChannelRoute({ teamId, channelId });
  if (initialized.initializedRoute) return { teamId, channelId, initializedRoute: true };

  // A join event or command won the initialization race. Honor that route,
  // provided it is still represented by the resolver's membership snapshot.
  const currentChannelId = await store.getSelectedChannelId(teamId);
  if (currentChannelId && channelIds.includes(currentChannelId)) {
    return { teamId, channelId: currentChannelId, initializedRoute: false };
  }
  throw new ChannelResolutionError(
    currentChannelId
      ? slackSelectedChannelUnavailableMessage(currentChannelId)
      : SLACK_NO_CHANNEL_MESSAGE,
  );
}
