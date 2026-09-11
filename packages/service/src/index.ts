#!/usr/bin/env node
import { readEnv } from "./env";
import { buildServer } from "./http";
import { PostgresCycleStore } from "./storage/postgres";

const env = readEnv();
const store = new PostgresCycleStore(env.databaseUrl);
await store.init();
const tokenCheck = await store.inspectSlackTokenEncryption(env.slackTokenEncryptionKey);
if (tokenCheck.keyError) {
  await store.close();
  throw new Error(tokenCheck.keyError);
}
const server = buildServer({ env, store, slackOAuthDb: store.database });
for (const workspace of tokenCheck.invalidWorkspaces) {
  server.log.error(
    { event: "SLACK_TOKEN_DECRYPTION_FAILED", ...workspace },
    "Stored Slack token is unusable; repair this tenant's credentials. Deployment key verified; continuing startup for other tenants.",
  );
}

for (const installation of tokenCheck.invalidPendingInstallations) {
  server.log.error(
    { event: "SLACK_PENDING_TOKEN_DECRYPTION_FAILED", ...installation },
    "Pending Slack token is unusable; cancel this installation and start again.",
  );
}

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
