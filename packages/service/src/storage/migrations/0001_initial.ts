import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("review_cycles")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("cycle_key", "text", (col) => col.notNull().unique())
    .addColumn("owner", "text", (col) => col.notNull())
    .addColumn("repo", "text", (col) => col.notNull())
    .addColumn("pr_number", "integer", (col) => col.notNull())
    .addColumn("pr_author", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("pr_title", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("config_json", "text", (col) => col.notNull())
    .addColumn("head_sha", "text", (col) => col.notNull())
    .addColumn("config_hash", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("attempt_id", "text", (col) => col.notNull())
    // GitHub check run IDs can exceed int4, so bigint (SQLite integer was 64-bit).
    .addColumn("check_run_id", "bigint")
    .addColumn("slack_channel_id", "text")
    .addColumn("slack_message_ts", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("processed_interactions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("cycle_id", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("processed_interactions").execute();
  await db.schema.dropTable("review_cycles").execute();
}
