import type { Migration, MigrationProvider } from "kysely/migration";
import * as initial from "./0001_initial";
import * as channelRouting from "./0002_channel_routing";
import * as nullableLegacyConfig from "./0003_nullable_legacy_config";
import * as lastLeftAt from "./0004_last_left_at";
import * as explicitChannelRouting from "./0005_explicit_channel_routing";
import * as dropLegacyBotChannels from "./0006_drop_legacy_bot_channels";
import * as mentionModes from "./0007_mention_modes";
import * as multitenantExpand from "./0008_multitenant_expand";
import * as multitenantEnforce from "./0009_multitenant_enforce";

// Static import map (not FileMigrationProvider) so migrations resolve under
// tsx and any future bundling without filesystem lookups.
const migrations: Record<string, Migration> = {
  "0001_initial": initial,
  "0002_channel_routing": channelRouting,
  "0003_nullable_legacy_config": nullableLegacyConfig,
  "0004_last_left_at": lastLeftAt,
  "0005_explicit_channel_routing": explicitChannelRouting,
  "0006_drop_legacy_bot_channels": dropLegacyBotChannels,
  "0007_mention_modes": mentionModes,
  "0008_multitenant_expand": multitenantExpand,
  "0009_multitenant_enforce": multitenantEnforce,
};

export const migrationProvider: MigrationProvider = {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations);
  },
};
