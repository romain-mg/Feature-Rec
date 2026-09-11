import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("slack_oauth_installations")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("state_hash", "text", (c) => c.unique())
    .addColumn("browser_binding_hash", "text")
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`clock_timestamp()`))
    .addColumn("expires_at", "timestamptz")
    .addColumn("claimed_at", "timestamptz")
    .addColumn("claim_id", "uuid")
    .addColumn("team_id", "text")
    .addColumn("bot_user_id", "text")
    .addColumn("bot_token_ciphertext", "text")
    .addColumn("consumed_at", "timestamptz")
    // Historical receipt values survive later integration removal/reinstallation.
    .addColumn("consumed_tenant_id", "uuid")
    .addColumn("consumed_github_installation_id", "bigint")
    .addCheckConstraint("slack_oauth_status_check", sql`
      status in ('awaiting_callback', 'exchanging', 'pending', 'consumed', 'expired', 'cancelled')`)
    .addCheckConstraint("slack_oauth_expiry_check", sql`
      (status in ('pending', 'consumed') and expires_at is null)
      or (status not in ('pending', 'consumed') and expires_at is not null)`)
    .addCheckConstraint("slack_oauth_session_check", sql`
      (status in ('awaiting_callback', 'exchanging')
        and state_hash is not null and state_hash ~ '^[0-9a-f]{64}$'
        and browser_binding_hash is not null and browser_binding_hash ~ '^[0-9a-f]{64}$')
      or (status not in ('awaiting_callback', 'exchanging')
        and state_hash is null and browser_binding_hash is null)`)
    .addCheckConstraint("slack_oauth_claim_check", sql`
      (status = 'exchanging' and claim_id is not null and claimed_at is not null)
      or (status <> 'exchanging' and claim_id is null)`)
    .addCheckConstraint("slack_oauth_token_check", sql`
      (status = 'pending' and bot_token_ciphertext is not null and length(bot_token_ciphertext) > 0)
      or (status <> 'pending' and bot_token_ciphertext is null)`)
    .addCheckConstraint("slack_oauth_identity_check", sql`
      status not in ('pending', 'consumed')
      or (team_id is not null and length(team_id) > 0
        and bot_user_id is not null and length(bot_user_id) > 0 and claimed_at is not null)`)
    .addCheckConstraint("slack_oauth_consumption_check", sql`
      (status = 'consumed' and consumed_at is not null and consumed_tenant_id is not null
        and consumed_github_installation_id is not null and consumed_github_installation_id > 0)
      or (status <> 'consumed' and consumed_at is null and consumed_tenant_id is null
        and consumed_github_installation_id is null)`)
    .execute();
  await db.schema.createIndex("slack_oauth_expiry_idx")
    .on("slack_oauth_installations").column("expires_at").execute();
  await db.schema.createIndex("slack_oauth_consumed_idx")
    .on("slack_oauth_installations").column("consumed_at")
    .where(sql`status`, "=", "consumed").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Serialize the guard with session writes; even expired rows need cancellation/cleanup.
  await sql`lock table slack_oauth_installations in access exclusive mode`.execute(db);
  const active = await sql<{ present: boolean }>`select exists (
    select 1 from slack_oauth_installations
    where status in ('awaiting_callback', 'exchanging', 'pending')
  ) as present`.execute(db);
  if (active.rows[0]?.present) {
    throw new Error("Cancel pending Slack OAuth installations before rolling back 0009_slack_oauth_installations");
  }
  await db.schema.dropTable("slack_oauth_installations").execute();
}
