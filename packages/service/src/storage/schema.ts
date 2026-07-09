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
  config_json: string;
  head_sha: string;
  config_hash: string;
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

export interface DB {
  review_cycles: ReviewCyclesTable;
  processed_interactions: ProcessedInteractionsTable;
}
