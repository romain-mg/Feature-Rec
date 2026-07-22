import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("bot_channels")
    .addColumn("team_id", "text", (col) => col.notNull())
    .addColumn("channel_id", "text", (col) => col.notNull())
    .addColumn("joined_at", "timestamptz")
    .addColumn("first_seen_at", "timestamptz", (col) => col.notNull())
    .addColumn("last_seen_at", "timestamptz", (col) => col.notNull())
    .addColumn("left_at", "timestamptz")
    .addPrimaryKeyConstraint("bot_channels_pkey", ["team_id", "channel_id"])
    .execute();

  await db.schema
    .createTable("channel_settings")
    .addColumn("team_id", "text", (col) => col.notNull())
    .addColumn("channel_id", "text", (col) => col.notNull())
    .addColumn("mention", "text")
    .addColumn("approvers", "text")
    .addColumn("updated_by", "text", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull())
    .addPrimaryKeyConstraint("channel_settings_pkey", ["team_id", "channel_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("channel_settings").execute();
  await db.schema.dropTable("bot_channels").execute();
}
