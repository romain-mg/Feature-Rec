import crypto from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { decryptSlackToken } from "../slack-token-crypto";
import type { DB } from "./schema";

// A typed boundary lets callers classify key configuration failures without
// inspecting or exposing exception messages.
export class SlackTokenKeyError extends Error {}

function keyVerifier(key: Buffer): string {
  if (key.byteLength !== 32) throw new SlackTokenKeyError("Slack token encryption key is invalid");
  return crypto.createHmac("sha256", key).update("feature-rec:slack-token-key-check:v1").digest("base64");
}

function matchesVerifier(key: Buffer, verifier: string): boolean {
  const expected = Buffer.from(keyVerifier(key));
  const actual = Buffer.from(verifier);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Caller holds the provisioning lock; pin the key in the same transaction as the first token.
export async function ensureSlackTokenKey(trx: Transaction<DB>, key: Buffer): Promise<void> {
  const row = await trx.selectFrom("slack_token_encryption_key").select("verifier").where("id", "=", 1).executeTakeFirst();
  if (row) {
    if (!matchesVerifier(key, row.verifier)) throw new SlackTokenKeyError("Slack token encryption key does not match the database verifier");
    return;
  }
  const workspace = await trx.selectFrom("slack_workspaces").select("team_id").limit(1).executeTakeFirst();
  const pending = await trx.selectFrom("slack_oauth_installations").select("id")
    .where("bot_token_ciphertext", "is not", null).limit(1).executeTakeFirst();
  if (workspace || pending) throw new SlackTokenKeyError("Slack token key verifier is missing; restore it from backup before writing tokens");
  await trx.insertInto("slack_token_encryption_key").values({ id: 1, verifier: keyVerifier(key) }).execute();
}

export async function inspectSlackTokenEncryption(db: Kysely<DB>, key: Buffer | null): Promise<{
  keyError: string | null;
  invalidWorkspaces: Array<{ tenantId: string; teamId: string }>;
  invalidPendingInstallations: Array<{ id: string; teamId: string }>;
}> {
  // One snapshot covers first-time provisioning and tokens staged before any tenant exists.
  const { rows } = await sql<{
    verifier: string | null; kind: "workspace" | "pending" | null;
    id: string | null; team_id: string | null; bot_token_ciphertext: string | null;
  }>`with credentials as (
    select 'workspace' as kind, tenant_id::text as id, team_id, bot_token_ciphertext from slack_workspaces
    union all
    select 'pending', id::text, team_id, bot_token_ciphertext from slack_oauth_installations
    where bot_token_ciphertext is not null
  ) select key.verifier, credentials.* from slack_token_encryption_key key
    full join credentials on true`.execute(db);
  const invalidWorkspaces: Array<{ tenantId: string; teamId: string }> = [];
  const invalidPendingInstallations: Array<{ id: string; teamId: string }> = [];
  const result = { keyError: null as string | null, invalidWorkspaces, invalidPendingInstallations };
  if (rows.length === 0) return result;
  if (!key) return { ...result, keyError: "FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY is required when a Slack token key, workspace or pending installation is stored" };
  const verifier = rows[0].verifier;
  if (!verifier || !matchesVerifier(key, verifier)) {
    return { ...result, keyError: verifier ? "Slack token encryption key does not match the database verifier" : "Slack token key verifier is missing; restore it from backup" };
  }
  for (const credential of rows) {
    if (!credential.kind || !credential.id || !credential.team_id) continue;
    try {
      decryptSlackToken({ envelope: credential.bot_token_ciphertext!, teamId: credential.team_id, key });
    } catch {
      if (credential.kind === "workspace") invalidWorkspaces.push({ tenantId: credential.id, teamId: credential.team_id });
      else invalidPendingInstallations.push({ id: credential.id, teamId: credential.team_id });
    }
  }
  return result;
}
