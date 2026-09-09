import crypto from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import { buildCycleKey } from "@feature-rec/core";
import type { GitHubRepositoryIdentity } from "./github";
import { encryptSlackToken } from "./slack-token-crypto";
import type { DB } from "./storage/schema";
import { lockTeamChannelRoute, lockTenantProvisioning } from "./storage/locks";
import { ensureSlackTokenKey, inspectSlackTokenEncryption } from "./storage/slack-token-check";

type Database = Kysely<DB> | Transaction<DB>;

export type SlackInstallationInspection = {
  teamId: string;
  botUserId: string;
  channelIds: string[];
};

export type AdminProviders = {
  inspectSlackToken(token: string): Promise<SlackInstallationInspection>;
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

async function countTable(db: Database, table: keyof DB): Promise<number> {
  const result = await sql<{ count: string }>`select count(*)::text as count from ${sql.table(table)}`.execute(db);
  return Number(result.rows[0]?.count ?? "0");
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
    const key = buildCycleKey({ tenantId: collision.tenant_id, repositoryId: collision.repository_id, prNumber: collision.pr_number, headSha: collision.head_sha });
    issues.push(`future cycle key collision (${collision.count} rows): ${key}`);
  }

  if (input.requireFutureCycleKeys) {
    // Raw SQL keeps honest nullability: the validator may run against a
    // database that has not applied 0009 yet.
    const cycles = await sql<{
      id: string;
      tenant_id: string | null;
      repository_id: string | null;
      pr_number: number;
      head_sha: string;
      cycle_key: string;
    }>`
      select
        id, tenant_id::text as tenant_id, repository_id::text as repository_id,
        pr_number, head_sha, cycle_key
      from review_cycles
      order by id
    `.execute(input.db);
    for (const cycle of cycles.rows) {
      if (cycle.tenant_id === null || cycle.repository_id === null) continue;
      const expected = buildCycleKey({
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

  const tokenCheck = await inspectSlackTokenEncryption(input.db, input.encryptionKey);
  if (tokenCheck.keyError) issues.push(tokenCheck.keyError);
  for (const workspace of tokenCheck.invalidWorkspaces) {
    issues.push(`Slack token ciphertext for ${workspace.teamId} cannot be decrypted with team-bound AAD`);
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
  slackBotToken: string;
  encryptionKey: Buffer;
  installationId: string;
  repository: { owner: string; repo: string };
  tenantId?: string;
  selectedChannelId?: string;
  replacePairing?: boolean;
}): Promise<ProvisionReport> {
  if (!input.slackBotToken) throw new Error("Slack bot token must not be empty");
  if (input.selectedChannelId !== undefined && !input.selectedChannelId.trim()) {
    throw new Error("Selected channel ID must not be empty");
  }
  positiveDecimal(input.installationId, "GitHub installation ID");
  const [slack, repository] = await Promise.all([
    input.providers.inspectSlackToken(input.slackBotToken),
    input.providers.inspectInstallationRepository(
      input.installationId,
      input.repository.owner,
      input.repository.repo,
    ),
  ]);
  if (input.selectedChannelId !== undefined && !slack.channelIds.includes(input.selectedChannelId)) {
    throw new Error("The Slack bot is not a member of the selected channel");
  }

  const ciphertext = encryptSlackToken({
    token: input.slackBotToken,
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
      }
      // Delete only the tenant's other-team workspace. The same-team row is
      // re-paired in place by the upsert below; deleting it would fire the
      // 0009 cascade and wipe the retained team's channel settings.
      await trx.deleteFrom("slack_workspaces")
        .where("tenant_id", "=", tenantId)
        .where("team_id", "!=", slack.teamId)
        .execute();
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
    const selectedChannelId =
      input.selectedChannelId ??
      (tenantWorkspace?.team_id === slack.teamId
        ? tenantWorkspace.selected_channel_id
        : null) ??
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
