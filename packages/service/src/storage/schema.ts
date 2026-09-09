import type { ColumnType } from "kysely";
import type { ReviewCycleStatus } from "@feature-rec/core";

// Legacy columns (owner, repo, config_json, config_hash) physically remain
// until the 0010 contract migration but are absent here so no code path can
// read or write them.
export interface ReviewCyclesTable {
  id: string;
  cycle_key: string;
  tenant_id: string;
  repository_id: string;
  pr_number: number;
  pr_author: string;
  pr_title: string;
  head_sha: string;
  status: ReviewCycleStatus;
  attempt_id: string;
  // int8 selects come back as strings from `pg`; writes accept numbers.
  check_run_id: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  slack_channel_id: ColumnType<string | null, string | null | undefined, string | null>;
  slack_message_ts: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: string;
  updated_at: string;
}

export interface ProcessedInteractionsTable {
  id: string;
  cycle_id: string;
  created_at: string;
}

export interface ChannelSettingsTable {
  team_id: string;
  channel_id: string;
  mention_mode: "approvers" | "custom" | "off";
  mention_audience: string | null;
  approvers: string | null;
  updated_by: string;
  updated_at: ColumnType<Date, string, string>;
}

export interface TenantsTable {
  id: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface SlackWorkspacesTable {
  team_id: string;
  tenant_id: string;
  bot_user_id: string;
  bot_token_ciphertext: string;
  selected_channel_id: string | null;
}

export interface GitHubInstallationsTable {
  installation_id: string;
  tenant_id: string;
  github_account_id: string;
}

export interface DB {
  review_cycles: ReviewCyclesTable;
  processed_interactions: ProcessedInteractionsTable;
  channel_settings: ChannelSettingsTable;
  tenants: TenantsTable;
  slack_workspaces: SlackWorkspacesTable;
  slack_token_encryption_key: { id: number; verifier: string };
  github_installations: GitHubInstallationsTable;
}
