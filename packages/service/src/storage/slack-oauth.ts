import crypto from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { decryptSlackToken, encryptSlackToken } from "../slack-token-crypto";
import type { DB, SlackOAuthInstallationsTable } from "./schema";
import { lockTenantProvisioning } from "./locks";
import { ensureSlackTokenKey } from "./slack-token-check";

const SecretSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/);
const UuidSchema = z.string().uuid();
const CredentialsSchema = z.object({
  teamId: z.string().regex(/^T[A-Z0-9]+$/),
  botUserId: z.string().regex(/^[UW][A-Z0-9]+$/),
  token: z.string().min(1).max(4096),
}).refine((v) => Object.values(v).every((s) => !/\s/.test(s)));

function hash(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function validSecrets(input: { state: string; browserBinding: string }): boolean {
  return SecretSchema.safeParse(input.state).success && SecretSchema.safeParse(input.browserBinding).success;
}

const clearSecrets = { state_hash: null, browser_binding_hash: null, claim_id: null, bot_token_ciphertext: null };

export async function createSlackOAuthSession(db: Kysely<DB>) {
  const state = crypto.randomBytes(32).toString("base64url");
  const browserBinding = crypto.randomBytes(32).toString("base64url");
  const row = await db.insertInto("slack_oauth_installations").values({
    ...clearSecrets,
    id: crypto.randomUUID(), state_hash: hash(state), browser_binding_hash: hash(browserBinding),
    status: "awaiting_callback", expires_at: sql`clock_timestamp() + interval '10 minutes'`,
    claimed_at: null, team_id: null, bot_user_id: null,
    consumed_at: null, consumed_tenant_id: null, consumed_github_installation_id: null,
  }).returning(["id", "expires_at as expiresAt"]).executeTakeFirstOrThrow();
  // These two secrets leave storage only at creation, for the redirect/cookies.
  return { ...row, state, browserBinding };
}

export async function hasSlackOAuthBrowserBinding(db: Kysely<DB>, input: { state: string; browserBinding: string }): Promise<boolean> {
  if (!validSecrets(input)) return false;
  const row = await db.selectFrom("slack_oauth_installations").select("id")
    .where("state_hash", "=", hash(input.state)).where("browser_binding_hash", "=", hash(input.browserBinding))
    .where("status", "=", "awaiting_callback").where("expires_at", ">", sql<Date>`clock_timestamp()`)
    .executeTakeFirst();
  return row !== undefined;
}

export async function claimSlackOAuthSession(db: Kysely<DB>, input: { state: string; browserBinding: string }) {
  if (!validSecrets(input)) return null;
  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("slack_oauth_installations").select("id")
      .where("state_hash", "=", hash(input.state)).where("browser_binding_hash", "=", hash(input.browserBinding))
      .where("status", "=", "awaiting_callback").forUpdate().executeTakeFirst();
    if (!row) return null;
    // Check the database clock AFTER acquiring the row lock, including wait time.
    const claimId = crypto.randomUUID();
    const claimed = await trx.updateTable("slack_oauth_installations")
      .set({ status: "exchanging", claim_id: claimId, claimed_at: sql`clock_timestamp()` })
      .where("id", "=", row.id).where("expires_at", ">", sql<Date>`clock_timestamp()`)
      .returning("id").executeTakeFirst();
    return claimed ? { id: claimed.id, claimId } : null;
  });
}

export async function stageSlackOAuthInstallation(db: Kysely<DB>, input: {
  id: string; claimId: string; teamId: string; botUserId: string; token: string; encryptionKey: Buffer;
}): Promise<boolean> {
  if (!UuidSchema.safeParse(input.id).success || !UuidSchema.safeParse(input.claimId).success) return false;
  if (!CredentialsSchema.safeParse(input).success) throw new Error("Invalid pending Slack installation credentials");
  // The callback must first validate the configured app, scopes and live Slack identity.
  const ciphertext = encryptSlackToken({ token: input.token, teamId: input.teamId, key: input.encryptionKey });
  const expiredSession = new Error("Slack OAuth session expired while staging");
  return db.transaction().execute(async (trx) => {
    await lockTenantProvisioning(trx);
    const row = await trx.selectFrom("slack_oauth_installations").select("id")
      .where("id", "=", input.id).where("claim_id", "=", input.claimId)
      .where("status", "=", "exchanging").where("expires_at", ">", sql<Date>`clock_timestamp()`)
      .forUpdate().executeTakeFirst();
    if (!row) return false;
    // Verify/pin the deployment key before writing; no bootstrap exemption.
    await ensureSlackTokenKey(trx, input.encryptionKey);
    const updated = await trx.updateTable("slack_oauth_installations").set({
      ...clearSecrets, status: "pending", team_id: input.teamId, bot_user_id: input.botUserId,
      bot_token_ciphertext: ciphertext, expires_at: null,
    }).where("id", "=", row.id).where("expires_at", ">", sql<Date>`clock_timestamp()`)
      .returning("id").executeTakeFirst();
    // Throw so late expiry also rolls back a verifier inserted by the guard.
    if (!updated) throw expiredSession;
    return true;
  }).catch((error: unknown) => {
    if (error === expiredSession) return false;
    throw error;
  });
}

export async function getSlackOAuthInstallationStatus(db: Kysely<DB>, id: string) {
  if (!UuidSchema.safeParse(id).success) return null;
  return await db.selectFrom("slack_oauth_installations").select([
    "id", "team_id as teamId", "bot_user_id as botUserId", "created_at as createdAt",
    "expires_at as expiresAt", "claimed_at as claimedAt", "consumed_at as consumedAt",
    "consumed_tenant_id as consumedTenantId", "consumed_github_installation_id as consumedGitHubInstallationId",
    sql<SlackOAuthInstallationsTable["status"]>`case
      when status in ('awaiting_callback', 'exchanging') and expires_at <= clock_timestamp() then 'expired'
      else status end`.as("status"),
  ]).where("id", "=", id).executeTakeFirst() ?? null;
}

// Internal validation/provisioning only. Runtime Slack handlers never read this table.
export async function readPendingSlackOAuthInstallation(db: Kysely<DB>, id: string, encryptionKey: Buffer) {
  if (!UuidSchema.safeParse(id).success) return null;
  const row = await db.selectFrom("slack_oauth_installations")
    .select(["id", "team_id", "bot_user_id", "bot_token_ciphertext"])
    .where("id", "=", id).where("status", "=", "pending").executeTakeFirst();
  if (!row) return null;
  let token: string;
  try {
    token = decryptSlackToken({ envelope: row.bot_token_ciphertext!, teamId: row.team_id!, key: encryptionKey });
  } catch {
    throw new Error("Pending Slack installation token cannot be decrypted");
  }
  return { id: row.id, teamId: row.team_id!, botUserId: row.bot_user_id!, token,
    expectedCiphertext: row.bot_token_ciphertext! };
}

// Called inside the SAME transaction as validated integration writes/activation.
// Throw on failure so those writes cannot commit with an unconsumed token.
export async function consumeSlackOAuthInstallation(trx: Transaction<DB>, input: {
  id: string; expectedCiphertext: string; tenantId: string; githubInstallationId: string; encryptionKey: Buffer;
}): Promise<void> {
  if (!trx.isTransaction) throw new Error("Slack OAuth consumption requires a provisioning transaction");
  if (!UuidSchema.safeParse(input.id).success || !UuidSchema.safeParse(input.tenantId).success ||
      !/^[1-9][0-9]*$/.test(input.githubInstallationId) || input.githubInstallationId.length > 19 ||
      BigInt(input.githubInstallationId) > 9223372036854775807n) {
    throw new Error("Invalid Slack OAuth consumption identifiers");
  }
  await lockTenantProvisioning(trx);
  await ensureSlackTokenKey(trx, input.encryptionKey);
  const pending = await trx.selectFrom("slack_oauth_installations").select(["id", "team_id", "bot_user_id"])
    .where("id", "=", input.id).where("status", "=", "pending")
    .where("bot_token_ciphertext", "=", input.expectedCiphertext).forUpdate().executeTakeFirst();
  if (!pending) throw new Error("Pending Slack installation is unavailable");
  const pairing = await trx.selectFrom("slack_workspaces as sw")
    .innerJoin("tenants as t", "t.id", "sw.tenant_id")
    .innerJoin("github_installations as gi", "gi.tenant_id", "t.id")
    .select("sw.bot_token_ciphertext").where("t.id", "=", input.tenantId).where("t.enabled", "=", true)
    .where("sw.team_id", "=", pending.team_id!).where("sw.bot_user_id", "=", pending.bot_user_id!)
    .where("gi.installation_id", "=", input.githubInstallationId).executeTakeFirst();
  if (!pairing) throw new Error("Slack OAuth consumption requires the activated matching integrations");
  // Provisioning must transfer the precise envelope validated before this
  // transaction. Equal plaintext under another IV is not the checked version.
  if (pairing.bot_token_ciphertext !== input.expectedCiphertext) {
    throw new Error("Slack OAuth consumption requires the activated matching token envelope");
  }
  await trx.updateTable("slack_oauth_installations").set({
    ...clearSecrets, status: "consumed", consumed_at: sql`clock_timestamp()`,
    consumed_tenant_id: input.tenantId, consumed_github_installation_id: input.githubInstallationId,
  }).where("id", "=", input.id).execute();
}

export async function cancelSlackOAuthInstallation(db: Kysely<DB>, id: string): Promise<boolean> {
  if (!UuidSchema.safeParse(id).success) return false;
  const row = await db.updateTable("slack_oauth_installations")
    .set({ ...clearSecrets, status: "cancelled", expires_at: sql`clock_timestamp()` })
    .where("id", "=", id).where("status", "in", ["awaiting_callback", "exchanging", "pending"])
    .returning("id").executeTakeFirst();
  return row !== undefined;
}

export async function cleanupSlackOAuthInstallations(db: Kysely<DB>, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("OAuth cleanup batch size must be between 1 and 1000");
  return db.transaction().execute(async (trx) => {
    const rows = await trx.selectFrom("slack_oauth_installations").select([
      "id", sql<boolean>`coalesce(consumed_at, expires_at) <= clock_timestamp() - interval '24 hours'`.as("purge"),
    ]).where((eb) => eb.or([
      eb.and([eb("status", "in", ["awaiting_callback", "exchanging"]), eb("expires_at", "<=", sql<Date>`clock_timestamp()`)]),
      eb.and([eb("status", "in", ["awaiting_callback", "exchanging", "expired", "cancelled", "consumed"]),
        sql<boolean>`coalesce(consumed_at, expires_at) <= clock_timestamp() - interval '24 hours'`]),
    ])).orderBy("expires_at").orderBy("id").limit(limit).forUpdate().skipLocked().execute();
    const purge = rows.filter((r) => r.purge).map((r) => r.id);
    const expire = rows.filter((r) => !r.purge).map((r) => r.id);
    if (purge.length) await trx.deleteFrom("slack_oauth_installations").where("id", "in", purge).execute();
    if (expire.length) await trx.updateTable("slack_oauth_installations")
      .set({ ...clearSecrets, status: "expired" }).where("id", "in", expire).execute();
    return { expired: expire.length, deleted: purge.length };
  });
}
