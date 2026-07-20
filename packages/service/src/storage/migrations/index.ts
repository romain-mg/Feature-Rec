import type { Migration, MigrationProvider } from "kysely/migration";
import * as initial from "./0001_initial";
import * as channelRouting from "./0002_channel_routing";
import * as nullableLegacyConfig from "./0003_nullable_legacy_config";

// Static import map (not FileMigrationProvider) so migrations resolve under
// tsx and any future bundling without filesystem lookups.
const migrations: Record<string, Migration> = {
  "0001_initial": initial,
  "0002_channel_routing": channelRouting,
  "0003_nullable_legacy_config": nullableLegacyConfig,
};

export const migrationProvider: MigrationProvider = {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations);
  },
};
