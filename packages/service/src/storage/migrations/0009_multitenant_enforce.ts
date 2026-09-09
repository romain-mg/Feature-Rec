import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  const nullCycles = await sql<{ count: string }>`
    select count(*)::text as count
    from review_cycles
    where tenant_id is null or repository_id is null
  `.execute(db);
  if (nullCycles.rows[0]?.count !== "0") {
    throw new Error(
      "Cannot apply 0009_multitenant_enforce: review_cycles rows lack tenant/repository identity; complete the backfill and cutover first",
    );
  }

  const orphanSettings = await sql<{ count: string }>`
    select count(*)::text as count
    from channel_settings cs
    left join slack_workspaces sw on sw.team_id = cs.team_id
    where sw.team_id is null
  `.execute(db);
  if (orphanSettings.rows[0]?.count !== "0") {
    throw new Error(
      "Cannot apply 0009_multitenant_enforce: channel_settings rows refer to an absent Slack workspace",
    );
  }

  await db.schema.alterTable("review_cycles").alterColumn("tenant_id", (col) => col.setNotNull()).execute();
  await db.schema.alterTable("review_cycles").alterColumn("repository_id", (col) => col.setNotNull()).execute();
  await db.schema
    .alterTable("channel_settings")
    .addForeignKeyConstraint(
      "channel_settings_team_id_fkey",
      ["team_id"],
      "slack_workspaces",
      ["team_id"],
    )
    .onDelete("cascade")
    .execute();
}

// Non-destructive by design: dropping the constraints makes a C-to-B rollback
// possible after this migration record is removed with the deploy-C artifact.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("channel_settings").dropConstraint("channel_settings_team_id_fkey").execute();
  await db.schema.alterTable("review_cycles").alterColumn("repository_id", (col) => col.dropNotNull()).execute();
  await db.schema.alterTable("review_cycles").alterColumn("tenant_id", (col) => col.dropNotNull()).execute();
}
