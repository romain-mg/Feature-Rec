import type { Migration, MigrationProvider } from "kysely/migration";
import * as initial from "./0001_initial";

// Static import map (not FileMigrationProvider) so migrations resolve under
// tsx and any future bundling without filesystem lookups.
const migrations: Record<string, Migration> = {
  "0001_initial": initial,
};

export const migrationProvider: MigrationProvider = {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations);
  },
};
