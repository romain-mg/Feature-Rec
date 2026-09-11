import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Migrator } from "kysely/migration";
import { Client, Pool } from "pg";
import { decryptSlackToken, encryptSlackToken } from "../src/slack-token-crypto";
import { lockTenantProvisioning } from "../src/storage/locks";
import { migrationProvider } from "../src/storage/migrations";
import type { DB } from "../src/storage/schema";
import {
  cancelSlackOAuthInstallation,
  claimSlackOAuthSession,
  cleanupSlackOAuthInstallations,
  consumeSlackOAuthInstallation,
  createSlackOAuthSession,
  getSlackOAuthInstallationStatus,
  hasSlackOAuthBrowserBinding,
  readPendingSlackOAuthInstallation,
  stageSlackOAuthInstallation,
} from "../src/storage/slack-oauth";
import { ensureSlackTokenKey, inspectSlackTokenEncryption } from "../src/storage/slack-token-check";

const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const dbName = `feature_rec_oauth_storage_test_${crypto.randomBytes(8).toString("hex")}`;
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
const testUrl = url.toString();
const connect = () => new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({
  connectionString: testUrl, application_name: "feature-rec-oauth-storage-selftest",
}) }) });
const db = connect();
let replica = connect();
const key = Buffer.alloc(32, 19);
const wrongKey = Buffer.alloc(32, 20);
const raw = (id: string) => db.selectFrom("slack_oauth_installations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

async function pending(teamId: string, token = `xoxb-${teamId}`) {
  const session = await createSlackOAuthSession(db);
  const claim = await claimSlackOAuthSession(db, session);
  assert.ok(claim);
  assert.equal(await stageSlackOAuthInstallation(db, { ...claim, teamId, botUserId: `U${teamId}`, token, encryptionKey: key }), true);
  const staged = await readPendingSlackOAuthInstallation(db, session.id, key);
  assert.ok(staged);
  return staged;
}

type Pending = NonNullable<Awaited<ReturnType<typeof readPendingSlackOAuthInstallation>>>;
async function activate(trx: Transaction<DB>, installation: Pending, tenantId: string, githubId: string) {
  await lockTenantProvisioning(trx);
  await trx.insertInto("tenants").values({ id: tenantId, enabled: false }).execute();
  await trx.insertInto("slack_workspaces").values({
    team_id: installation.teamId, tenant_id: tenantId, bot_user_id: installation.botUserId,
    bot_token_ciphertext: installation.expectedCiphertext,
    selected_channel_id: `C${installation.teamId}`,
  }).execute();
  await trx.insertInto("github_installations").values({
    installation_id: githubId, tenant_id: tenantId, github_account_id: githubId,
  }).execute();
  await trx.updateTable("tenants").set({ enabled: true }).where("id", "=", tenantId).execute();
}

async function waitForLock() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await sql<{ count: string }>`select count(*)::text as count from pg_stat_activity
      where datname = current_database() and application_name = 'feature-rec-oauth-storage-selftest'
        and wait_event_type = 'Lock'`.execute(db);
    if (Number(result.rows[0]?.count) > 0) return;
    await delay(20);
  }
  assert.fail("Expected OAuth storage operation to wait for the row lock");
}

// The expiry change commits while the operation is blocked, without relying on
// wall-clock sleeps. The operation must observe expiry after it acquires the lock.
async function expireWhileBlocked<T>(id: string, operation: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  const blocker = new Client({ connectionString: testUrl });
  await blocker.connect();
  try {
    await blocker.query("begin");
    await blocker.query("select id from slack_oauth_installations where id = $1 for update", [id]);
    const result = Promise.allSettled([operation()]);
    try {
      await waitForLock();
      // Place expiry strictly AFTER the blocked worker's transaction started,
      // but before releasing its lock. A transaction-frozen now() would still
      // accept this row; clock_timestamp() must reject it. Keep microseconds in
      // PostgreSQL because JavaScript Date would round this boundary away.
      const expired = await blocker.query<{ after_transaction_start: boolean; expired: boolean }>(`
        with blocked as (
          select xact_start from pg_stat_activity
          where datname = current_database()
            and application_name = 'feature-rec-oauth-storage-selftest'
            and wait_event_type = 'Lock'
          order by xact_start limit 1
        )
        update slack_oauth_installations
        set expires_at = blocked.xact_start + interval '1 microsecond'
        from blocked where id = $1
        returning expires_at > blocked.xact_start as after_transaction_start,
          expires_at < clock_timestamp() as expired
      `, [id]);
      assert.deepEqual(expired.rows, [{ after_transaction_start: true, expired: true }]);
    } finally {
      await blocker.query("commit");
    }
    return (await result)[0];
  } finally {
    await blocker.end();
  }
}

try {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const migrated = await migrator.migrateToLatest();
  if (migrated.error) throw migrated.error;
  assert.equal(Object.keys(await migrationProvider.getMigrations()).sort().at(-1), "0009_slack_oauth_installations");
  assert.deepEqual(await inspectSlackTokenEncryption(db, null), { keyError: null, invalidWorkspaces: [], invalidPendingInstallations: [] });

  const first = await createSlackOAuthSession(db);
  const second = await createSlackOAuthSession(db);
  const beforeClaim = await raw(first.id);
  assert.notEqual(first.state, first.browserBinding);
  assert.notEqual(first.state, second.state);
  assert.match(beforeClaim.state_hash!, /^[0-9a-f]{64}$/);
  assert.match(beforeClaim.browser_binding_hash!, /^[0-9a-f]{64}$/);
  assert.equal(beforeClaim.state_hash, crypto.createHash("sha256").update(first.state).digest("hex"));
  assert.equal(beforeClaim.browser_binding_hash, crypto.createHash("sha256").update(first.browserBinding).digest("hex"));
  assert.equal(JSON.stringify(beforeClaim).includes(first.state), false);
  assert.equal(JSON.stringify(beforeClaim).includes(first.browserBinding), false);
  assert.equal(await hasSlackOAuthBrowserBinding(db, first), true);
  for (const forged of [
    { state: first.state, browserBinding: "" },
    { state: first.state, browserBinding: second.browserBinding },
    { state: second.state, browserBinding: first.browserBinding },
    { state: first.state, browserBinding: first.state },
    { state: "invalid-state", browserBinding: first.browserBinding },
  ]) {
    assert.equal(await hasSlackOAuthBrowserBinding(replica, forged), false);
    assert.equal(await claimSlackOAuthSession(replica, forged), null);
  }
  assert.deepEqual(await raw(first.id), beforeClaim);
  const claims = await Promise.all([claimSlackOAuthSession(db, first), claimSlackOAuthSession(replica, first)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claimed = claims.find((claim) => claim !== null)!;
  assert.equal(await hasSlackOAuthBrowserBinding(db, first), false);
  await replica.destroy();
  replica = connect();
  assert.equal(await claimSlackOAuthSession(replica, first), null);
  assert.equal((await getSlackOAuthInstallationStatus(replica, first.id))?.status, "exchanging");
  assert.equal(await stageSlackOAuthInstallation(replica, { ...claimed, claimId: crypto.randomUUID(), teamId: "TA", botUserId: "UTA", token: "xoxb-TA", encryptionKey: key }), false);
  assert.equal(await db.selectFrom("slack_token_encryption_key").selectAll().executeTakeFirst(), undefined);

  // Force expiry AFTER first-key insertion but BEFORE the pending write. The
  // failed stage must roll back both the verifier and this expiry change.
  const beforeStaging = await raw(first.id);
  await sql`create function expire_during_key_pin() returns trigger language plpgsql as $$
    begin
      update slack_oauth_installations set expires_at = clock_timestamp() - interval '1 microsecond'
        where status = 'exchanging';
      return new;
    end;
  $$`.execute(db);
  await sql`create trigger expire_during_key_pin before insert on slack_token_encryption_key
    for each row execute function expire_during_key_pin()`.execute(db);
  try {
    assert.equal(await stageSlackOAuthInstallation(db, {
      ...claimed, teamId: "TA", botUserId: "UTA", token: "xoxb-TA", encryptionKey: key,
    }), false);
    assert.equal(await db.selectFrom("slack_token_encryption_key").selectAll().executeTakeFirst(), undefined);
    assert.deepEqual(await raw(first.id), beforeStaging);
  } finally {
    await sql`drop trigger expire_during_key_pin on slack_token_encryption_key`.execute(db);
    await sql`drop function expire_during_key_pin()`.execute(db);
  }

  // A database write failure must propagate and undo first-key pinning too.
  await sql`create function fail_pending_write() returns trigger language plpgsql as $$
    begin
      raise exception 'Simulated pending write failure';
    end;
  $$`.execute(db);
  await sql`create trigger fail_pending_write before update on slack_oauth_installations
    for each row when (new.status = 'pending') execute function fail_pending_write()`.execute(db);
  try {
    await assert.rejects(stageSlackOAuthInstallation(db, {
      ...claimed, teamId: "TA", botUserId: "UTA", token: "xoxb-TA", encryptionKey: key,
    }), /Simulated pending write failure/);
    assert.equal(await db.selectFrom("slack_token_encryption_key").selectAll().executeTakeFirst(), undefined);
    assert.deepEqual(await raw(first.id), beforeStaging);
  } finally {
    await sql`drop trigger fail_pending_write on slack_oauth_installations`.execute(db);
    await sql`drop function fail_pending_write()`.execute(db);
  }
  const stages = await Promise.all([db, replica].map((connection) => stageSlackOAuthInstallation(connection, {
    ...claimed, teamId: "TA", botUserId: "UTA", token: "xoxb-TA", encryptionKey: key,
  })));
  assert.deepEqual(stages.sort(), [false, true]);
  assert.equal((await db.selectFrom("tenants").selectAll().execute()).length, 0);
  assert.equal((await db.selectFrom("slack_workspaces").selectAll().execute()).length, 0);
  const firstStored = await raw(first.id);
  assert.equal(firstStored.state_hash, null);
  assert.equal(firstStored.browser_binding_hash, null);
  assert.equal(firstStored.claim_id, null);
  assert.ok(firstStored.bot_token_ciphertext);
  assert.equal(JSON.stringify(firstStored).includes("xoxb-TA"), false);
  assert.equal(decryptSlackToken({ envelope: firstStored.bot_token_ciphertext, teamId: "TA", key }), "xoxb-TA");
  const verifier = await db.selectFrom("slack_token_encryption_key").selectAll().executeTakeFirstOrThrow();
  assert.ok(verifier.verifier);
  assert.match((await inspectSlackTokenEncryption(db, null)).keyError!, /required/);
  assert.match((await inspectSlackTokenEncryption(db, wrongKey)).keyError!, /does not match/);
  await replica.destroy();
  replica = connect();
  const installationA = await readPendingSlackOAuthInstallation(replica, first.id, key);
  assert.ok(installationA);
  assert.equal(installationA.token, "xoxb-TA");
  await assert.rejects(readPendingSlackOAuthInstallation(db, first.id, wrongKey), /cannot be decrypted/);

  // A pending-only database must refuse replacement keys just like active tenants.
  const retrySession = await createSlackOAuthSession(db);
  const retryClaim = await claimSlackOAuthSession(db, retrySession);
  assert.ok(retryClaim);
  const retryInput = { ...retryClaim, teamId: "TB", botUserId: "UTB", token: "xoxb-TB", encryptionKey: wrongKey };
  await assert.rejects(stageSlackOAuthInstallation(db, retryInput), /does not match/);
  assert.equal((await raw(retrySession.id)).status, "exchanging");
  await db.deleteFrom("slack_token_encryption_key").execute();
  assert.match((await inspectSlackTokenEncryption(db, key)).keyError!, /verifier is missing/);
  await assert.rejects(stageSlackOAuthInstallation(db, retryInput), /verifier is missing/);
  await assert.rejects(db.transaction().execute(async (trx) => {
    await lockTenantProvisioning(trx);
    await ensureSlackTokenKey(trx, wrongKey);
  }), /verifier is missing/);
  assert.equal(await db.selectFrom("slack_token_encryption_key").selectAll().executeTakeFirst(), undefined);
  assert.equal((await raw(first.id)).bot_token_ciphertext, firstStored.bot_token_ciphertext);
  assert.equal((await raw(retrySession.id)).status, "exchanging");
  await db.insertInto("slack_token_encryption_key").values(verifier).execute();
  assert.equal(await stageSlackOAuthInstallation(db, { ...retryInput, encryptionKey: key }), true);
  const installationB = await readPendingSlackOAuthInstallation(db, retrySession.id, key);
  assert.ok(installationB);
  const installationC = await pending("TC");
  await db.updateTable("slack_oauth_installations").set({ bot_token_ciphertext: installationA.expectedCiphertext }).where("id", "=", installationB.id).execute();
  await assert.rejects(readPendingSlackOAuthInstallation(db, installationB.id, key), /cannot be decrypted/);
  assert.deepEqual((await inspectSlackTokenEncryption(db, key)).invalidPendingInstallations, [{ id: installationB.id, teamId: "TB" }]);
  await db.updateTable("slack_oauth_installations").set({ bot_token_ciphertext: installationB.expectedCiphertext }).where("id", "=", installationB.id).execute();
  const safeStatus = await getSlackOAuthInstallationStatus(db, first.id);
  assert.equal(safeStatus?.status, "pending");
  for (const secret of [first.state, first.browserBinding, claimed.claimId, "xoxb-TA", firstStored.bot_token_ciphertext]) {
    assert.equal(JSON.stringify(safeStatus).includes(secret), false);
  }
  assert.equal(await getSlackOAuthInstallationStatus(db, "invalid"), null);
  assert.equal(await readPendingSlackOAuthInstallation(db, "invalid", key), null);

  // Every stage has an independent expiry check; maintenance is not required.
  await db.updateTable("slack_oauth_installations").set({ expires_at: sql`clock_timestamp() - interval '1 second'` }).where("id", "=", second.id).execute();
  assert.equal(await hasSlackOAuthBrowserBinding(db, second), false);
  assert.equal(await claimSlackOAuthSession(db, second), null);
  assert.equal((await getSlackOAuthInstallationStatus(db, second.id))?.status, "expired");
  const blockedClaim = await createSlackOAuthSession(db);
  assert.deepEqual(await expireWhileBlocked(blockedClaim.id, () => claimSlackOAuthSession(replica, blockedClaim)), { status: "fulfilled", value: null });
  const blockedStage = await createSlackOAuthSession(db);
  const blockedStageClaim = await claimSlackOAuthSession(db, blockedStage);
  assert.ok(blockedStageClaim);
  assert.deepEqual(await expireWhileBlocked(blockedStage.id, () => stageSlackOAuthInstallation(replica, {
    ...blockedStageClaim, teamId: "TEXPIRED", botUserId: "UEXPIRED", token: "xoxb-expired", encryptionKey: key,
  })), { status: "fulfilled", value: false });
  assert.equal((await raw(blockedStage.id)).bot_token_ciphertext, null);
  assert.equal(await readPendingSlackOAuthInstallation(db, blockedStage.id, key), null);

  const tenantA = crypto.randomUUID();
  const githubA = "9007199254740993";
  const consumeA = { id: installationA.id, expectedCiphertext: installationA.expectedCiphertext, tenantId: tenantA, githubInstallationId: githubA, encryptionKey: key };
  await assert.rejects(consumeSlackOAuthInstallation(db as Transaction<DB>, consumeA), /requires a provisioning transaction/);
  await assert.rejects(db.transaction().execute((trx) => consumeSlackOAuthInstallation(trx, consumeA)), /activated matching integrations/);
  await assert.rejects(db.transaction().execute(async (trx) => {
    await activate(trx, installationA, tenantA, githubA);
    await consumeSlackOAuthInstallation(trx, consumeA);
    throw new Error("Simulated failure after consumption");
  }), /Simulated failure/);
  assert.equal(await db.selectFrom("tenants").selectAll().where("id", "=", tenantA).executeTakeFirst(), undefined);
  assert.equal((await readPendingSlackOAuthInstallation(db, installationA.id, key))?.token, installationA.token);
  await assert.rejects(db.transaction().execute(async (trx) => {
    await activate(trx, installationA, tenantA, githubA);
    await trx.updateTable("tenants").set({ enabled: false }).where("id", "=", tenantA).execute();
    await consumeSlackOAuthInstallation(trx, consumeA);
  }), /activated matching integrations/);
  await assert.rejects(db.transaction().execute(async (trx) => {
    await activate(trx, installationA, tenantA, githubA);
    await consumeSlackOAuthInstallation(trx, { ...consumeA, githubInstallationId: "123" });
  }), /activated matching integrations/);
  await assert.rejects(db.transaction().execute(async (trx) => {
    await activate(trx, installationA, tenantA, githubA);
    await consumeSlackOAuthInstallation(trx, { ...consumeA, expectedCiphertext: installationB.expectedCiphertext });
  }), /unavailable/);
  await assert.rejects(db.transaction().execute(async (trx) => {
    await activate(trx, installationA, tenantA, githubA);
    await trx.updateTable("slack_workspaces").set({
      bot_token_ciphertext: encryptSlackToken({ token: "xoxb-older-installation", teamId: installationA.teamId, key }),
    }).where("team_id", "=", installationA.teamId).execute();
    await consumeSlackOAuthInstallation(trx, consumeA);
  }), /activated matching token/);
  // Matching plaintext with a different IV still is not the validated envelope.
  await assert.rejects(db.transaction().execute(async (trx) => {
    await activate(trx, installationA, tenantA, githubA);
    await trx.updateTable("slack_workspaces").set({
      bot_token_ciphertext: encryptSlackToken({ token: installationA.token, teamId: installationA.teamId, key }),
    }).where("team_id", "=", installationA.teamId).execute();
    await consumeSlackOAuthInstallation(trx, consumeA);
  }), /activated matching token envelope/);
  await db.transaction().execute(async (trx) => {
    await activate(trx, installationA, tenantA, githubA);
    await consumeSlackOAuthInstallation(trx, consumeA);
  });
  assert.equal(await readPendingSlackOAuthInstallation(db, installationA.id, key), null);
  assert.equal((await raw(installationA.id)).bot_token_ciphertext, null);
  const receipt = await getSlackOAuthInstallationStatus(db, installationA.id);
  assert.equal(receipt?.status, "consumed");
  assert.equal(receipt?.consumedTenantId, tenantA);
  assert.equal(receipt?.consumedGitHubInstallationId, githubA);
  assert.equal(await cancelSlackOAuthInstallation(db, installationA.id), false);
  await assert.rejects(db.transaction().execute((trx) => consumeSlackOAuthInstallation(trx, consumeA)), /unavailable/);

  const tenantB = crypto.randomUUID();
  await db.transaction().execute((trx) => activate(trx, installationB, tenantB, "202"));
  const consumeB = { id: installationB.id, expectedCiphertext: installationB.expectedCiphertext, tenantId: tenantB, githubInstallationId: "202", encryptionKey: key };
  const consumers = await Promise.allSettled([db, replica].map((connection) => connection.transaction().execute((trx) => consumeSlackOAuthInstallation(trx, consumeB))));
  assert.equal(consumers.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(String(consumers.find((result) => result.status === "rejected")?.reason), /unavailable/);

  const tenantC = crypto.randomUUID();
  const consumeC = { id: installationC.id, expectedCiphertext: installationC.expectedCiphertext, tenantId: tenantC, githubInstallationId: "303", encryptionKey: key };
  // Cancellation while consumption waits must still reject activation atomically.
  const cancellationBlocker = new Client({ connectionString: testUrl });
  await cancellationBlocker.connect();
  let cancelledConsumption: PromiseSettledResult<void>;
  try {
    await cancellationBlocker.query("begin");
    await cancellationBlocker.query("select id from slack_oauth_installations where id = $1 for update", [installationC.id]);
    const result = Promise.allSettled([replica.transaction().execute(async (trx) => {
      await activate(trx, installationC, tenantC, "303");
      await consumeSlackOAuthInstallation(trx, consumeC);
    })]);
    try {
      await waitForLock();
      await cancellationBlocker.query(`update slack_oauth_installations
        set status = 'cancelled', bot_token_ciphertext = null, expires_at = clock_timestamp()
        where id = $1`, [installationC.id]);
    } finally {
      await cancellationBlocker.query("commit");
    }
    cancelledConsumption = (await result)[0];
  } finally {
    await cancellationBlocker.end();
  }
  assert.equal(cancelledConsumption.status, "rejected");
  if (cancelledConsumption.status === "rejected") assert.match(String(cancelledConsumption.reason), /unavailable/);
  assert.equal(await db.selectFrom("tenants").selectAll().where("id", "=", tenantC).executeTakeFirst(), undefined);
  assert.equal(await readPendingSlackOAuthInstallation(db, installationC.id, key), null);
  assert.equal((await getSlackOAuthInstallationStatus(db, installationC.id))?.status, "cancelled");

  // Starting/restarting installs changes no runtime tenant credentials or routes.
  const activeBefore = await db.selectFrom("slack_workspaces").selectAll().orderBy("team_id").execute();
  const reinstallA = await pending("TA", "xoxb-TA-reinstall");
  const reinstallB = await pending("TB", "xoxb-TB-reinstall");
  const liveC = await pending("TC", "xoxb-TC-retry");
  assert.deepEqual(await db.selectFrom("slack_workspaces").selectAll().orderBy("team_id").execute(), activeBefore);
  assert.equal((await readPendingSlackOAuthInstallation(db, reinstallA.id, key))?.token, "xoxb-TA-reinstall");
  assert.equal((await readPendingSlackOAuthInstallation(db, reinstallB.id, key))?.token, "xoxb-TB-reinstall");
  assert.equal((await readPendingSlackOAuthInstallation(db, liveC.id, key))?.token, "xoxb-TC-retry");

  // Old pending installations have no deadline and survive cleanup.
  const longPending = await pending("TLONG");
  assert.equal((await raw(longPending.id)).expires_at, null);
  await db.updateTable("slack_oauth_installations").set({
    created_at: sql`clock_timestamp() - interval '1 year'`,
    claimed_at: sql`clock_timestamp() - interval '1 year'`,
  }).where("id", "=", longPending.id).execute();
  await cleanupSlackOAuthInstallations(db);
  assert.equal((await readPendingSlackOAuthInstallation(db, longPending.id, key))?.token, longPending.token);
  assert.equal((await getSlackOAuthInstallationStatus(db, longPending.id))?.status, "pending");
  assert.equal((await getSlackOAuthInstallationStatus(db, longPending.id))?.expiresAt, null);
  const longTenant = crypto.randomUUID();
  await db.transaction().execute(async (trx) => {
    await activate(trx, longPending, longTenant, "404");
    await consumeSlackOAuthInstallation(trx, { id: longPending.id,
      expectedCiphertext: longPending.expectedCiphertext, tenantId: longTenant,
      githubInstallationId: "404", encryptionKey: key });
  });
  assert.equal((await getSlackOAuthInstallationStatus(db, longPending.id))?.status, "consumed");
  // Include this successful activation in subsequent preservation assertions.
  activeBefore.push((await db.selectFrom("slack_workspaces").selectAll().where("team_id", "=", "TLONG").executeTakeFirstOrThrow()));
  activeBefore.sort((a, b) => a.team_id.localeCompare(b.team_id));

  // Sweep prior expired cases before controlling the bounded-cleanup fixture.
  await cleanupSlackOAuthInstallations(db);
  assert.equal((await raw(installationC.id)).bot_token_ciphertext, null);
  for (const id of [second.id, blockedClaim.id, blockedStage.id]) {
    const expired = await raw(id);
    assert.equal(expired.status, "expired");
    assert.equal(expired.state_hash, null);
    assert.equal(expired.browser_binding_hash, null);
    assert.equal(expired.claim_id, null);
  }
  const cleanupSession = await createSlackOAuthSession(db);
  const cleanupToken = await createSlackOAuthSession(db);
  await db.updateTable("slack_oauth_installations").set({ expires_at: sql`clock_timestamp() - interval '1 hour'` }).where("id", "in", [cleanupSession.id, cleanupToken.id]).execute();
  const cleanupBlocker = new Client({ connectionString: testUrl });
  await cleanupBlocker.connect();
  try {
    await cleanupBlocker.query("begin");
    await cleanupBlocker.query("select id from slack_oauth_installations where id = $1 for update", [cleanupToken.id]);
    assert.deepEqual(await cleanupSlackOAuthInstallations(replica, 1), { expired: 1, deleted: 0 });
    assert.equal((await raw(cleanupSession.id)).state_hash, null);
    assert.ok((await raw(cleanupToken.id)).state_hash);
  } finally {
    await cleanupBlocker.query("rollback");
    await cleanupBlocker.end();
  }
  assert.deepEqual(await cleanupSlackOAuthInstallations(db, 1), { expired: 1, deleted: 0 });
  assert.equal((await raw(cleanupToken.id)).bot_token_ciphertext, null);
  for (const limit of [0, 1001, 1.5]) await assert.rejects(cleanupSlackOAuthInstallations(db, limit), /batch size/);
  await db.updateTable("slack_oauth_installations").set({ consumed_at: sql`clock_timestamp() - interval '25 hours'` }).where("id", "=", installationA.id).execute();
  await db.updateTable("slack_oauth_installations").set({ expires_at: sql`clock_timestamp() - interval '25 hours'` }).where("id", "=", cleanupToken.id).execute();
  assert.equal((await cleanupSlackOAuthInstallations(db, 1)).deleted, 1);
  assert.equal((await cleanupSlackOAuthInstallations(db, 1)).deleted, 1);
  assert.equal(await getSlackOAuthInstallationStatus(db, installationA.id), null);
  assert.equal(await getSlackOAuthInstallationStatus(db, cleanupToken.id), null);
  assert.equal((await getSlackOAuthInstallationStatus(db, installationB.id))?.status, "consumed");
  assert.equal((await getSlackOAuthInstallationStatus(db, liveC.id))?.status, "pending");
  assert.deepEqual(await db.selectFrom("slack_workspaces").selectAll().orderBy("team_id").execute(), activeBefore);

  const activeSnapshot = {
    tenants: await db.selectFrom("tenants").selectAll().orderBy("id").execute(),
    slack: await db.selectFrom("slack_workspaces").selectAll().orderBy("team_id").execute(),
    github: await db.selectFrom("github_installations").selectAll().orderBy("installation_id").execute(),
    key: await db.selectFrom("slack_token_encryption_key").selectAll().execute(),
  };
  const allMigrations = await migrationProvider.getMigrations();
  const older = new Migrator({ db, provider: { getMigrations: async () => Object.fromEntries(
    Object.entries(allMigrations).filter(([name]) => name <= "0008_multitenant_expand"),
  ) } });
  assert.match(String((await older.migrateToLatest()).error), /previously executed migration 0009_slack_oauth_installations is missing/i);
  assert.match(String((await migrator.migrateTo("0008_multitenant_expand")).error), /Cancel pending Slack OAuth installations/);
  for (const id of [reinstallA.id, reinstallB.id, liveC.id]) {
    assert.equal(await cancelSlackOAuthInstallation(db, id), true);
    assert.equal((await raw(id)).bot_token_ciphertext, null);
  }
  const expiredUncancelled = await createSlackOAuthSession(db);
  await db.updateTable("slack_oauth_installations").set({ expires_at: sql`clock_timestamp() - interval '1 second'` }).where("id", "=", expiredUncancelled.id).execute();
  assert.match(String((await migrator.migrateTo("0008_multitenant_expand")).error), /Cancel pending Slack OAuth installations/);
  assert.equal(await cancelSlackOAuthInstallation(db, expiredUncancelled.id), true);
  const down = await migrator.migrateTo("0008_multitenant_expand");
  if (down.error) throw down.error;
  assert.equal((await sql<{ name: string | null }>`select to_regclass('public.slack_oauth_installations')::text as name`.execute(db)).rows[0].name, null);
  assert.equal((await older.migrateToLatest()).error, undefined);
  const forward = await migrator.migrateToLatest();
  if (forward.error) throw forward.error;
  assert.deepEqual(await db.selectFrom("slack_oauth_installations").selectAll().execute(), []);
  assert.deepEqual({
    tenants: await db.selectFrom("tenants").selectAll().orderBy("id").execute(),
    slack: await db.selectFrom("slack_workspaces").selectAll().orderBy("team_id").execute(),
    github: await db.selectFrom("github_installations").selectAll().orderBy("installation_id").execute(),
    key: await db.selectFrom("slack_token_encryption_key").selectAll().execute(),
  }, activeSnapshot);
  assert.deepEqual(await inspectSlackTokenEncryption(db, key), { keyError: null, invalidWorkspaces: [], invalidPendingInstallations: [] });
  console.log("service Slack OAuth storage selftest passed");
} finally {
  await replica.destroy().catch(() => {});
  await db.destroy().catch(() => {});
  const dropper = new Client({ connectionString: adminUrl });
  await dropper.connect();
  await dropper.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await dropper.end();
}
