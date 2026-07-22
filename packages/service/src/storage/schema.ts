import type { ColumnType } from "kysely";
import type { ReviewCycleStatus } from "@feature-rec/core";

export interface ReviewCyclesTable {
  id: string;
  cycle_key: string;
  owner: string;
  repo: string;
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

// timestamptz selects come back as Date from `pg`; writes accept ISO strings.
export interface BotChannelsTable {
  team_id: string;
  channel_id: string;
  joined_at: ColumnType<Date | null, string | null | undefined, string | null>;
  first_seen_at: ColumnType<Date, string, string>;
  last_seen_at: ColumnType<Date, string, string>;
  left_at: ColumnType<Date | null, string | null | undefined, string | null>;
}

export interface ChannelSettingsTable {
  team_id: string;
  channel_id: string;
  mention: string | null;
  approvers: string | null;
  updated_by: string;
  updated_at: ColumnType<Date, string, string>;
}

export interface DB {
  review_cycles: ReviewCyclesTable;
  processed_interactions: ProcessedInteractionsTable;
  bot_channels: BotChannelsTable;
  channel_settings: ChannelSettingsTable;
}
