import type { Kysely } from "kysely";
import { sql } from "kysely";

// The config system is gone: new cycles no longer carry a config payload or
// hash. The columns stay (nullable) so a rollback still finds them; drop them
// in a later migration once the config-less deploy has settled.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("review_cycles")
    .alterColumn("config_json", (col) => col.dropNotNull())
    .execute();
  await db.schema
    .alterTable("review_cycles")
    .alterColumn("config_hash", (col) => col.dropNotNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Backfill rows written by config-less code so SET NOT NULL can validate.
  // The payload is schema-valid for the old reader; those cycles are dead to
  // the old code either way, this only keeps a rollback bootable.
  await sql`
    update review_cycles
    set config_json = coalesce(
          config_json,
          '{"version":1,"slack":{"channel":"unknown","mention":"","approverUsergroups":[]}}'
        ),
        config_hash = coalesce(config_hash, '0000000000000000')
    where config_json is null or config_hash is null
  `.execute(db);
  await db.schema
    .alterTable("review_cycles")
    .alterColumn("config_json", (col) => col.setNotNull())
    .execute();
  await db.schema
    .alterTable("review_cycles")
    .alterColumn("config_hash", (col) => col.setNotNull())
    .execute();
}
