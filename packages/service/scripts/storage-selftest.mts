import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Client, Pool } from "pg";
import { buildCycleKey } from "@feature-rec/core";
import type { StartCycleInput } from "../src/storage";
import { PostgresCycleStore } from "../src/storage/postgres";
import type { DB } from "../src/storage/schema";
import { migrationProvider } from "../src/storage/migrations";

const adminUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const dbName = `feature_rec_storage_test_${crypto.randomBytes(8).toString("hex")}`;
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
const store = new PostgresCycleStore(url.toString());
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url.toString() }) }) });

const tenantA = "c8673185-5802-4c37-98cd-7b5126bb742b";
const tenantB = "960d5307-27da-4003-b125-96479292b876";
const repositoryId = "9007199254740993";
function start(overrides: Partial<StartCycleInput> = {}): StartCycleInput {
  const input = {
    tenantId: tenantA,
    repositoryId,
    owner: "Original",
    repo: "Name",
    prNumber: 1,
    headSha: "first-head",
    prAuthor: "author",
    prTitle: "Verified title",
    ...overrides,
  };
  return { ...input, cycleKey: buildCycleKey(input) };
}

try {
  assert.equal(Object.keys(await migrationProvider.getMigrations()).sort().at(-1), "0009_slack_oauth_installations");
  await store.init();
  await db.insertInto("tenants").values([{ id: tenantA, enabled: true }, { id: tenantB, enabled: true }]).execute();
  await db.insertInto("github_installations").values([
    { tenant_id: tenantA, installation_id: "9007199254740995", github_account_id: "9007199254740997" },
    { tenant_id: tenantB, installation_id: "2", github_account_id: "3" },
  ]).execute();
  await db.insertInto("slack_workspaces").values([
    { tenant_id: tenantA, team_id: "TA", bot_user_id: "UBOTA", bot_token_ciphertext: "ciphertext-a", selected_channel_id: null },
    { tenant_id: tenantB, team_id: "TB", bot_user_id: "UBOTB", bot_token_ciphertext: "ciphertext-b", selected_channel_id: null },
  ]).execute();

  // Every provider bigint crosses the storage boundary without a Number coercion.
  assert.deepEqual(await store.getEnabledGitHubInstallationByAccountId("9007199254740997"), {
    tenantId: tenantA, installationId: "9007199254740995", githubAccountId: "9007199254740997", enabled: true,
  });
  assert.equal((await store.getGitHubInstallationByTenantId(tenantA))?.installationId, "9007199254740995");
  assert.equal(await store.getEnabledGitHubInstallationByAccountId("999"), null);
  assert.equal((await store.getSlackWorkspaceByTeamId("TA"))?.tenantId, tenantA);
  assert.equal((await store.getSlackWorkspaceByTenantId(tenantB))?.botUserId, "UBOTB");

  const [first, duplicate] = await Promise.all([store.startCycle(start()), store.startCycle(start())]);
  assert.equal(Number(first.created) + Number(duplicate.created), 1);
  assert.equal(first.cycle.id, duplicate.cycle.id);
  const active = first.created ? first : duplicate;
  assert.equal(active.cycle.repositoryId, repositoryId);
  assert.equal(active.cycle.cycleKey, `${tenantA}/${repositoryId}#1:first-head`);

  const otherTenant = await store.startCycle(start({ tenantId: tenantB }));
  const otherRepository = await store.startCycle(start({ repositoryId: "42" }));
  assert.equal((await store.getCycle(active.cycle.id))?.status, "analyzing");

  // Same authenticated identity after rename is a duplicate; display names never
  // partition locks or supersession. Other repositories and tenants survive.
  const renamedDuplicate = await store.startCycle(start({ owner: "Renamed", repo: "Moved" }));
  assert.equal(renamedDuplicate.created, false);
  assert.equal(renamedDuplicate.cycle.id, active.cycle.id);
  const [renamedA, renamedB] = await Promise.all([
    store.startCycle(start({ owner: "Renamed", headSha: "second-head" })),
    store.startCycle(start({ owner: "Another", headSha: "third-head" })),
  ]);
  const statuses = await Promise.all([renamedA, renamedB].map(async (result) => (await store.getCycle(result.cycle.id))!.status));
  assert.deepEqual(statuses.sort(), ["analyzing", "superseded"]);
  assert.equal((await store.getCycle(active.cycle.id))?.status, "superseded");
  assert.equal((await store.getCycle(otherTenant.cycle.id))?.status, "analyzing");
  assert.equal((await store.getCycle(otherRepository.cycle.id))?.status, "analyzing");

  assert.ok(otherRepository.created);
  const runner = {
    cycleId: otherRepository.cycle.id,
    tenantId: tenantA,
    repositoryId: "42",
    attemptId: otherRepository.attemptId,
    from: ["analyzing"] as Array<"analyzing">,
    to: "failed" as const,
  };
  for (const mismatch of [
    { tenantId: tenantB }, { repositoryId }, { attemptId: crypto.randomUUID() }, { from: ["accepted"] as Array<"accepted"> },
  ]) {
    assert.equal(await store.transitionRunnerStatus({ ...runner, ...mismatch }), null);
    assert.equal((await store.getCycle(runner.cycleId))?.status, "analyzing");
  }
  assert.equal((await store.transitionRunnerStatus(runner))?.status, "failed");
  const newer = await store.startCycle(start({ repositoryId: "42", headSha: "newer-head" }));
  const takeover = await store.startCycle(start({ repositoryId: "42" }));
  assert.ok(takeover.created);
  assert.equal(takeover.cycle.id, otherRepository.cycle.id);
  assert.notEqual(takeover.attemptId, runner.attemptId);
  assert.equal((await store.getCycle(newer.cycle.id))?.status, "analyzing");
  assert.equal(await store.transitionRunnerStatus(runner), null);
  assert.equal(await store.transitionSlackStatus({ cycleId: takeover.cycle.id, tenantId: tenantB, from: ["analyzing"], to: "accepted" }), null);
  assert.equal((await store.transitionSlackStatus({ cycleId: takeover.cycle.id, tenantId: tenantA, from: ["analyzing"], to: "accepted" }))?.status, "accepted");

  // C-written rows remain readable during a C-to-B rollback: compatibility
  // names may be null even though authenticated identity must be present.
  await db.updateTable("review_cycles").set({ owner: null, repo: null }).where("id", "=", newer.cycle.id).execute();
  assert.equal((await store.getCycle(newer.cycle.id))?.owner, null);
  assert.equal((await store.getCycleByKey(newer.cycle.cycleKey))?.repositoryId, "42");

  // Legacy routes never supply runtime routing authority after cutover.
  await db.insertInto("team_channel_routes").values([
    { team_id: "TA", selected_channel_id: "CLEGACY" }, { team_id: "UNKNOWN", selected_channel_id: "CUNSAFE" },
  ]).execute();
  assert.equal(await store.getSelectedChannelId("TA"), null);
  assert.equal(await store.getSelectedChannelId("UNKNOWN"), null);
  await assert.rejects(store.selectTeamChannel({ teamId: "UNKNOWN", channelId: "CNEW" }), /no longer installed/);
  const initialized = await Promise.all(["CA1", "CA2"].map((channelId) => store.initializeTeamChannelRoute({ teamId: "TA", channelId })));
  assert.equal(initialized.filter((result) => result.initializedRoute).length, 1);
  await Promise.all(["CA3", "CA4"].map((channelId) => store.selectTeamChannel({ teamId: "TA", channelId })));
  const channelA = (await store.getSelectedChannelId("TA"))!;
  assert.equal((await db.selectFrom("team_channel_routes").select("selected_channel_id").where("team_id", "=", "TA").executeTakeFirstOrThrow()).selected_channel_id, channelA);
  assert.equal(await store.setSelectedChannelApprovers({ teamId: "TA", expectedChannelId: "CSTALE", approvers: ["UWRONG"], updatedBy: "UA" }), false);
  assert.equal(await store.setSelectedChannelApprovers({ teamId: "TA", expectedChannelId: channelA, approvers: ["UA"], updatedBy: "UA" }), true);
  await store.selectTeamChannel({ teamId: "TB", channelId: "CB" });
  await store.setSelectedChannelMentionSetting({ teamId: "TB", expectedChannelId: "CB", mention: { mode: "off" }, updatedBy: "UB" });

  const tokenA = (await store.getSlackWorkspaceByTeamId("TA"))!.botTokenCiphertext;
  const tokenB = (await store.getSlackWorkspaceByTeamId("TB"))!.botTokenCiphertext;
  assert.equal(await store.deleteSlackWorkspace("TA", "old-token-ciphertext"), false);
  assert.equal((await store.getSlackWorkspaceByTeamId("TA"))?.enabled, true);
  assert.deepEqual((await store.getChannelSettings("TA", channelA)).approvers, ["UA"]);
  assert.equal(await store.getSelectedChannelId("TA"), channelA);

  // Inject a database failure after deletion to prove tenant disable and all
  // integration/settings deletes roll back as one transaction, before the FK.
  await sql`
    create function reject_tenant_disable() returns trigger language plpgsql as $$
    begin raise exception 'test disable failure'; end $$;
    create trigger reject_tenant_disable before update on tenants
      for each row execute function reject_tenant_disable()
  `.execute(db);
  await assert.rejects(store.deleteSlackWorkspace("TA", tokenA), /test disable failure/);
  assert.ok(await store.getSlackWorkspaceByTeamId("TA"));
  assert.deepEqual((await store.getChannelSettings("TA", channelA)).approvers, ["UA"]);
  assert.equal(await store.getSelectedChannelId("TA"), channelA);
  await sql`drop trigger reject_tenant_disable on tenants; drop function reject_tenant_disable()`.execute(db);

  // Lifecycle events work for disabled tenants, repeated deliveries are harmless,
  // and late setting/channel writes cannot resurrect orphan rows.
  await db.updateTable("tenants").set({ enabled: false }).where("id", "=", tenantA).execute();
  assert.equal(await store.getEnabledGitHubInstallationByAccountId("9007199254740997"), null);
  assert.equal((await store.getGitHubInstallationByTenantId(tenantA))?.enabled, false);
  assert.equal((await store.getSlackWorkspaceByTeamId("TA"))?.enabled, false);
  await Promise.all([store.deleteSlackWorkspace("TA", tokenA), store.deleteSlackWorkspace("TA", tokenA)]);
  assert.equal(await store.getSlackWorkspaceByTeamId("TA"), null);
  assert.equal(await store.getSlackWorkspaceByTenantId(tenantA), null);
  assert.equal(await store.getSelectedChannelId("TA"), null);
  assert.equal(await store.setSelectedChannelApprovers({ teamId: "TA", expectedChannelId: channelA, approvers: ["UA"], updatedBy: "UA" }), false);
  await assert.rejects(store.initializeTeamChannelRoute({ teamId: "TA", channelId: "CLATE" }), /no longer installed/);
  assert.equal((await db.selectFrom("channel_settings").selectAll().where("team_id", "=", "TA").execute()).length, 0);
  assert.equal((await db.selectFrom("team_channel_routes").selectAll().where("team_id", "=", "TA").execute()).length, 0);
  assert.equal((await store.getSlackWorkspaceByTeamId("TB"))?.enabled, true);
  assert.equal((await store.getChannelSettings("TB", "CB")).mention.mode, "off");
  assert.ok(await store.getGitHubInstallationByTenantId(tenantA));
  assert.ok(await store.getCycle(active.cycle.id));
  await store.deleteSlackWorkspace("TB", tokenB);
  assert.equal((await store.getGitHubInstallationByTenantId(tenantB))?.enabled, false);
  console.log("service storage selftest passed");
} finally {
  await store.close().catch(() => {});
  await db.destroy().catch(() => {});
  const dropper = new Client({ connectionString: adminUrl });
  await dropper.connect();
  await dropper.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await dropper.end();
}
