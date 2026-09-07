import type { ReviewCycle, ReviewCycleStatus } from "@feature-rec/core";

export type CycleRecord = ReviewCycle & {
  prAuthor: string;
  prTitle: string;
};

// Identity and PR metadata are supplied by verified GitHub access, never by
// the public runner payload. Names are written only for the rollback window.
export type StartCycleInput = {
  tenantId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  prAuthor: string;
  prTitle: string;
  cycleKey: string;
};

export type GitHubInstallation = {
  tenantId: string;
  installationId: string;
  githubAccountId: string;
  enabled: boolean;
};

export type SlackWorkspace = {
  tenantId: string;
  teamId: string;
  botUserId: string;
  botTokenCiphertext: string;
  selectedChannelId: string | null;
  enabled: boolean;
};

export type StartCycleResult = {
  cycle: CycleRecord;
  superseded: CycleRecord[];
} & (
  | { created: true; attemptId: string }
  | { created: false; attemptId: null }
);

export type MentionSetting =
  | { mode: "approvers" }
  | { mode: "off" }
  | { mode: "custom"; audience: string };

export type ChannelSettings = {
  mention: MentionSetting;
  // Slack S…/U… ids; null = everyone in the channel may approve.
  approvers: string[] | null;
};

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = {
  mention: { mode: "approvers" },
  approvers: null,
};

export class SlackWorkspaceUnavailableError extends Error {
  constructor() { super("Slack workspace is no longer installed or enabled"); }
}

export type CycleStore = {
  startCycle(input: StartCycleInput): Promise<StartCycleResult>;
  getEnabledGitHubInstallationByAccountId(accountId: string): Promise<GitHubInstallation | null>;
  getGitHubInstallationByTenantId(tenantId: string): Promise<GitHubInstallation | null>;
  getSlackWorkspaceByTeamId(teamId: string): Promise<SlackWorkspace | null>;
  getSlackWorkspaceByTenantId(tenantId: string): Promise<SlackWorkspace | null>;
  deleteSlackWorkspace(teamId: string, expectedTokenCiphertext: string): Promise<boolean>;
  getCycle(id: string): Promise<CycleRecord | null>;
  getCycleByKey(cycleKey: string): Promise<CycleRecord | null>;
  attachCheckRun(cycleId: string, checkRunId: number): Promise<ReviewCycleStatus>;
  // Runner-initiated transition: the attempt token is required, so ownership is
  // enforced by the compiler rather than by convention.
  transitionRunnerStatus(input: {
    cycleId: string;
    tenantId: string;
    repositoryId: string;
    attemptId: string;
    from: ReviewCycleStatus[];
    to: ReviewCycleStatus;
  }): Promise<CycleRecord | null>;
  // Slack-initiated transition: no attempt token — Slack acts on the cycle, not
  // on a runner attempt. Guarded by the signed workspace's tenant and status.
  transitionSlackStatus(input: {
    cycleId: string;
    tenantId: string;
    from: ReviewCycleStatus[];
    to: ReviewCycleStatus;
  }): Promise<CycleRecord | null>;
  attachSlackMessage(
    cycleId: string,
    channelId: string,
    messageTs: string,
  ): Promise<ReviewCycleStatus>;
  recordProcessedInteraction(id: string, cycleId: string): Promise<boolean>;
  getSelectedChannelId(teamId: string): Promise<string | null>;
  initializeTeamChannelRoute(input: {
    teamId: string;
    channelId: string;
  }): Promise<{ initializedRoute: boolean }>;
  selectTeamChannel(input: {
    teamId: string;
    channelId: string;
  }): Promise<void>;
  // Missing rows resolve to DEFAULT_CHANNEL_SETTINGS without inserting.
  getChannelSettings(teamId: string, channelId: string): Promise<ChannelSettings>;
  setSelectedChannelMentionSetting(input: {
    teamId: string;
    expectedChannelId: string;
    mention: MentionSetting;
    updatedBy: string;
  }): Promise<boolean>;
  setSelectedChannelApprovers(input: {
    teamId: string;
    expectedChannelId: string;
    approvers: string[] | null;
    updatedBy: string;
  }): Promise<boolean>;
  close(): Promise<void>;
};
