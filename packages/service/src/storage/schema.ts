import type { ColumnType, Generated } from "kysely";
import type { ReviewCycleStatus } from "@feature-rec/core";

export interface ReviewCyclesTable {
  id: string;
  cycle_key: string;
  owner: string | null;
  repo: string | null;
  tenant_id: ColumnType<string | null, string | null | undefined, string | null>;
  repository_id: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  pr_number: number;
  pr_author: string;
  pr_title: string;
  // Legacy config columns: never written anymore, nullable until dropped.
  config_json: ColumnType<string | null, never, never>;
  config_hash: ColumnType<string | null, never, never>;
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

export interface TeamChannelRoutesTable {
  team_id: string;
  selected_channel_id: string;
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

export interface SlackOAuthInstallationsTable {
  id: string;
  state_hash: string | null;
  browser_binding_hash: string | null;
  status: "awaiting_callback" | "exchanging" | "pending" | "consumed" | "expired" | "cancelled";
  created_at: Generated<Date>;
  expires_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  claimed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  claim_id: string | null;
  team_id: string | null;
  bot_user_id: string | null;
  bot_token_ciphertext: string | null;
  consumed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  consumed_tenant_id: string | null;
  consumed_github_installation_id: string | null;
}

export interface DB {
  slack_oauth_installations: SlackOAuthInstallationsTable;
  review_cycles: ReviewCyclesTable;
  processed_interactions: ProcessedInteractionsTable;
  channel_settings: ChannelSettingsTable;
  team_channel_routes: TeamChannelRoutesTable;
  tenants: TenantsTable;
  slack_workspaces: SlackWorkspacesTable;
  slack_token_encryption_key: { id: number; verifier: string };
  github_installations: GitHubInstallationsTable;
}
