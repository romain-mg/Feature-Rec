#!/usr/bin/env node
import { readEnv } from "./env";
import { buildServer } from "./http";
import { PostgresCycleStore } from "./storage/postgres";

const env = readEnv();
const store = new PostgresCycleStore(env.databaseUrl);
await store.init();
const server = buildServer({ env, store });

const close = async () => {
  await server.close();
  await store.close();
};

process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

await server.listen({ port: env.port, host: "0.0.0.0" });
