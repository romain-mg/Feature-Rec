import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "tsup";
import { promisify } from "node:util";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { Client, Pool } from "pg";
import {
  backfillMultitenancy,
  prepareRollbackToA,
  provisionTenant,
  validateMultitenancy,
  type AdminProviders,
} from "../src/admin-operations";
import { decryptSlackToken, encryptSlackToken } from "../src/slack-token-crypto";
import { migrationProvider } from "../src/storage/migrations";
import type { DB } from "../src/storage/schema";
import { inspectSlackTokenEncryption } from "../src/storage/slack-token-check";
import {
  cancelSlackOAuthInstallation, claimSlackOAuthSession, createSlackOAuthSession, stageSlackOAuthInstallation,
  getSlackOAuthInstallationStatus, readPendingSlackOAuthInstallation,
} from "../src/storage/slack-oauth";
import { GitHubRequestError } from "../src/github";

const adminUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const dbName = `feature_rec_admin_test_${crypto.randomBytes(8).toString("hex")}`;
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();

const testUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
})();
const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: testUrl, application_name: "feature-rec-admin-selftest" }),
  }),
});
const key = Buffer.alloc(32, 9);
const tenantId = "e3f88c55-c8ca-410d-b2aa-a2636086bcd9";

const providers: AdminProviders = {
  inspectSlackToken: async (token) =>
    token === "xoxb-new"
      ? { teamId: "TNEW", botUserId: "UNEWBOT", channelIds: ["CNEW"] }
      : { teamId: "TADMIN", botUserId: "UADMINBOT", channelIds: ["CADMIN"] },
  resolveRepository: async (owner, repo) => ({
    installationId: "501",
    githubAccountId: "601",
    repositoryId: repo === "One" ? "101" : "102",
    repositoryOwnerId: "601",
    owner,
    repo,
    fullName: `${owner}/${repo}`,
  }),
  inspectInstallationRepository: async (installationId, owner, repo) => ({
    installationId,
    githubAccountId: "602",
    repositoryId: "103",
    repositoryOwnerId: "602",
    owner,
    repo,
    fullName: `${owner}/${repo}`,
  }),
};

async function waitForBlockedQueries(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await sql<{ count: string }>`
      select count(*)::text as count from pg_stat_activity
      where datname = current_database()
        and application_name = 'feature-rec-admin-selftest'
        and wait_event_type = 'Lock'
    `.execute(db);
    if (Number(result.rows[0]?.count) >= count) return;
    await delay(20);
  }
  assert.fail(`Expected ${count} blocked admin queries`);
}

try {
  const migrated = await new Migrator({ db, provider: migrationProvider }).migrateToLatest();
  if (migrated.error) throw migrated.error;

  // Database-only commands must remain usable with broken integration config.
  const runAdmin = (args: string[]) => promisify(execFile)(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("../src/admin.ts", import.meta.url)),
    ...args, "--environment", "selftest",
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: testUrl,
      RAILWAY_ENVIRONMENT_NAME: "selftest",
      PGAPPNAME: "feature-rec-admin-selftest",
      FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY: "invalid-key",
      GITHUB_OIDC_ISSUER: "invalid-issuer",
    },
    timeout: 10_000,
  });
  const status = JSON.parse((await runAdmin(["migration-status"])).stdout);
  assert.equal(status.migrations.at(-1).name, "0009_slack_oauth_installations");
  assert.equal(status.migrations.at(-1).status, "executed");
  for (const missing of ["--expect-current", "--service-stopped", "--traffic-paused"]) {
    const flags = ["--confirm", "--service-stopped", "--traffic-paused"];
    if (missing !== "--expect-current") flags.push("--expect-current", "0009_slack_oauth_installations");
    await assert.rejects(runAdmin(["migrate-to", "0007_mention_modes", ...flags.filter((flag) => flag !== missing)]), /Schema downgrade requires/);
    assert.equal(JSON.parse((await runAdmin(["migration-status"])).stdout).migrations.at(-1).status, "executed");
  }
  await assert.rejects(runAdmin(["migrate-to", "0007_mention_modes", "--confirm", "--expect-current"]), /argument missing|requires a value|argument is ambiguous/);
  await assert.rejects(runAdmin(["migrate-to", "0007_mention_modes", "--confirm", "--expect-current=", "--service-stopped", "--traffic-paused"]), /non-empty value/);
  const migrationBlocker = new Client({ connectionString: testUrl });
  await migrationBlocker.connect();
  try {
    await migrationBlocker.query("select pg_advisory_lock(hashtextextended('feature-rec-migrations', 0))");
    const competing = Promise.allSettled([0, 1].map(() => runAdmin(["migrate-to", "0007_mention_modes", "--confirm", "--expect-current", "0009_slack_oauth_installations", "--service-stopped", "--traffic-paused"])));
    try {
      await waitForBlockedQueries(2);
    } finally {
      await migrationBlocker.query("select pg_advisory_unlock(hashtextextended('feature-rec-migrations', 0))");
    }
    const results = await competing;
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.match(String(results.find((result) => result.status === "rejected")?.reason), /Expected current migration/);
  } finally {
    await migrationBlocker.end();
  }
  await runAdmin(["migrate-to", "0009_slack_oauth_installations", "--confirm", "--expect-current", "0007_mention_modes"]);
  assert.equal(JSON.parse((await runAdmin(["prepare-rollback-to-a", "--dry-run"])).stdout).ok, true);
  await assert.rejects(runAdmin(["validate-contract-readiness"]), /canonical base64/);

  assert.deepEqual(await inspectSlackTokenEncryption(db, null), { keyError: null, invalidPendingInstallations: [], invalidWorkspaces: [] });
  const emptyBackfill = { db, providers, slackBotToken: "xoxb-admin", encryptionKey: key, tenantId };
  const emptyDryRun = await backfillMultitenancy({ ...emptyBackfill, apply: false });
  assert.deepEqual((await backfillMultitenancy({ ...emptyBackfill, apply: true })).issues, emptyDryRun.issues);
  assert.ok(emptyDryRun.issues.some((issue) => issue.includes("at least one GitHub repository")));
  assert.equal(await db.selectFrom("slack_token_encryption_key").selectAll().executeTakeFirst(), undefined);
  for (const selectedChannelId of ["", " ", "CUNKNOWN"]) {
    await assert.rejects(provisionTenant({ db, providers, slackBotToken: "xoxb-new", encryptionKey: key, installationId: "502", repository: { owner: "Beta", repo: "Three" }, selectedChannelId }), /channel ID must not be empty|not a member/);
  }

  await sql`
    insert into team_channel_routes (team_id, selected_channel_id)
    values ('TADMIN', 'CADMIN');
    insert into channel_settings
      (team_id, channel_id, mention_mode, mention_audience, approvers, updated_by, updated_at)
    values ('TADMIN', 'CADMIN', 'approvers', null, null, 'UADMIN', now());
    insert into review_cycles
      (id, cycle_key, owner, repo, pr_number, pr_author, pr_title, head_sha,
       status, attempt_id, created_at, updated_at)
    values
      ('cycle-one', 'Acme/One#1:abcdefg', 'Acme', 'One', 1, 'a', 'one',
       'abcdefg', 'failed', 'attempt-one', '2026-01-01', '2026-01-01'),
      ('cycle-two', 'Acme/Two#2:hijklmn', 'Acme', 'Two', 2, 'b', 'two',
       'hijklmn', 'accepted', 'attempt-two', '2026-01-01', '2026-01-01')
  `.execute(db);

  await sql`
    insert into review_cycles
      (id, cycle_key, owner, repo, pr_number, pr_author, pr_title, head_sha,
       status, attempt_id, created_at, updated_at)
    values
      ('cycle-collision', 'legacy-collision#1:abcdefg', 'Acme', 'One', 1, 'c',
       'collision', 'abcdefg', 'failed', 'attempt-collision', '2026-01-01', '2026-01-01')
  `.execute(db);
  const collision = await backfillMultitenancy({
    db,
    providers,
    slackBotToken: "xoxb-admin",
    encryptionKey: key,
    tenantId,
    apply: false,
  });
  assert.ok(collision.issues.some((issue) => issue.includes("future cycle key collision")));
  assert.equal(collision.applied, false);
  await db.deleteFrom("review_cycles").where("id", "=", "cycle-collision").execute();

  const splitInstallationProviders: AdminProviders = {
    ...providers,
    resolveRepository: async (owner, repo) => ({
      ...(await providers.resolveRepository(owner, repo)),
      installationId: repo === "Two" ? "999" : "501",
      githubAccountId: repo === "Two" ? "888" : "601",
    }),
  };
  const mappingConflict = await backfillMultitenancy({
    db,
    providers: splitInstallationProviders,
    slackBotToken: "xoxb-admin",
    encryptionKey: key,
    tenantId,
    apply: false,
  });
  assert.ok(
    mappingConflict.issues.some((issue) => issue.includes("more than one GitHub installation/account")),
  );
  assert.equal(mappingConflict.repositoryMappings.length, 2);

  const unresolvedProviders: AdminProviders = {
    ...providers,
    resolveRepository: async (owner, repo) => {
      if (repo === "Two") throw new Error("not found");
      return providers.resolveRepository(owner, repo);
    },
  };
  const unresolved = await backfillMultitenancy({
    db,
    providers: unresolvedProviders,
    slackBotToken: "xoxb-admin",
    encryptionKey: key,
    tenantId,
    apply: false,
  });
  assert.deepEqual(unresolved.unresolvedRepositories, ["Acme/Two"]);
  for (const failure of [new GitHubRequestError(503), new GitHubRequestError(404), new GitHubRequestError(null), new Error("secret-do-not-log")]) {
    const report = await backfillMultitenancy({ db, providers: { ...providers, resolveRepository: async () => { throw failure; } }, slackBotToken: "xoxb-admin", encryptionKey: key, tenantId, apply: false });
    assert.ok(report.issues.some((issue) => issue.includes(failure instanceof GitHubRequestError ? failure.message : "unexpected discovery failure")));
    assert.ok(!JSON.stringify(report).includes("secret-do-not-log"));
  }

  const dryRun = await backfillMultitenancy({
    db,
    providers,
    slackBotToken: "xoxb-admin",
    encryptionKey: key,
    tenantId,
    apply: false,
  });
  assert.equal(dryRun.applied, false);
  assert.deepEqual(dryRun.issues, []);
  assert.equal(
    await sql<{ count: string }>`select count(*)::text as count from tenants`
      .execute(db)
      .then((result) => result.rows[0]?.count),
    "0",
  );

  const applied = await backfillMultitenancy({
    db,
    providers,
    slackBotToken: "xoxb-admin",
    encryptionKey: key,
    tenantId,
    apply: true,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.validation?.ok, true);
  assert.deepEqual(await inspectSlackTokenEncryption(db, key), { keyError: null, invalidPendingInstallations: [], invalidWorkspaces: [] });
  assert.match((await inspectSlackTokenEncryption(db, Buffer.alloc(32, 10))).keyError!, /does not match/);
  assert.match((await inspectSlackTokenEncryption(db, null)).keyError!, /ENCRYPTION_KEY is required/);
  const wrongKeyDryRun = await backfillMultitenancy({ ...emptyBackfill, encryptionKey: Buffer.alloc(32, 10), apply: false });
  assert.ok(wrongKeyDryRun.issues.some((issue) => issue.includes("does not match")));
  assert.deepEqual((await backfillMultitenancy({ ...emptyBackfill, encryptionKey: Buffer.alloc(32, 10), apply: true })).issues, wrongKeyDryRun.issues);
  const savedVerifier = await db.selectFrom("slack_token_encryption_key").selectAll().executeTakeFirstOrThrow();
  await db.deleteFrom("slack_token_encryption_key").execute();
  assert.match((await inspectSlackTokenEncryption(db, key)).keyError!, /verifier is missing/);
  await assert.rejects(provisionTenant({ db, providers, slackBotToken: "xoxb-new", encryptionKey: key, installationId: "502", repository: { owner: "Beta", repo: "Three" } }), /verifier is missing/);
  await db.insertInto("slack_token_encryption_key").values(savedVerifier).execute();
  await assert.rejects(provisionTenant({ db, providers, slackBotToken: "xoxb-new", encryptionKey: Buffer.alloc(32, 10), installationId: "502", repository: { owner: "Beta", repo: "Three" } }), /does not match/);
  assert.equal(await db.selectFrom("slack_workspaces").selectAll().where("team_id", "=", "TNEW").executeTakeFirst(), undefined);
  const workspace = await db
    .selectFrom("slack_workspaces")
    .selectAll()
    .where("team_id", "=", "TADMIN")
    .executeTakeFirstOrThrow();
  assert.equal(workspace.bot_user_id, "UADMINBOT");
  assert.equal(workspace.selected_channel_id, "CADMIN");
  assert.equal(
    decryptSlackToken({ envelope: workspace.bot_token_ciphertext, teamId: "TADMIN", key }),
    "xoxb-admin",
  );
  assert.equal(
    await db.selectFrom("tenants").select("enabled").where("id", "=", tenantId).executeTakeFirstOrThrow().then((row) => row.enabled),
    true,
  );
  assert.deepEqual(
    await db.selectFrom("review_cycles").select(["id", "tenant_id", "repository_id", "cycle_key"]).orderBy("id").execute(),
    [
      { id: "cycle-one", tenant_id: tenantId, repository_id: "101", cycle_key: "Acme/One#1:abcdefg" },
      { id: "cycle-two", tenant_id: tenantId, repository_id: "102", cycle_key: "Acme/Two#2:hijklmn" },
    ],
  );

  // Repeated apply is idempotent and the no-writer cutover mode switches all
  // keys with the same canonical core builder used by the multitenant runtime.
  assert.equal(
    (
      await backfillMultitenancy({
        db,
        providers,
        slackBotToken: "xoxb-admin",
        encryptionKey: key,
        tenantId,
        apply: true,
        rebuildCycleKeys: true,
        trafficPaused: true,
      })
    ).validation?.ok,
    true,
  );
  assert.deepEqual(
    await db.selectFrom("review_cycles").select(["id", "cycle_key"]).orderBy("id").execute(),
    [
      { id: "cycle-one", cycle_key: `${tenantId}/101#1:abcdefg` },
      { id: "cycle-two", cycle_key: `${tenantId}/102#2:hijklmn` },
    ],
  );
  assert.equal(
    (await validateMultitenancy({ db, encryptionKey: key, requireFutureCycleKeys: true })).ok,
    true,
  );

  await assert.rejects(
    prepareRollbackToA({ db, apply: true }),
    /traffic-paused acknowledgement/,
  );
  const rollback = await prepareRollbackToA({ db, apply: true, trafficPaused: true });
  assert.equal(rollback.ok, true);
  assert.deepEqual(
    await db.selectFrom("review_cycles").select(["id", "cycle_key"]).orderBy("id").execute(),
    [
      { id: "cycle-one", cycle_key: "Acme/One#1:abcdefg" },
      { id: "cycle-two", cycle_key: "Acme/Two#2:hijklmn" },
    ],
  );

  // No selected channel needs no legacy route; missing selected routes and
  // orphaned or mismatched legacy routes must still prevent rollback.
  await db.deleteFrom("team_channel_routes").where("team_id", "=", "TADMIN").execute();
  await db.updateTable("slack_workspaces").set({ selected_channel_id: null }).where("team_id", "=", "TADMIN").execute();
  assert.equal((await prepareRollbackToA({ db, apply: false })).ok, true);
  assert.equal((await prepareRollbackToA({ db, apply: true, trafficPaused: true })).applied, true);
  assert.equal(await db.selectFrom("team_channel_routes").selectAll().executeTakeFirst(), undefined);
  await db.updateTable("slack_workspaces").set({ selected_channel_id: "CADMIN" }).where("team_id", "=", "TADMIN").execute();
  assert.equal((await prepareRollbackToA({ db, apply: false })).ok, false);
  await db.insertInto("team_channel_routes").values({ team_id: "TADMIN", selected_channel_id: "CWRONG" }).execute();
  assert.equal((await prepareRollbackToA({ db, apply: false })).ok, false);
  await db.updateTable("team_channel_routes").set({ team_id: "TORPHAN", selected_channel_id: "CADMIN" }).where("team_id", "=", "TADMIN").execute();
  assert.equal((await prepareRollbackToA({ db, apply: false })).ok, false);
  await db.updateTable("team_channel_routes").set({ team_id: "TADMIN" }).where("team_id", "=", "TORPHAN").execute();
  assert.equal((await prepareRollbackToA({ db, apply: false })).ok, true);

  const wrongAad = encryptSlackToken({ token: "xoxb-admin", teamId: "TOTHER", key });
  await db
    .updateTable("slack_workspaces")
    .set({ bot_token_ciphertext: wrongAad })
    .where("team_id", "=", "TADMIN")
    .execute();
  const invalidCiphertext = await validateMultitenancy({ db, encryptionKey: key });
  assert.equal(invalidCiphertext.ok, false);
  assert.ok(invalidCiphertext.issues.some((issue) => issue.includes("team-bound AAD")));
  // An independently verified key lets even the sole corrupted token remain tenant-local.
  assert.deepEqual(await inspectSlackTokenEncryption(db, key), { keyError: null, invalidPendingInstallations: [], invalidWorkspaces: [{ tenantId, teamId: "TADMIN" }] });
  const pendingSession = await createSlackOAuthSession(db);
  const pendingClaim = await claimSlackOAuthSession(db, pendingSession);
  assert.ok(pendingClaim);
  assert.equal(await stageSlackOAuthInstallation(db, {
    ...pendingClaim, teamId: "TPENDING", botUserId: "UPENDING", token: "xoxb-pending", encryptionKey: key,
  }), true);
  const pendingWrongAad = encryptSlackToken({ token: "xoxb-pending", teamId: "TOTHER", key });
  await db.updateTable("slack_oauth_installations").set({ bot_token_ciphertext: pendingWrongAad })
    .where("id", "=", pendingSession.id).execute();
  const pendingValidation = await validateMultitenancy({ db, encryptionKey: key });
  assert.ok(pendingValidation.issues.some((issue) => issue.includes(pendingSession.id) && issue.includes("team-bound AAD")));
  assert.ok(!JSON.stringify(pendingValidation).includes(pendingWrongAad));
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
  const startService = (encryptionKey: Buffer) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, DATABASE_URL: testUrl, PORT: String(port), FEATURE_REC_BASE_URL: "https://service-selftest.invalid", FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY: encryptionKey.toString("base64"), GITHUB_OIDC_ISSUER: "https://token.actions.githubusercontent.com" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => { logs += String(data); });
    child.stderr.on("data", (data) => { logs += String(data); });
    return { child, logs: () => logs };
  };
  const healthy = startService(key);
  const healthyExit = once(healthy.child, "exit");
  try {
    const deadline = Date.now() + 10_000;
    while (!healthy.logs().includes("Server listening at") && healthy.child.exitCode === null && Date.now() < deadline) await delay(20);
    assert.match(healthy.logs(), /Server listening at/);
    assert.match(healthy.logs(), /SLACK_TOKEN_DECRYPTION_FAILED/);
    assert.match(healthy.logs(), /TADMIN/);
    assert.match(healthy.logs(), /SLACK_PENDING_TOKEN_DECRYPTION_FAILED/);
    assert.ok(healthy.logs().includes(pendingSession.id));
    for (const secret of ["xoxb-pending", pendingWrongAad, pendingSession.state, pendingSession.browserBinding]) {
      assert.ok(!healthy.logs().includes(secret));
    }
    assert.ok(!healthy.logs().includes(wrongAad) && !healthy.logs().includes("xoxb-admin"));
    const address = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(healthy.logs())?.[1];
    assert.ok(address);
    assert.equal((await fetch(`${address}/health`)).status, 200);
  } finally {
    healthy.child.kill("SIGTERM");
    await healthyExit;
  }
  const wrongKeyStartup = startService(Buffer.alloc(32, 10));
  const wrongExit = once(wrongKeyStartup.child, "exit");
  const timeout = setTimeout(() => wrongKeyStartup.child.kill("SIGKILL"), 10_000);
  try {
    assert.equal((await wrongExit)[0], 1);
    assert.match(wrongKeyStartup.logs(), /does not match the database verifier/);
    assert.ok(!wrongKeyStartup.logs().includes("Server listening at"));
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(await cancelSlackOAuthInstallation(db, pendingSession.id), true);
  await backfillMultitenancy({
    db,
    providers,
    slackBotToken: "xoxb-admin",
    encryptionKey: key,
    tenantId,
    apply: true,
  });

  const channelWriter = new Client({ connectionString: testUrl });
  await channelWriter.connect();
  try {
    for (const operation of ["provision", "backfill"] as const) {
      await channelWriter.query("BEGIN");
      await channelWriter.query("select pg_advisory_xact_lock(hashtextextended('team-route:TADMIN', 0))");
      await channelWriter.query("select team_id from slack_workspaces where team_id = 'TADMIN' for update");
      const pending = Promise.allSettled([
        operation === "provision"
          ? provisionTenant({
              db,
              providers: { ...providers, inspectInstallationRepository: async (_id, owner, repo) => providers.resolveRepository(owner, repo) },
              slackBotToken: "xoxb-admin",
              encryptionKey: key,
              installationId: "501",
              repository: { owner: "Acme", repo: "One" },
              tenantId,
            })
          : backfillMultitenancy({ db, providers, slackBotToken: "xoxb-admin", encryptionKey: key, tenantId, apply: true }),
      ]);
      const selectedChannelId = `C-${operation}`;
      try {
        // The operator is now blocked behind an in-flight channel selection.
        // Without the channel lock it would already have read the old value.
        await waitForBlockedQueries(1);
        await channelWriter.query("update team_channel_routes set selected_channel_id = $1 where team_id = 'TADMIN'", [selectedChannelId]);
        await channelWriter.query("update slack_workspaces set selected_channel_id = $1 where team_id = 'TADMIN'", [selectedChannelId]);
        await channelWriter.query("COMMIT");
      } finally {
        await channelWriter.query("ROLLBACK");
      }
      const [outcome] = await pending;
      if (outcome.status === "rejected") throw outcome.reason;
      assert.equal((await db.selectFrom("slack_workspaces").select("selected_channel_id").where("team_id", "=", "TADMIN").executeTakeFirstOrThrow()).selected_channel_id, selectedChannelId);
      assert.equal((await db.selectFrom("team_channel_routes").select("selected_channel_id").where("team_id", "=", "TADMIN").executeTakeFirstOrThrow()).selected_channel_id, selectedChannelId);
    }
  } finally {
    await channelWriter.end();
  }

  const secondTenantId = "32a133f8-37ec-47b3-ae74-bd82095d7a13";
  const provisioned = await provisionTenant({
    db,
    providers,
    slackBotToken: "xoxb-new",
    encryptionKey: key,
    installationId: "502",
    repository: { owner: "Other", repo: "Repo" },
    tenantId: secondTenantId,
    selectedChannelId: "CNEW",
  });
  assert.equal(provisioned.tenantId, secondTenantId);
  assert.equal(provisioned.selectedChannelId, "CNEW");
  await db.updateTable("slack_workspaces").set({ bot_token_ciphertext: "corrupt" }).where("team_id", "=", "TADMIN").execute();
  assert.deepEqual(await inspectSlackTokenEncryption(db, key), { keyError: null, invalidPendingInstallations: [], invalidWorkspaces: [{ tenantId, teamId: "TADMIN" }] });
  await db.updateTable("slack_workspaces").set({ bot_token_ciphertext: workspace.bot_token_ciphertext }).where("team_id", "=", "TADMIN").execute();
  assert.equal(
    await db.selectFrom("team_channel_routes").select("selected_channel_id").where("team_id", "=", "TNEW").executeTakeFirstOrThrow().then((row) => row.selected_channel_id),
    "CNEW",
  );

  // Same tenant/account with a new installation ID is an allowed reinstall.
  const reinstalled = await provisionTenant({
    db,
    providers,
    slackBotToken: "xoxb-new",
    encryptionKey: key,
    installationId: "503",
    repository: { owner: "Other", repo: "Repo" },
    tenantId: secondTenantId,
    selectedChannelId: "CNEW",
  });
  assert.equal(reinstalled.githubInstallationId, "503");
  assert.equal(
    await db.selectFrom("github_installations").select("installation_id").where("tenant_id", "=", secondTenantId).executeTakeFirstOrThrow().then((row) => row.installation_id),
    "503",
  );
  assert.equal(
    (
      await provisionTenant({
        db,
        providers,
        slackBotToken: "xoxb-new",
        encryptionKey: key,
        installationId: "503",
        repository: { owner: "Other", repo: "Repo" },
      })
    ).tenantId,
    secondTenantId,
  );
  await assert.rejects(
    provisionTenant({
      db,
      providers,
      slackBotToken: "xoxb-new",
      encryptionKey: key,
      installationId: "503",
      repository: { owner: "Other", repo: "Repo" },
      tenantId: "f4a35af1-843d-4276-af6e-25f3929f16b3",
    }),
    /re-pair existing integrations|different tenants/,
  );

  const provisioningBlocker = new Client({ connectionString: testUrl });
  await provisioningBlocker.connect();
  try {
    for (const [index, shared] of ["slack", "installation", "account", "implicit-tenant"].entries()) {
      const concurrentProviders: AdminProviders = {
        ...providers,
        inspectSlackToken: async (token) => ({ teamId: token, botUserId: "UBOT", channelIds: [] }),
        inspectInstallationRepository: async (installationId, owner, repo) => ({
          installationId,
          githubAccountId: shared === "slack" ? installationId : `${9000 + index}`,
          repositoryId: "999",
          repositoryOwnerId: shared === "slack" ? installationId : `${9000 + index}`,
          owner, repo, fullName: `${owner}/${repo}`,
        }),
      };
      await provisioningBlocker.query("BEGIN");
      // Hold both requests before they can write tenants. Ownership checks for
      // absent rows race without serialization, even with unique constraints.
      await provisioningBlocker.query("lock table tenants in share mode");
      const pending = Promise.allSettled([0, 1].map((offset) => provisionTenant({
        db,
        providers: concurrentProviders,
        slackBotToken: `T-${shared}-${shared === "slack" || shared === "implicit-tenant" ? 0 : offset}`,
        encryptionKey: key,
        installationId: `${8000 + index * 10 + (shared === "installation" || shared === "implicit-tenant" ? 0 : offset)}`,
        repository: { owner: "Race", repo: "Repo" },
        tenantId: shared === "implicit-tenant" ? undefined : crypto.randomUUID(),
      })));
      try {
        await waitForBlockedQueries(2);
      } finally {
        await provisioningBlocker.query("ROLLBACK");
      }
      const outcomes = await pending;
      const succeeded = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      if (shared === "implicit-tenant") {
        assert.equal(succeeded.length, 2);
        assert.equal(succeeded[0].value.tenantId, succeeded[1].value.tenantId);
      } else {
        assert.equal(succeeded.length, 1, `${shared}: only one pairing should succeed`);
        assert.equal(rejected.length, 1);
        assert.match(String(rejected[0].reason), /re-pair existing integrations|different tenants/);
      }
      const validation = await validateMultitenancy({ db, encryptionKey: key });
      assert.equal(validation.ok, true, validation.issues.join("; "));
    }
  } finally {
    await provisioningBlocker.end();
  }


  // Pending OAuth provisioning reuses the normal provider checks and pairing
  // guards, but the exact validated encrypted envelope crosses into active storage.
  const oauthProviders: AdminProviders = {
    ...providers,
    inspectSlackToken: async (token) => {
      const number = /^xoxb-oauth-(\d+)(?:-reinstall)?$/.exec(token)?.[1];
      assert.ok(number);
      return { teamId: `TOAUTH${number}`, botUserId: `UOAUTH${number}`, channelIds: [`COAUTH${number}`] };
    },
    inspectInstallationRepository: async (installationId, owner, repo) => ({
      installationId, githubAccountId: installationId, repositoryId: installationId,
      repositoryOwnerId: installationId, owner, repo, fullName: `${owner}/${repo}`,
    }),
  };
  const stage = async (number: number, suffix = "") => {
    const session = await createSlackOAuthSession(db);
    const claim = await claimSlackOAuthSession(db, session);
    assert.ok(claim);
    assert.equal(await stageSlackOAuthInstallation(db, { ...claim, teamId: `TOAUTH${number}`,
      botUserId: `UOAUTH${number}`, token: `xoxb-oauth-${number}${suffix}`, encryptionKey: key }), true);
    const pending = await readPendingSlackOAuthInstallation(db, session.id, key);
    assert.ok(pending);
    return pending;
  };
  const snapshot = async () => ({
    tenants: await db.selectFrom("tenants").selectAll().orderBy("id").execute(),
    workspaces: await db.selectFrom("slack_workspaces").selectAll().orderBy("team_id").execute(),
    installations: await db.selectFrom("github_installations").selectAll().orderBy("installation_id").execute(),
    routes: await db.selectFrom("team_channel_routes").selectAll().orderBy("team_id").execute(),
  });
  const first = await stage(1);
  const oauthInput = { db, providers: oauthProviders, slackInstallationId: first.id,
    encryptionKey: key, installationId: "20001", repository: { owner: "OAuth", repo: "One" }, selectedChannelId: "COAUTH1" };
  const beforeOauth = await snapshot();
  await assert.rejects(provisionTenant({ ...oauthInput, slackBotToken: first.token }), /exactly one/);
  await assert.rejects(provisionTenant({ ...oauthInput, slackInstallationId: undefined }), /exactly one/);
  await assert.rejects(provisionTenant({ ...oauthInput, encryptionKey: Buffer.alloc(32, 8) }), /cannot be decrypted/);
  const wrongWorkspace = encryptSlackToken({ token: first.token, teamId: "TWRONG", key });
  await db.updateTable("slack_oauth_installations").set({ bot_token_ciphertext: wrongWorkspace }).where("id", "=", first.id).execute();
  await assert.rejects(provisionTenant(oauthInput), /cannot be decrypted/);
  await db.updateTable("slack_oauth_installations").set({ bot_token_ciphertext: first.expectedCiphertext }).where("id", "=", first.id).execute();
  for (const mismatched of [{ teamId: "TOTHER", botUserId: "UOAUTH1" }, { teamId: "TOAUTH1", botUserId: "UOTHER" }]) {
    await assert.rejects(provisionTenant({ ...oauthInput, providers: { ...oauthProviders,
      inspectSlackToken: async () => ({ ...mismatched, channelIds: ["COAUTH1"] }) } }), /live Slack workspace and bot/);
  }
  for (const provider of ["inspectSlackToken", "inspectInstallationRepository"] as const) {
    await assert.rejects(provisionTenant({ ...oauthInput, providers: { ...oauthProviders,
      [provider]: async () => { throw new Error(`Untrusted provider body: ${first.token}`); } } }),
    (error: Error) => { assert.match(error.message, /provider validation failed/); assert.ok(!error.message.includes(first.token)); return true; });
  }
  assert.deepEqual(await snapshot(), beforeOauth);
  assert.equal((await getSlackOAuthInstallationStatus(db, first.id))?.status, "pending");

  // A new envelope written after validation invalidates this provisioning attempt,
  // even when it decrypts to the same token. The previous tenant state rolls back.
  const changedEnvelope = encryptSlackToken({ token: first.token, teamId: first.teamId, key });
  await assert.rejects(provisionTenant({ ...oauthInput, providers: { ...oauthProviders,
    inspectSlackToken: async (token) => {
      await db.updateTable("slack_oauth_installations").set({ bot_token_ciphertext: changedEnvelope }).where("id", "=", first.id).execute();
      return oauthProviders.inspectSlackToken(token);
    } } }), /unavailable/);
  assert.deepEqual(await snapshot(), beforeOauth);
  assert.equal((await readPendingSlackOAuthInstallation(db, first.id, key))?.expectedCiphertext, changedEnvelope);
  const firstResult = await provisionTenant(oauthInput);
  const firstActive = await db.selectFrom("slack_workspaces").selectAll().where("team_id", "=", first.teamId).executeTakeFirstOrThrow();
  assert.equal(firstActive.bot_token_ciphertext, changedEnvelope);
  assert.equal((await getSlackOAuthInstallationStatus(db, first.id))?.consumedTenantId, firstResult.tenantId);
  assert.equal((await getSlackOAuthInstallationStatus(db, first.id))?.consumedGitHubInstallationId, "20001");
  assert.equal((await getSlackOAuthInstallationStatus(db, first.id))?.expiresAt, null);
  assert.equal(await readPendingSlackOAuthInstallation(db, first.id, key), null);
  await assert.rejects(provisionTenant(oauthInput), /unavailable/);

  const reinstall = await stage(1, "-reinstall");
  assert.deepEqual(await db.selectFrom("slack_workspaces").selectAll().where("team_id", "=", first.teamId).executeTakeFirstOrThrow(), firstActive);
  const reinstallInput = { ...oauthInput, slackInstallationId: reinstall.id };
  const beforeReinstall = await snapshot();
  await sql`create function fail_oauth_consumption() returns trigger language plpgsql as $$
    begin if new.status = 'consumed' then raise exception 'Simulated consumption failure'; end if; return new; end $$;
    create trigger fail_oauth_consumption before update on slack_oauth_installations
    for each row execute function fail_oauth_consumption();`.execute(db);
  try {
    await assert.rejects(provisionTenant(reinstallInput), /Simulated consumption failure/);
    assert.deepEqual(await snapshot(), beforeReinstall);
    assert.equal((await readPendingSlackOAuthInstallation(db, reinstall.id, key))?.expectedCiphertext, reinstall.expectedCiphertext);
  } finally {
    await sql`drop trigger fail_oauth_consumption on slack_oauth_installations; drop function fail_oauth_consumption();`.execute(db);
  }
  assert.equal((await provisionTenant(reinstallInput)).tenantId, firstResult.tenantId);
  assert.equal((await db.selectFrom("slack_workspaces").select("bot_token_ciphertext").where("team_id", "=", first.teamId).executeTakeFirstOrThrow()).bot_token_ciphertext, reinstall.expectedCiphertext);

  const second = await stage(2);
  const secondInput = { ...oauthInput, slackInstallationId: second.id, installationId: "20002", selectedChannelId: "COAUTH2" };
  const secondResults = await Promise.allSettled([provisionTenant(secondInput), provisionTenant(secondInput)]);
  assert.equal(secondResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(String(secondResults.find((result) => result.status === "rejected")?.reason), /unavailable/);
  const third = await stage(3);
  const beforeCancel = await snapshot();
  await assert.rejects(provisionTenant({ ...oauthInput, slackInstallationId: third.id, installationId: "20003", selectedChannelId: "COAUTH3",
    providers: { ...oauthProviders, inspectSlackToken: async (token) => {
      assert.equal(await cancelSlackOAuthInstallation(db, third.id), true);
      return oauthProviders.inspectSlackToken(token);
    } } }), /unavailable/);
  assert.deepEqual(await snapshot(), beforeCancel);
  assert.equal((await getSlackOAuthInstallationStatus(db, third.id))?.status, "cancelled");
  const thirdRetry = await stage(3);
  await provisionTenant({ ...oauthInput, slackInstallationId: thirdRetry.id, installationId: "20003", selectedChannelId: "COAUTH3" });
  assert.equal((await validateMultitenancy({ db, encryptionKey: key })).ok, true);

  // Exercise the actual compiled command without provider network or shared dist.
  // The preload supplies only fake fetch responses; CLI parsing, env validation,
  // provider clients, crypto and PostgreSQL transactions run unchanged.
  const compiledDirectory = await mkdtemp(fileURLToPath(new URL("../.admin-selftest-", import.meta.url)));
  try {
    await build({ entry: [fileURLToPath(new URL("../src/admin.ts", import.meta.url))], outDir: compiledDirectory,
      format: ["esm"], platform: "node", target: "node24", config: false, silent: true, noExternal: ["@feature-rec/core"] });
    const preload = join(compiledDirectory, "providers.mjs");
    await writeFile(preload, `globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const reply = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (url.origin === "https://slack.com") {
        if (new Headers(init?.headers).get("authorization") !== "Bearer " + process.env.CLI_TEST_TOKEN) throw new Error("Unexpected test credential");
        if (process.env.CLI_TEST_PROVIDER_FAILURE) return reply({ ok: false, error: "invalid_auth", response_metadata: { messages: [process.env.CLI_TEST_TOKEN] } });
        if (url.pathname === "/api/auth.test") return reply({ ok: true, team_id: process.env.CLI_TEST_TEAM, user_id: process.env.CLI_TEST_BOT });
        if (url.pathname === "/api/users.conversations") return reply({ ok: true, channels: [{ id: "CCLI" }] });
      }
      if (url.origin === "https://api.github.com") {
        if (url.pathname.endsWith("/access_tokens")) return reply({ token: "fake-github-access-token" });
        if (url.pathname === "/app/installations/21001" || url.pathname === "/repos/Cli/Repo/installation") return reply({ id: 21001, account: { id: 21001 } });
        if (url.pathname === "/repos/Cli/Repo") return reply({ id: 21001, name: "Repo", full_name: "Cli/Repo", owner: { id: 21001, login: "Cli" } });
      }
      throw new Error("Unexpected provider request in admin CLI test");
    };`);
    const rsaKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const cliEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: testUrl, RAILWAY_ENVIRONMENT_NAME: "selftest",
      FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY: key.toString("base64"), GITHUB_OIDC_ISSUER: "https://token.actions.githubusercontent.com",
      GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: rsaKey, SLACK_APP_ID: "", SLACK_CLIENT_ID: "", SLACK_CLIENT_SECRET: "",
      CLI_TEST_TOKEN: "xoxb-oauth-4", CLI_TEST_TEAM: "TOAUTH4", CLI_TEST_BOT: "UOAUTH4" };
    const cli = (args: string[], extraEnv: NodeJS.ProcessEnv = {}, manualToken?: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(process.execPath, ["--import", preload, join(compiledDirectory, "admin.js"), ...args],
        { env: { ...cliEnv, ...extraEnv }, timeout: 10_000 }, (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
        });
      child.stdin!.end(manualToken === undefined ? undefined : `${manualToken}\n`);
    });
    const fourth = await stage(4);
    const provisionArgs = ["provision-tenant", "--environment", "selftest", "--confirm", "--installation-id", "21001", "--repository", "Cli/Repo", "--selected-channel-id", "CCLI", "--slack-installation-id", fourth.id];
    await assert.rejects(cli(provisionArgs.filter((arg) => arg !== "--confirm")), /requires --confirm/);
    await assert.rejects(cli(provisionArgs, { RAILWAY_ENVIRONMENT_NAME: "production" }), /does not match/);
    await assert.rejects(cli(provisionArgs, { CLI_TEST_PROVIDER_FAILURE: "1" }), (error: Error & { stdout: string; stderr: string }) => {
      assert.match(error.stderr, /provider validation failed/);
      assert.ok(!error.stderr.includes(fourth.token));
      assert.ok(!error.stdout.includes(fourth.expectedCiphertext));
      return true;
    });
    const activatedCli = await cli(provisionArgs);
    assert.equal(activatedCli.stderr, "");
    const activatedReceipt = JSON.parse(activatedCli.stdout);
    assert.equal(activatedReceipt.slackTeamId, fourth.teamId);
    assert.equal((await db.selectFrom("slack_workspaces").select("bot_token_ciphertext").where("team_id", "=", fourth.teamId).executeTakeFirstOrThrow()).bot_token_ciphertext, fourth.expectedCiphertext);
    const brokenConfig = { FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY: "invalid", GITHUB_OIDC_ISSUER: "invalid", SLACK_APP_ID: "partial" };
    const stateBeforeRead = await db.selectFrom("slack_oauth_installations").selectAll().where("id", "=", fourth.id).executeTakeFirstOrThrow();
    const statusCli = await cli(["slack-installation-status", "--environment", "selftest", "--slack-installation-id", fourth.id], brokenConfig);
    const receiptCli = JSON.parse(statusCli.stdout).installation;
    assert.equal(receiptCli.status, "consumed");
    assert.equal(receiptCli.consumedTenantId, activatedReceipt.tenantId);
    assert.equal(receiptCli.consumedGitHubInstallationId, "21001");
    assert.equal(receiptCli.expiresAt, null);
    assert.deepEqual(await db.selectFrom("slack_oauth_installations").selectAll().where("id", "=", fourth.id).executeTakeFirstOrThrow(), stateBeforeRead);
    for (const secret of [fourth.token, fourth.expectedCiphertext, "fake-github-access-token", "state_hash", "browser_binding_hash", "claim_id"]) {
      assert.ok(!`${statusCli.stdout}${activatedCli.stdout}`.includes(secret));
    }
    await assert.rejects(cli(provisionArgs), /unavailable/);
    const pendingCancel = await stage(5);
    const cancelArgs = ["cancel-slack-installation", "--environment", "selftest", "--slack-installation-id", pendingCancel.id];
    await assert.rejects(cli(cancelArgs, brokenConfig), /requires --confirm/);
    assert.equal((await getSlackOAuthInstallationStatus(db, pendingCancel.id))?.status, "pending");
    const cancelCli = JSON.parse((await cli([...cancelArgs, "--confirm"], brokenConfig)).stdout);
    assert.equal(cancelCli.cancelled, true);
    assert.equal(cancelCli.installation.status, "cancelled");
    assert.equal(await readPendingSlackOAuthInstallation(db, pendingCancel.id, key), null);
    assert.equal(JSON.parse((await cli([...cancelArgs, "--confirm"], brokenConfig)).stdout).cancelled, false);
    await assert.rejects(cli(["slack-installation-status", "--environment", "selftest", "--slack-installation-id", "invalid"], brokenConfig), /must be a UUID/);
    await assert.rejects(cli(["slack-installation-status", "--slack-installation-id", fourth.id], brokenConfig), /--environment is required/);
    const manualCli = await cli(provisionArgs.slice(0, -2), {}, fourth.token);
    assert.equal(JSON.parse(manualCli.stdout).tenantId, activatedReceipt.tenantId);
    const manualEnvelope = (await db.selectFrom("slack_workspaces").select("bot_token_ciphertext").where("team_id", "=", fourth.teamId).executeTakeFirstOrThrow()).bot_token_ciphertext;
    assert.notEqual(manualEnvelope, fourth.expectedCiphertext);
    assert.equal(decryptSlackToken({ envelope: manualEnvelope, teamId: fourth.teamId, key }), fourth.token);
  } finally {
    await rm(compiledDirectory, { recursive: true, force: true });
  }

  console.log("service admin selftest passed");
} finally {
  await db.destroy().catch(() => {});
  const dropper = new Client({ connectionString: adminUrl });
  await dropper.connect();
  await dropper.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await dropper.end();
}
