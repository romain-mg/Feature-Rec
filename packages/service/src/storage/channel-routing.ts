import type { Kysely, Transaction } from "kysely";
import type { DB } from "./schema";
import { SlackWorkspaceUnavailableError } from "../storage";

export async function readSelectedChannel(db: Kysely<DB>, teamId: string): Promise<string | null> {
  const workspace = await db.selectFrom("slack_workspaces")
    .select("selected_channel_id").where("team_id", "=", teamId).executeTakeFirst();
  return workspace?.selected_channel_id ?? null;
}

// Caller must hold lockTeamChannelRoute so readers/settings writers observe the same selection.
export async function writeSelectedChannel(trx: Transaction<DB>, teamId: string, channelId: string): Promise<void> {
  const workspace = await trx.updateTable("slack_workspaces").set({ selected_channel_id: channelId })
    .where("team_id", "=", teamId).returning("team_id").executeTakeFirst();
  if (!workspace) throw new SlackWorkspaceUnavailableError();
  // Deploy B keeps the legacy write so a qualified A rollback preserves routing.
  await trx.insertInto("team_channel_routes")
    .values({ team_id: teamId, selected_channel_id: channelId })
    .onConflict((oc) => oc.column("team_id").doUpdateSet({ selected_channel_id: channelId }))
    .execute();
}
