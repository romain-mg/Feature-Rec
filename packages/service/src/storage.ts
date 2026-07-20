import type { ReviewCycle, ReviewCycleStatus, RunStartRequest } from "@feature-rec/core";

export type CycleRecord = ReviewCycle & {
  prAuthor: string;
  prTitle: string;
};

export type StartCycleResult = {
  cycle: CycleRecord;
  superseded: CycleRecord[];
} & (
  | { created: true; attemptId: string }
  | { created: false; attemptId: null }
);

export type BotChannel = {
  teamId: string;
  channelId: string;
  joinedAt: string | null;
  firstSeenAt: string;
};

export type ChannelSettings = {
  // Rendered mrkdwn mention prefix; null = default (@here), "" = off.
  mention: string | null;
  // Slack S…/U… ids; null = everyone in the channel may approve.
  approvers: string[] | null;
};

export type CycleStore = {
  startCycle(input: RunStartRequest & { cycleKey: string }): Promise<StartCycleResult>;
  getCycle(id: string): Promise<CycleRecord | null>;
  getCycleByKey(cycleKey: string): Promise<CycleRecord | null>;
  attachCheckRun(cycleId: string, checkRunId: number): Promise<ReviewCycleStatus>;
  // Runner-initiated transition: the attempt token is required, so ownership is
  // enforced by the compiler rather than by convention.
  transitionRunnerStatus(input: {
    cycleId: string;
    attemptId: string;
    from: ReviewCycleStatus[];
    to: ReviewCycleStatus;
  }): Promise<CycleRecord | null>;
  // Slack-initiated transition: no attempt token — Slack acts on the cycle, not
  // on a runner attempt. Guarded by status only.
  transitionSlackStatus(input: {
    cycleId: string;
    from: ReviewCycleStatus[];
    to: ReviewCycleStatus;
  }): Promise<CycleRecord | null>;
  attachSlackMessage(
    cycleId: string,
    channelId: string,
    messageTs: string,
  ): Promise<ReviewCycleStatus>;
  recordProcessedInteraction(id: string, cycleId: string): Promise<boolean>;
  // Reconcile bot channel membership from a poll: upsert first/last seen,
  // mark missing rows left, and reset ordering on rejoin. seenAt is when the
  // snapshot was taken, so rows seen since then are never reaped by stale data.
  syncBotChannels(input: {
    teamId: string;
    enterpriseId: string | null;
    channelIds: string[];
    seenAt: string;
  }): Promise<void>;
  // Channels the bot is currently in, oldest introduction first.
  activeBotChannels(teamId: string): Promise<BotChannel[]>;
  recordChannelJoin(input: {
    teamId: string;
    enterpriseId: string | null;
    channelId: string;
    joinedAt: string;
  }): Promise<void>;
  recordChannelLeave(input: {
    teamId: string;
    channelId: string;
    leftAt: string;
  }): Promise<void>;
  getChannelSettings(teamId: string, channelId: string): Promise<ChannelSettings | null>;
  setMention(input: {
    teamId: string;
    channelId: string;
    mention: string;
    updatedBy: string;
  }): Promise<void>;
  setApprovers(input: {
    teamId: string;
    channelId: string;
    approvers: string[] | null;
    updatedBy: string;
  }): Promise<void>;
  close(): Promise<void>;
};
