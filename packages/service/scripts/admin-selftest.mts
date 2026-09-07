import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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
  assert.equal(status.migrations.at(-1).name, "0008_multitenant_expand");
  assert.equal(status.migrations.at(-1).status, "executed");
  for (const missing of ["--expect-current", "--service-stopped", "--traffic-paused"]) {
    const flags = ["--confirm", "--service-stopped", "--traffic-paused"];
    if (missing !== "--expect-current") flags.push("--expect-current", "0008_multitenant_expand");
    await assert.rejects(runAdmin(["migrate-to", "0007_mention_modes", ...flags.filter((flag) => flag !== missing)]), /Schema downgrade requires/);
    assert.equal(JSON.parse((await runAdmin(["migration-status"])).stdout).migrations.at(-1).status, "executed");
  }
  await assert.rejects(runAdmin(["migrate-to", "0007_mention_modes", "--confirm", "--expect-current"]), /argument missing|requires a value|argument is ambiguous/);
  await assert.rejects(runAdmin(["migrate-to", "0007_mention_modes", "--confirm", "--expect-current=", "--service-stopped", "--traffic-paused"]), /non-empty value/);
  const migrationBlocker = new Client({ connectionString: testUrl });
  await migrationBlocker.connect();
  try {
    await migrationBlocker.query("select pg_advisory_lock(hashtextextended('feature-rec-migrations', 0))");
    const competing = Promise.allSettled([0, 1].map(() => runAdmin(["migrate-to", "0007_mention_modes", "--confirm", "--expect-current", "0008_multitenant_expand", "--service-stopped", "--traffic-paused"])));
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
  await runAdmin(["migrate-to", "0008_multitenant_expand", "--confirm", "--expect-current", "0007_mention_modes"]);
  assert.equal(JSON.parse((await runAdmin(["prepare-rollback-to-a", "--dry-run"])).stdout).ok, true);
  await assert.rejects(runAdmin(["validate-contract-readiness"]), /canonical base64/);

  assert.deepEqual(await inspectSlackTokenEncryption(db, null), { keyError: null, invalidWorkspaces: [] });
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
  assert.deepEqual(await inspectSlackTokenEncryption(db, key), { keyError: null, invalidWorkspaces: [] });
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
  assert.deepEqual(await inspectSlackTokenEncryption(db, key), { keyError: null, invalidWorkspaces: [{ tenantId, teamId: "TADMIN" }] });
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
  assert.deepEqual(await inspectSlackTokenEncryption(db, key), { keyError: null, invalidWorkspaces: [{ tenantId, teamId: "TADMIN" }] });
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

  console.log("service admin selftest passed");
} finally {
  await db.destroy().catch(() => {});
  const dropper = new Client({ connectionString: adminUrl });
  await dropper.connect();
  await dropper.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await dropper.end();
}
