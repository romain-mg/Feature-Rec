import crypto from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { Selectable } from "kysely";
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import { z } from "zod";
import type { ReviewCycleStatus, RunStartRequest } from "@feature-rec/core";
import type {
  BotChannel,
  ChannelSettings,
  CycleRecord,
  CycleStore,
  StartCycleResult,
} from "../storage";
import type { DB, ReviewCyclesTable } from "./schema";
import { migrationProvider } from "./migrations";

const ApproverIdsSchema = z.array(z.string());

function now(): string {
  return new Date().toISOString();
}

function rowToCycle(row: Selectable<ReviewCyclesTable>): CycleRecord {
  return {
    id: row.id,
    cycleKey: row.cycle_key,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    status: row.status,
    // int8 comes back as a string from `pg`; GitHub IDs stay well below 2^53.
    checkRunId: row.check_run_id === null ? null : Number(row.check_run_id),
    slackChannelId: row.slack_channel_id,
    slackMessageTs: row.slack_message_ts,
    prAuthor: row.pr_author,
    prTitle: row.pr_title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresCycleStore implements CycleStore {
  #db: Kysely<DB>;

  constructor(connectionString: string) {
    this.#db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
    });
  }

  async init(): Promise<void> {
    const migrator = new Migrator({ db: this.#db, provider: migrationProvider });
    const { error } = await migrator.migrateToLatest();
    if (error) {
      throw error instanceof Error ? error : new Error(`Migration failed: ${String(error)}`);
    }
  }

  async startCycle(input: RunStartRequest & { cycleKey: string }): Promise<StartCycleResult> {
    const lockKey = `${input.owner}/${input.repo}#${input.prNumber}`;
    return this.#db.transaction().execute(async (trx) => {
      // Per-PR serialization: 64-bit advisory lock held until commit. Bound
      // value (not string-concatenated SQL); hashtextextended keeps 64 bits.
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);

      const id = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      const t = now();

      const insertedRow = await trx
        .insertInto("review_cycles")
        .values({
          id,
          cycle_key: input.cycleKey,
          owner: input.owner,
          repo: input.repo,
          pr_number: input.prNumber,
          pr_author: input.prAuthor,
          pr_title: input.prTitle,
          head_sha: input.headSha,
          status: "analyzing",
          attempt_id: attemptId,
          created_at: t,
          updated_at: t,
        })
        .onConflict((oc) => oc.column("cycle_key").doNothing())
        .returningAll()
        .executeTakeFirst();

      // Conflict on cycle_key: a cycle already exists for this exact head.
      if (!insertedRow) {
        const existing = await trx
          .selectFrom("review_cycles")
          .selectAll()
          .where("cycle_key", "=", input.cycleKey)
          .executeTakeFirstOrThrow();

        // Takeover from `failed`: failed is terminal, so there is provably no
        // live owner to race (any zombie twitch is fenced by its stale token).
        // Re-issue ownership in this same locked transaction — mint a fresh
        // attempt token (reusing the one minted above, which never persisted)
        // and reset to `analyzing` — rather than exiting as a duplicate. Run no
        // supersession: this re-runs the same head and must not displace a
        // newer active head. The handler reuses the existing check_run_id.
        if (existing.status === "failed") {
          const revived = await trx
            .updateTable("review_cycles")
            .set({ status: "analyzing", attempt_id: attemptId, updated_at: now() })
            .where("id", "=", existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          return { cycle: rowToCycle(revived), superseded: [], created: true, attemptId };
        }

        // Any other status is a clean no-op exit — a stale start must never
        // displace the currently active cycle.
        return { cycle: rowToCycle(existing), superseded: [], created: false, attemptId: null };
      }

      const supersededRows = await trx
        .updateTable("review_cycles")
        .set({ status: "superseded", updated_at: now() })
        .where("owner", "=", input.owner)
        .where("repo", "=", input.repo)
        .where("pr_number", "=", input.prNumber)
        .where("head_sha", "!=", input.headSha)
        .where("status", "in", ["analyzing", "pending_validation"])
        .returningAll()
        .execute();

      return {
        cycle: rowToCycle(insertedRow),
        superseded: supersededRows.map(rowToCycle),
        created: true,
        attemptId,
      };
    });
  }

  async getCycle(id: string): Promise<CycleRecord | null> {
    const row = await this.#db
      .selectFrom("review_cycles")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToCycle(row) : null;
  }

  async getCycleByKey(cycleKey: string): Promise<CycleRecord | null> {
    const row = await this.#db
      .selectFrom("review_cycles")
      .selectAll()
      .where("cycle_key", "=", cycleKey)
      .executeTakeFirst();
    return row ? rowToCycle(row) : null;
  }

  async attachCheckRun(cycleId: string, checkRunId: number): Promise<ReviewCycleStatus> {
    const row = await this.#db
      .updateTable("review_cycles")
      .set({ check_run_id: checkRunId, updated_at: now() })
      .where("id", "=", cycleId)
      .returning("status")
      .executeTakeFirstOrThrow();
    return row.status;
  }

  // Runner transitions carry an ownership token; Slack transitions don't. Both
  // funnel through one guarded UPDATE so the SQL lives in a single place.
  async #transitionStatus(input: {
    cycleId: string;
    attemptId?: string;
    from: ReviewCycleStatus[];
    to: ReviewCycleStatus;
  }): Promise<CycleRecord | null> {
    let query = this.#db
      .updateTable("review_cycles")
      .set({ status: input.to, updated_at: now() })
      .where("id", "=", input.cycleId)
      .where("status", "in", input.from);
    if (input.attemptId !== undefined) {
      query = query.where("attempt_id", "=", input.attemptId);
    }
    const row = await query.returningAll().executeTakeFirst();
    return row ? rowToCycle(row) : null;
  }

  transitionRunnerStatus(input: {
    cycleId: string;
    attemptId: string;
    from: ReviewCycleStatus[];
    to: ReviewCycleStatus;
  }): Promise<CycleRecord | null> {
    return this.#transitionStatus(input);
  }

  transitionSlackStatus(input: {
    cycleId: string;
    from: ReviewCycleStatus[];
    to: ReviewCycleStatus;
  }): Promise<CycleRecord | null> {
    return this.#transitionStatus(input);
  }

  async attachSlackMessage(
    cycleId: string,
    channelId: string,
    messageTs: string,
  ): Promise<ReviewCycleStatus> {
    // Write channel/ts only while still pending_validation; return current status.
    const written = await this.#db
      .updateTable("review_cycles")
      .set({ slack_channel_id: channelId, slack_message_ts: messageTs, updated_at: now() })
      .where("id", "=", cycleId)
      .where("status", "=", "pending_validation")
      .returning("status")
      .executeTakeFirst();
    if (written) return written.status;

    const current = await this.#db
      .selectFrom("review_cycles")
      .select("status")
      .where("id", "=", cycleId)
      .executeTakeFirstOrThrow();
    return current.status;
  }

  async recordProcessedInteraction(id: string, cycleId: string): Promise<boolean> {
    const result = await this.#db
      .insertInto("processed_interactions")
      .values({ id, cycle_id: cycleId, created_at: now() })
      .onConflict((oc) => oc.column("id").doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  async syncBotChannels(input: {
    teamId: string;
    channelIds: string[];
    // When the membership snapshot was taken (before the Slack API call), so a
    // join event that lands mid-poll is not reaped by the poll's stale list.
    seenAt: string;
  }): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      if (input.channelIds.length > 0) {
        await trx
          .insertInto("bot_channels")
          .values(
            input.channelIds.map((channelId) => ({
              team_id: input.teamId,
              channel_id: channelId,
              first_seen_at: input.seenAt,
              last_seen_at: input.seenAt,
            })),
          )
          .onConflict((oc) =>
            oc.columns(["team_id", "channel_id"]).doUpdateSet({
              last_seen_at: (eb) => eb.ref("excluded.last_seen_at"),
              // Rejoin after a leave is a new introduction: reset ordering so
              // the channel cannot steal the active slot. A leave recorded at
              // or after the poll snapshot (excluded.last_seen_at = seenAt) is
              // NEWER than this poll's stale membership list and must survive
              // it — routing must never resurrect a channel the bot just left.
              joined_at: sql`case
                when bot_channels.left_at is null then bot_channels.joined_at
                when bot_channels.left_at >= excluded.last_seen_at then bot_channels.joined_at
                else null end`,
              first_seen_at: sql`case
                when bot_channels.left_at is null then bot_channels.first_seen_at
                when bot_channels.left_at >= excluded.last_seen_at then bot_channels.first_seen_at
                else excluded.first_seen_at end`,
              left_at: sql`case
                when bot_channels.left_at is not null and bot_channels.left_at >= excluded.last_seen_at then bot_channels.left_at
                else null end`,
            }),
          )
          .execute();
      }

      let missing = trx
        .updateTable("bot_channels")
        .set({ left_at: input.seenAt })
        .where("team_id", "=", input.teamId)
        .where("left_at", "is", null)
        .where("last_seen_at", "<", new Date(input.seenAt));
      if (input.channelIds.length > 0) {
        missing = missing.where("channel_id", "not in", input.channelIds);
      }
      await missing.execute();
    });
  }

  async activeBotChannels(teamId: string): Promise<BotChannel[]> {
    const rows = await this.#db
      .selectFrom("bot_channels")
      .selectAll()
      .where("team_id", "=", teamId)
      .where("left_at", "is", null)
      .orderBy(sql`coalesce(joined_at, first_seen_at)`)
      .orderBy("channel_id")
      .execute();
    return rows.map((row) => ({
      teamId: row.team_id,
      channelId: row.channel_id,
      joinedAt: row.joined_at === null ? null : row.joined_at.toISOString(),
      firstSeenAt: row.first_seen_at.toISOString(),
    }));
  }

  async recordChannelJoin(input: {
    teamId: string;
    channelId: string;
    joinedAt: string;
  }): Promise<void> {
    await this.#db
      .insertInto("bot_channels")
      .values({
        team_id: input.teamId,
        channel_id: input.channelId,
        joined_at: input.joinedAt,
        first_seen_at: input.joinedAt,
        last_seen_at: input.joinedAt,
      })
      .onConflict((oc) =>
        oc.columns(["team_id", "channel_id"]).doUpdateSet({
          last_seen_at: (eb) => eb.ref("excluded.last_seen_at"),
          // Rejoin restarts ordering at the event time; an active channel keeps
          // its known ordering (retried deliveries and poll-seeded rows only
          // fill a missing joined_at, never move an established one). A join
          // event OLDER than the recorded leave (out-of-order or delayed retry
          // delivery) must not resurrect the channel.
          joined_at: sql`case
            when bot_channels.left_at is null then coalesce(bot_channels.joined_at, excluded.joined_at)
            when bot_channels.left_at >= excluded.joined_at then bot_channels.joined_at
            else excluded.joined_at end`,
          first_seen_at: sql`case
            when bot_channels.left_at is null then bot_channels.first_seen_at
            when bot_channels.left_at >= excluded.joined_at then bot_channels.first_seen_at
            else excluded.first_seen_at end`,
          left_at: sql`case
            when bot_channels.left_at is not null and bot_channels.left_at >= excluded.joined_at then bot_channels.left_at
            else null end`,
        }),
      )
      .execute();
  }

  async recordChannelLeave(input: {
    teamId: string;
    channelId: string;
    leftAt: string;
  }): Promise<boolean> {
    const result = await this.#db
      .updateTable("bot_channels")
      .set({ left_at: input.leftAt })
      .where("team_id", "=", input.teamId)
      .where("channel_id", "=", input.channelId)
      .where("left_at", "is", null)
      // A leave older than the latest observed membership is a delayed retry
      // (Delayed Events redeliver for up to 24h) arriving after a rejoin or a
      // newer poll: it must not deactivate the current membership. Skipping is
      // safe — if the bot really is gone, the next poll reaps the row.
      .where("last_seen_at", "<=", new Date(input.leftAt))
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  async getChannelSettings(teamId: string, channelId: string): Promise<ChannelSettings | null> {
    const row = await this.#db
      .selectFrom("channel_settings")
      .selectAll()
      .where("team_id", "=", teamId)
      .where("channel_id", "=", channelId)
      .executeTakeFirst();
    if (!row) return null;
    let approvers: string[] | null = null;
    if (row.approvers !== null) {
      try {
        approvers = ApproverIdsSchema.parse(JSON.parse(row.approvers));
      } catch (err) {
        throw new Error(
          `channel_settings.approvers for ${teamId}/${channelId} is not a JSON string array: ${String(err)}`,
        );
      }
    }
    return { mention: row.mention, approvers };
  }

  async #upsertChannelSettings(input: {
    teamId: string;
    channelId: string;
    updatedBy: string;
    set: { mention?: string; approvers?: string | null };
  }): Promise<void> {
    const t = now();
    await this.#db
      .insertInto("channel_settings")
      .values({
        team_id: input.teamId,
        channel_id: input.channelId,
        mention: input.set.mention ?? null,
        approvers: input.set.approvers ?? null,
        updated_by: input.updatedBy,
        updated_at: t,
      })
      .onConflict((oc) =>
        oc.columns(["team_id", "channel_id"]).doUpdateSet({
          ...(input.set.mention === undefined ? {} : { mention: input.set.mention }),
          ...(input.set.approvers === undefined ? {} : { approvers: input.set.approvers }),
          updated_by: input.updatedBy,
          updated_at: t,
        }),
      )
      .execute();
  }

  async setMention(input: {
    teamId: string;
    channelId: string;
    mention: string;
    updatedBy: string;
  }): Promise<void> {
    await this.#upsertChannelSettings({
      teamId: input.teamId,
      channelId: input.channelId,
      updatedBy: input.updatedBy,
      set: { mention: input.mention },
    });
  }

  async setApprovers(input: {
    teamId: string;
    channelId: string;
    approvers: string[] | null;
    updatedBy: string;
  }): Promise<void> {
    // An empty list means "everyone", same as null — store the canonical form.
    const approvers = input.approvers?.length ? JSON.stringify(input.approvers) : null;
    await this.#upsertChannelSettings({
      teamId: input.teamId,
      channelId: input.channelId,
      updatedBy: input.updatedBy,
      set: { approvers },
    });
  }

  async close(): Promise<void> {
    await this.#db.destroy();
  }
}
