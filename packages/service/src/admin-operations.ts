import crypto from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import { buildLegacyCycleKey, buildTenantCycleKey } from "@feature-rec/core";
import { GitHubRequestError, type GitHubRepositoryIdentity } from "./github";
import { encryptSlackToken } from "./slack-token-crypto";
import type { DB } from "./storage/schema";
import { lockTeamChannelRoute, lockTenantProvisioning } from "./storage/locks";
import { ensureSlackTokenKey, inspectSlackTokenEncryption } from "./storage/slack-token-check";
import { writeSelectedChannel } from "./storage/channel-routing";
import { consumeSlackOAuthInstallation, readPendingSlackOAuthInstallation } from "./storage/slack-oauth";

type Database = Kysely<DB> | Transaction<DB>;

export type SlackInstallationInspection = {
  teamId: string;
  botUserId: string;
  channelIds: string[];
};

export type AdminProviders = {
  inspectSlackToken(token: string): Promise<SlackInstallationInspection>;
  resolveRepository(owner: string, repo: string): Promise<GitHubRepositoryIdentity>;
  inspectInstallationRepository(
    installationId: string,
    owner: string,
    repo: string,
  ): Promise<GitHubRepositoryIdentity>;
};

export type ValidationReport = {
  ok: boolean;
  issues: string[];
  counts: {
    tenants: number;
    enabledTenants: number;
    slackWorkspaces: number;
    githubInstallations: number;
    reviewCycles: number;
  };
};

type LegacyCycle = {
  id: string;
  owner: string | null;
  repo: string | null;
  pr_number: number;
  head_sha: string;
  cycle_key: string;
  tenant_id: string | null;
  repository_id: string | null;
};

function positiveDecimal(value: string, label: string): string {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive decimal string`);
  return value;
}

function uuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function repositoryKey(owner: string, repo: string): string {
  return `${owner}\u0000${repo}`;
}

async function countTable(db: Database, table: keyof DB): Promise<number> {
  const result = await sql<{ count: string }>`select count(*)::text as count from ${sql.table(table)}`.execute(db);
  return Number(result.rows[0]?.count ?? "0");
}

async function loadLegacyCycles(db: Database): Promise<LegacyCycle[]> {
  return db
    .selectFrom("review_cycles")
    .select([
      "id",
      "owner",
      "repo",
      "pr_number",
      "head_sha",
      "cycle_key",
      "tenant_id",
      "repository_id",
    ])
    .orderBy("id")
    .execute();
}

async function integrationTenantCandidates(db: Database): Promise<string[]> {
  const rows = await sql<{ tenant_id: string }>`
    select tenant_id::text as tenant_id from slack_workspaces
    union
    select tenant_id::text as tenant_id from github_installations
  `.execute(db);
  if (rows.rows.length > 0) return unique(rows.rows.map((row) => row.tenant_id));
  const tenants = await db.selectFrom("tenants").select("id").execute();
  return unique(tenants.map((row) => row.id));
}

function selectTenantId(requested: string | undefined, candidates: string[]): string {
  const normalizedRequested = requested ? uuid(requested, "Tenant ID") : undefined;
  if (candidates.length > 1) {
    throw new Error("Existing multitenancy rows refer to more than one tenant; singleton backfill refuses to guess");
  }
  if (normalizedRequested && candidates[0] && normalizedRequested !== candidates[0]) {
    throw new Error("Requested tenant ID does not match the existing singleton integration tenant");
  }
  return normalizedRequested ?? candidates[0] ?? crypto.randomUUID();
}

export async function validateMultitenancy(input: {
  db: Database;
  encryptionKey: Buffer | null;
  requireFutureCycleKeys?: boolean;
}): Promise<ValidationReport> {
  const issues: string[] = [];
  const [tenants, enabledTenants, slackWorkspaces, githubInstallations, reviewCycles] =
    await Promise.all([
      countTable(input.db, "tenants"),
      sql<{ count: string }>`select count(*)::text as count from tenants where enabled`.execute(input.db).then((r) => Number(r.rows[0]?.count ?? "0")),
      countTable(input.db, "slack_workspaces"),
      countTable(input.db, "github_installations"),
      countTable(input.db, "review_cycles"),
    ]);

  const nullCycleIds = await sql<{ count: string }>`
    select count(*)::text as count from review_cycles
    where tenant_id is null or repository_id is null
  `.execute(input.db);
  if (nullCycleIds.rows[0]?.count !== "0") {
    issues.push(`${nullCycleIds.rows[0]?.count ?? "unknown"} review cycle(s) lack tenant/repository identity`);
  }

  const duplicateFutureKeys = await sql<{ tenant_id: string; repository_id: string; pr_number: number; head_sha: string; count: string }>`
    select
      tenant_id::text, repository_id::text, pr_number, head_sha,
      count(*)::text as count
    from review_cycles
    where tenant_id is not null and repository_id is not null
    group by tenant_id, repository_id, pr_number, head_sha
    having count(*) > 1
    order by tenant_id, repository_id, pr_number, head_sha
  `.execute(input.db);
  for (const collision of duplicateFutureKeys.rows) {
    const key = buildTenantCycleKey({ tenantId: collision.tenant_id, repositoryId: collision.repository_id, prNumber: collision.pr_number, headSha: collision.head_sha });
    issues.push(`future cycle key collision (${collision.count} rows): ${key}`);
  }

  if (input.requireFutureCycleKeys) {
    const cycles = await loadLegacyCycles(input.db);
    for (const cycle of cycles) {
      if (cycle.tenant_id === null || cycle.repository_id === null) continue;
      const expected = buildTenantCycleKey({
        tenantId: cycle.tenant_id,
        repositoryId: cycle.repository_id,
        prNumber: cycle.pr_number,
        headSha: cycle.head_sha,
      });
      if (cycle.cycle_key !== expected) {
        issues.push(`review cycle ${cycle.id} has not been switched to its multitenant cycle key`);
      }
    }
  }

  const enabledMissing = await sql<{ tenant_id: string; slack_count: string; github_count: string }>`
    select
      t.id::text as tenant_id,
      count(distinct sw.team_id)::text as slack_count,
      count(distinct gi.installation_id)::text as github_count
    from tenants t
    left join slack_workspaces sw on sw.tenant_id = t.id
    left join github_installations gi on gi.tenant_id = t.id
    where t.enabled
    group by t.id
    having count(distinct sw.team_id) <> 1 or count(distinct gi.installation_id) <> 1
  `.execute(input.db);
  for (const row of enabledMissing.rows) {
    issues.push(
      `enabled tenant ${row.tenant_id} has ${row.slack_count} Slack workspace(s) and ${row.github_count} GitHub installation(s)`,
    );
  }

  const orphans = await sql<{ team_id: string }>`
    select distinct cs.team_id
    from channel_settings cs
    left join slack_workspaces sw on sw.team_id = cs.team_id
    where sw.team_id is null
    order by cs.team_id
  `.execute(input.db);
  for (const row of orphans.rows) {
    issues.push(`channel settings for ${row.team_id} have no Slack workspace`);
  }

  const routeDrift = await sql<{
    team_id: string;
    legacy_channel_id: string | null;
    workspace_channel_id: string | null;
  }>`
    select
      coalesce(route.team_id, workspace.team_id) as team_id,
      route.selected_channel_id as legacy_channel_id,
      workspace.selected_channel_id as workspace_channel_id
    from team_channel_routes route
    full join slack_workspaces workspace on workspace.team_id = route.team_id
    where route.selected_channel_id is distinct from workspace.selected_channel_id
    order by team_id
  `.execute(input.db);
  for (const row of routeDrift.rows) {
    issues.push(`selected-channel compatibility values diverge for ${row.team_id}`);
  }

  const tokenCheck = await inspectSlackTokenEncryption(input.db, input.encryptionKey);
  if (tokenCheck.keyError) issues.push(tokenCheck.keyError);
  for (const workspace of tokenCheck.invalidWorkspaces) {
    issues.push(`Slack token ciphertext for ${workspace.teamId} cannot be decrypted with team-bound AAD`);
  }

  for (const installation of tokenCheck.invalidPendingInstallations) {
    issues.push(`Pending Slack token ciphertext for ${installation.id} cannot be decrypted with team-bound AAD`);
  }

  return {
    ok: issues.length === 0,
    issues,
    counts: { tenants, enabledTenants, slackWorkspaces, githubInstallations, reviewCycles },
  };
}

async function loadPairings(input: {
  db: Database;
  tenantId: string;
  slack: SlackInstallationInspection;
  repository: GitHubRepositoryIdentity;
}) {
  const [teamRow, tenantWorkspace, installationRow, tenantInstallation, accountRow] =
    await Promise.all([
      input.db.selectFrom("slack_workspaces").selectAll().where("team_id", "=", input.slack.teamId).executeTakeFirst(),
      input.db.selectFrom("slack_workspaces").selectAll().where("tenant_id", "=", input.tenantId).executeTakeFirst(),
      input.db.selectFrom("github_installations").selectAll().where("installation_id", "=", input.repository.installationId).executeTakeFirst(),
      input.db.selectFrom("github_installations").selectAll().where("tenant_id", "=", input.tenantId).executeTakeFirst(),
      input.db.selectFrom("github_installations").selectAll().where("github_account_id", "=", input.repository.githubAccountId).executeTakeFirst(),
    ]);
  return { teamRow, tenantWorkspace, installationRow, tenantInstallation, accountRow };
}

async function assertBackfillPairings(input: Parameters<typeof loadPairings>[0]): Promise<void> {
  const { teamRow, tenantWorkspace, installationRow, tenantInstallation, accountRow } = await loadPairings(input);
  if (teamRow && teamRow.tenant_id !== input.tenantId) throw new Error("Slack workspace is already paired to another tenant");
  if (tenantWorkspace && tenantWorkspace.team_id !== input.slack.teamId) throw new Error("Tenant is already paired to another Slack workspace");
  if (installationRow && installationRow.tenant_id !== input.tenantId) throw new Error("GitHub installation is already paired to another tenant");
  if (tenantInstallation && tenantInstallation.installation_id !== input.repository.installationId) throw new Error("Tenant is already paired to another GitHub installation");
  if (accountRow && accountRow.tenant_id !== input.tenantId) throw new Error("GitHub account is already paired to another tenant");
}

export type BackfillReport = {
  applied: boolean;
  tenantId: string;
  slackTeamId: string;
  githubInstallationId: string | null;
  githubAccountId: string | null;
  repositories: number;
  repositoryMappings: Array<{
    repository: string;
    repositoryId: string;
    installationId: string;
    githubAccountId: string;
  }>;
  unresolvedRepositories: string[];
  cycles: number;
  futureCycleKeysRebuilt: boolean;
  validation: ValidationReport | null;
  issues: string[];
};

export async function backfillMultitenancy(input: {
  db: Kysely<DB>;
  providers: AdminProviders;
  slackBotToken: string;
  encryptionKey: Buffer;
  tenantId?: string;
  apply: boolean;
  rebuildCycleKeys?: boolean;
  trafficPaused?: boolean;
}): Promise<BackfillReport> {
  if (!input.slackBotToken) throw new Error("SLACK_BOT_TOKEN is required for singleton backfill");
  if (input.rebuildCycleKeys && !input.trafficPaused) {
    throw new Error("Rebuilding cycle keys requires an explicit traffic-paused acknowledgement");
  }

  const slack = await input.providers.inspectSlackToken(input.slackBotToken);
  const tenantCount = await countTable(input.db, "tenants");
  if (tenantCount > 1) {
    throw new Error("Singleton backfill cannot run after more than one tenant has been provisioned");
  }
  const candidates = await integrationTenantCandidates(input.db);
  const tenantId = selectTenantId(input.tenantId, candidates);
  const cycles = await loadLegacyCycles(input.db);
  const teamRows = await sql<{ team_id: string }>`
    select team_id from team_channel_routes
    union
    select team_id from channel_settings
    order by team_id
  `.execute(input.db);
  const issues: string[] = [];
  const tokenCheck = await inspectSlackTokenEncryption(input.db, input.encryptionKey);
  if (tokenCheck.keyError) issues.push(tokenCheck.keyError);
  for (const row of teamRows.rows) {
    if (row.team_id !== slack.teamId) {
      issues.push(`legacy Slack row ${row.team_id} does not belong to current bot workspace ${slack.teamId}`);
    }
  }

  const coordinatePairs = unique(
    cycles
      .filter((cycle) => cycle.owner !== null && cycle.repo !== null)
      .map((cycle) => repositoryKey(cycle.owner!, cycle.repo!)),
  );
  if (cycles.some((cycle) => cycle.owner === null || cycle.repo === null)) {
    issues.push("one or more review cycles lack legacy owner/repo coordinates");
  }

  const repositories = new Map<string, GitHubRepositoryIdentity>();
  const unresolvedRepositories: string[] = [];
  for (const pair of coordinatePairs) {
    const [owner, repo] = pair.split("\u0000");
    try {
      repositories.set(pair, await input.providers.resolveRepository(owner, repo));
    } catch (error) {
      unresolvedRepositories.push(`${owner}/${repo}`);
      const reason = error instanceof GitHubRequestError
        ? error.message
        : "unexpected discovery failure; check GitHub App configuration and repository access";
      issues.push(`legacy repository ${owner}/${repo} could not be resolved through the GitHub App: ${reason}`);
    }
  }
  const installationIds = unique([...repositories.values()].map((row) => row.installationId));
  const accountIds = unique([...repositories.values()].map((row) => row.githubAccountId));
  if (installationIds.length > 1 || accountIds.length > 1) {
    issues.push("legacy repositories resolve to more than one GitHub installation/account");
  }
  if (cycles.length > 0 && repositories.size === 0) {
    issues.push("no legacy repository could be resolved");
  }

  const futureKeys = new Map<string, string[]>();
  for (const cycle of cycles) {
    if (cycle.owner === null || cycle.repo === null) continue;
    const repository = repositories.get(repositoryKey(cycle.owner, cycle.repo));
    if (!repository) continue;
    if (cycle.tenant_id !== null && cycle.tenant_id !== tenantId) {
      issues.push(`review cycle ${cycle.id} is already assigned to another tenant`);
    }
    if (cycle.repository_id !== null && cycle.repository_id !== repository.repositoryId) {
      issues.push(`review cycle ${cycle.id} is already assigned to another repository ID`);
    }
    const key = buildTenantCycleKey({
      tenantId,
      repositoryId: repository.repositoryId,
      prNumber: cycle.pr_number,
      headSha: cycle.head_sha,
    });
    futureKeys.set(key, [...(futureKeys.get(key) ?? []), cycle.id]);
  }
  for (const [key, ids] of futureKeys) {
    if (ids.length > 1) issues.push(`future cycle key collision (${ids.join(", ")}): ${key}`);
  }

  const representative = repositories.values().next().value as GitHubRepositoryIdentity | undefined;
  if (!representative) issues.push("Backfill requires at least one GitHub repository; use provision-tenant for an empty review history");
  if (representative) {
    try {
      await assertBackfillPairings({ db: input.db, tenantId, slack, repository: representative });
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  const baseReport: BackfillReport = {
    applied: false,
    tenantId,
    slackTeamId: slack.teamId,
    githubInstallationId: representative?.installationId ?? null,
    githubAccountId: representative?.githubAccountId ?? null,
    repositories: repositories.size,
    repositoryMappings: [...repositories.entries()].map(([pair, repository]) => ({
      repository: pair.replace("\u0000", "/"),
      repositoryId: repository.repositoryId,
      installationId: repository.installationId,
      githubAccountId: repository.githubAccountId,
    })),
    unresolvedRepositories,
    cycles: cycles.length,
    futureCycleKeysRebuilt: false,
    validation: null,
    issues,
  };
  if (issues.length > 0 || !input.apply || !representative) return baseReport;

  const ciphertext = encryptSlackToken({
    token: input.slackBotToken,
    teamId: slack.teamId,
    key: input.encryptionKey,
  });
  await input.db.transaction().execute(async (trx) => {
    await lockTenantProvisioning(trx);
    await ensureSlackTokenKey(trx, input.encryptionKey);
    if (await countTable(trx, "tenants") > 1) {
      throw new Error("Singleton backfill cannot run after more than one tenant has been provisioned");
    }
    selectTenantId(tenantId, await integrationTenantCandidates(trx));
    await lockTeamChannelRoute(trx, slack.teamId);
    await assertBackfillPairings({ db: trx, tenantId, slack, repository: representative });
    await trx
      .insertInto("tenants")
      .values({ id: tenantId, enabled: false })
      .onConflict((oc) => oc.column("id").doUpdateSet({ enabled: false }))
      .execute();

    const selectedRoute = await trx
      .selectFrom("team_channel_routes")
      .select("selected_channel_id")
      .where("team_id", "=", slack.teamId)
      .executeTakeFirst();
    const existingWorkspace = await trx
      .selectFrom("slack_workspaces")
      .select("selected_channel_id")
      .where("team_id", "=", slack.teamId)
      .executeTakeFirst();
    const selectedChannelId =
      selectedRoute?.selected_channel_id ?? existingWorkspace?.selected_channel_id ?? null;
    await trx
      .insertInto("slack_workspaces")
      .values({
        team_id: slack.teamId,
        tenant_id: tenantId,
        bot_user_id: slack.botUserId,
        bot_token_ciphertext: ciphertext,
        selected_channel_id: selectedChannelId,
      })
      .onConflict((oc) =>
        oc.column("team_id").doUpdateSet({
          tenant_id: tenantId,
          bot_user_id: slack.botUserId,
          bot_token_ciphertext: ciphertext,
          selected_channel_id: selectedChannelId,
        }),
      )
      .execute();
    if (selectedChannelId !== null) await writeSelectedChannel(trx, slack.teamId, selectedChannelId);
    await trx
      .insertInto("github_installations")
      .values({
        installation_id: representative.installationId,
        tenant_id: tenantId,
        github_account_id: representative.githubAccountId,
      })
      .onConflict((oc) =>
        oc.column("installation_id").doUpdateSet({
          tenant_id: tenantId,
          github_account_id: representative.githubAccountId,
        }),
      )
      .execute();

    const currentCycles = await loadLegacyCycles(trx);
    for (const cycle of currentCycles) {
      if (cycle.owner === null || cycle.repo === null) {
        throw new Error(`Review cycle ${cycle.id} lacks legacy repository coordinates`);
      }
      const repository = repositories.get(repositoryKey(cycle.owner, cycle.repo));
      if (!repository) {
        throw new Error(`Review cycle ${cycle.id} appeared after repository discovery; rerun backfill`);
      }
      const futureCycleKey = buildTenantCycleKey({
        tenantId,
        repositoryId: repository.repositoryId,
        prNumber: cycle.pr_number,
        headSha: cycle.head_sha,
      });
      await trx
        .updateTable("review_cycles")
        .set({
          tenant_id: tenantId,
          repository_id: repository.repositoryId,
          ...(input.rebuildCycleKeys ? { cycle_key: futureCycleKey } : {}),
        })
        .where("id", "=", cycle.id)
        .execute();
    }

    const validation = await validateMultitenancy({
      db: trx,
      encryptionKey: input.encryptionKey,
      requireFutureCycleKeys: input.rebuildCycleKeys,
    });
    if (!validation.ok) throw new Error(`Backfill validation failed: ${validation.issues.join("; ")}`);
    await trx.updateTable("tenants").set({ enabled: true }).where("id", "=", tenantId).execute();
  });

  const validation = await validateMultitenancy({
    db: input.db,
    encryptionKey: input.encryptionKey,
    requireFutureCycleKeys: input.rebuildCycleKeys,
  });
  return {
    ...baseReport,
    applied: true,
    futureCycleKeysRebuilt: input.rebuildCycleKeys ?? false,
    validation,
  };
}

export type ProvisionReport = {
  tenantId: string;
  slackTeamId: string;
  githubInstallationId: string;
  githubAccountId: string;
  repositoryId: string;
  selectedChannelId: string | null;
  replacedPairings: string[];
};

export async function provisionTenant(input: {
  db: Kysely<DB>;
  providers: AdminProviders;
  slackBotToken?: string;
  slackInstallationId?: string;
  encryptionKey: Buffer;
  installationId: string;
  repository: { owner: string; repo: string };
  tenantId?: string;
  selectedChannelId?: string;
  replacePairing?: boolean;
}): Promise<ProvisionReport> {
  if ((input.slackBotToken !== undefined) === (input.slackInstallationId !== undefined)) {
    throw new Error("Choose exactly one Slack bot token or pending installation ID");
  }
  const pending = input.slackInstallationId === undefined ? null : await readPendingSlackOAuthInstallation(
    input.db, uuid(input.slackInstallationId, "Slack installation ID"), input.encryptionKey,
  );
  if (input.slackInstallationId !== undefined && !pending) throw new Error("Pending Slack installation is unavailable");
  const token = pending?.token ?? input.slackBotToken;
  if (!token) throw new Error("Slack bot token must not be empty");
  if (input.selectedChannelId !== undefined && !input.selectedChannelId.trim()) {
    throw new Error("Selected channel ID must not be empty");
  }
  positiveDecimal(input.installationId, "GitHub installation ID");
  const [slack, repository] = await Promise.all([
    input.providers.inspectSlackToken(token),
    input.providers.inspectInstallationRepository(
      input.installationId,
      input.repository.owner,
      input.repository.repo,
    ),
  ]).catch((error: unknown) => {
    // Provider failures can quote response bodies or credentials. Pending tokens
    // must remain internal even when validation fails before the transaction.
    if (pending) throw new Error("Pending Slack installation provider validation failed; check provider access and retry");
    throw error;
  });
  if (pending && (slack.teamId !== pending.teamId || slack.botUserId !== pending.botUserId)) {
    throw new Error("Pending Slack installation does not match the live Slack workspace and bot");
  }
  if (input.selectedChannelId !== undefined && !slack.channelIds.includes(input.selectedChannelId)) {
    throw new Error("The Slack bot is not a member of the selected channel");
  }

  // The exact envelope was decrypted and provider-validated above. Both storage
  // locations use the same key and workspace AAD, so transferring it needs no IV.
  const ciphertext = pending?.expectedCiphertext ?? encryptSlackToken({
    token,
    teamId: slack.teamId,
    key: input.encryptionKey,
  });
  return input.db.transaction().execute(async (trx) => {
    await lockTenantProvisioning(trx);
    await ensureSlackTokenKey(trx, input.encryptionKey);
    const existingMatches = await sql<{ tenant_id: string }>`
      select tenant_id::text as tenant_id from slack_workspaces where team_id = ${slack.teamId}
      union
      select tenant_id::text as tenant_id from github_installations
        where installation_id = ${repository.installationId}::bigint
           or github_account_id = ${repository.githubAccountId}::bigint
    `.execute(trx);
    const matchingTenants = unique(existingMatches.rows.map((row) => row.tenant_id));
    if (matchingTenants.length > 1 && !input.replacePairing) {
      throw new Error("Slack and GitHub integrations are paired to different tenants");
    }
    const tenantId = input.tenantId
      ? uuid(input.tenantId, "Tenant ID")
      : matchingTenants.length === 1
        ? matchingTenants[0]
        : crypto.randomUUID();

    // Match channel-selection writers: lock before reading the value to preserve.
    await lockTeamChannelRoute(trx, slack.teamId);
    const { teamRow, tenantWorkspace, installationRow, tenantInstallation, accountRow } =
      await loadPairings({ db: trx, tenantId, slack, repository });
    const conflicts = [
      teamRow && teamRow.tenant_id !== tenantId ? `Slack workspace ${slack.teamId}` : null,
      tenantWorkspace && tenantWorkspace.team_id !== slack.teamId ? `tenant Slack workspace ${tenantWorkspace?.team_id}` : null,
      installationRow && installationRow.tenant_id !== tenantId ? `GitHub installation ${repository.installationId}` : null,
      tenantInstallation &&
      tenantInstallation.installation_id !== repository.installationId &&
      tenantInstallation.github_account_id !== repository.githubAccountId
        ? `tenant GitHub installation ${tenantInstallation.installation_id}`
        : null,
      accountRow && accountRow.tenant_id !== tenantId ? `GitHub account ${repository.githubAccountId}` : null,
    ].filter((value): value is string => value !== null);
    if (conflicts.length > 0 && !input.replacePairing) {
      throw new Error(`Provisioning would re-pair existing integrations: ${conflicts.join(", ")}`);
    }

    const sourceTenantIds = unique(
      [teamRow?.tenant_id, installationRow?.tenant_id, accountRow?.tenant_id]
        .filter((value): value is string => value !== undefined && value !== tenantId),
    );
    if (input.replacePairing) {
      if (tenantWorkspace && tenantWorkspace.team_id !== slack.teamId) {
        await lockTeamChannelRoute(trx, tenantWorkspace.team_id);
        await trx.deleteFrom("channel_settings").where("team_id", "=", tenantWorkspace.team_id).execute();
        await trx.deleteFrom("team_channel_routes").where("team_id", "=", tenantWorkspace.team_id).execute();
      }
      await trx.deleteFrom("slack_workspaces").where((eb) => eb.or([
        eb("team_id", "=", slack.teamId),
        eb("tenant_id", "=", tenantId),
      ])).execute();
      await trx.deleteFrom("github_installations").where((eb) => eb.or([
        eb("installation_id", "=", repository.installationId),
        eb("tenant_id", "=", tenantId),
        eb("github_account_id", "=", repository.githubAccountId),
      ])).execute();
      if (sourceTenantIds.length > 0) {
        await trx.updateTable("tenants").set({ enabled: false }).where("id", "in", sourceTenantIds).execute();
      }
    } else if (tenantInstallation && tenantInstallation.installation_id !== repository.installationId) {
      // Same account/tenant with a new installation is a normal reinstall.
      await trx.deleteFrom("github_installations").where("tenant_id", "=", tenantId).execute();
    }

    await trx
      .insertInto("tenants")
      .values({ id: tenantId, enabled: false })
      .onConflict((oc) => oc.column("id").doUpdateSet({ enabled: false }))
      .execute();
    const legacyRoute = await trx
      .selectFrom("team_channel_routes")
      .select("selected_channel_id")
      .where("team_id", "=", slack.teamId)
      .executeTakeFirst();
    const selectedChannelId =
      input.selectedChannelId ??
      (tenantWorkspace?.team_id === slack.teamId
        ? tenantWorkspace.selected_channel_id
        : undefined) ??
      legacyRoute?.selected_channel_id ??
      null;
    await trx
      .insertInto("slack_workspaces")
      .values({
        team_id: slack.teamId,
        tenant_id: tenantId,
        bot_user_id: slack.botUserId,
        bot_token_ciphertext: ciphertext,
        selected_channel_id: selectedChannelId,
      })
      .onConflict((oc) => oc.column("team_id").doUpdateSet({
        tenant_id: tenantId,
        bot_user_id: slack.botUserId,
        bot_token_ciphertext: ciphertext,
        selected_channel_id: selectedChannelId,
      }))
      .execute();
    if (selectedChannelId !== null) {
      await writeSelectedChannel(trx, slack.teamId, selectedChannelId);
    }
    await trx
      .insertInto("github_installations")
      .values({
        installation_id: repository.installationId,
        tenant_id: tenantId,
        github_account_id: repository.githubAccountId,
      })
      .onConflict((oc) =>
        oc.column("installation_id").doUpdateSet({
          tenant_id: tenantId,
          github_account_id: repository.githubAccountId,
        }),
      )
      .execute();
    await trx.updateTable("tenants").set({ enabled: true }).where("id", "=", tenantId).execute();
    if (pending) {
      await consumeSlackOAuthInstallation(trx, {
        id: pending.id, expectedCiphertext: ciphertext, tenantId,
        githubInstallationId: repository.installationId, encryptionKey: input.encryptionKey,
      });
    }
    return {
      tenantId,
      slackTeamId: slack.teamId,
      githubInstallationId: repository.installationId,
      githubAccountId: repository.githubAccountId,
      repositoryId: repository.repositoryId,
      selectedChannelId,
      replacedPairings: conflicts,
    };
  });
}

export type RollbackPreparationReport = {
  ok: boolean;
  applied: boolean;
  issues: string[];
  cycles: number;
};

export async function prepareRollbackToA(input: {
  db: Kysely<DB>;
  apply: boolean;
  trafficPaused?: boolean;
}): Promise<RollbackPreparationReport> {
  if (input.apply && !input.trafficPaused) {
    throw new Error("Preparing a compatibility rollback requires an explicit traffic-paused acknowledgement");
  }
  const issues: string[] = [];
  const candidates = await integrationTenantCandidates(input.db);
  const [tenantCount, workspaceCount, installationCount, routeCount] = await Promise.all([
    countTable(input.db, "tenants"),
    countTable(input.db, "slack_workspaces"),
    countTable(input.db, "github_installations"),
    countTable(input.db, "team_channel_routes"),
  ]);
  if (tenantCount > 1 || candidates.length > 1) issues.push("the compatibility runtime can represent only one tenant");
  if (workspaceCount > 1) issues.push("the compatibility runtime can represent only one Slack workspace");
  if (installationCount > 1) issues.push("the compatibility runtime can represent only one GitHub installation");
  if (routeCount > 1) issues.push("the compatibility runtime can represent only one legacy Slack channel route");
  const routeMismatch = await sql<{ count: string }>`
    select count(*)::text as count
    from team_channel_routes route
    full join slack_workspaces workspace on workspace.team_id = route.team_id
    where workspace.team_id is null
       or route.selected_channel_id is distinct from workspace.selected_channel_id
  `.execute(input.db);
  if (routeMismatch.rows[0]?.count !== "0") {
    issues.push("legacy and workspace Slack channel routes are not rollback-compatible");
  }

  const cycles = await loadLegacyCycles(input.db);
  const keys = new Map<string, string[]>();
  for (const cycle of cycles) {
    if (cycle.owner === null || cycle.repo === null) {
      issues.push(`review cycle ${cycle.id} lacks rollback-compatible owner/repo values`);
      continue;
    }
    const key = buildLegacyCycleKey({
      owner: cycle.owner,
      repo: cycle.repo,
      prNumber: cycle.pr_number,
      headSha: cycle.head_sha,
    });
    keys.set(key, [...(keys.get(key) ?? []), cycle.id]);
  }
  for (const [key, ids] of keys) {
    if (ids.length > 1) issues.push(`legacy cycle key collision (${ids.join(", ")}): ${key}`);
  }
  if (issues.length > 0 || !input.apply) {
    return { ok: issues.length === 0, applied: false, issues, cycles: cycles.length };
  }

  await input.db.transaction().execute(async (trx) => {
    for (const cycle of cycles) {
      await trx
        .updateTable("review_cycles")
        .set({
          cycle_key: buildLegacyCycleKey({
            owner: cycle.owner!,
            repo: cycle.repo!,
            prNumber: cycle.pr_number,
            headSha: cycle.head_sha,
          }),
        })
        .where("id", "=", cycle.id)
        .execute();
    }
  });
  return { ok: true, applied: true, issues: [], cycles: cycles.length };
}
