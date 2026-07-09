export type ServiceEnv = {
  port: number;
  baseUrl: string;
  databaseUrl: string;
  runnerToken: string;
  githubToken: string;
  githubAppId: string;
  githubPrivateKey: string;
  slackBotToken: string;
  slackSigningSecret: string;
};

export function readEnv(env = process.env): ServiceEnv {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return {
    port: Number(env.PORT) || 3000,
    baseUrl: env.FEATURE_REC_BASE_URL ?? `http://localhost:${Number(env.PORT) || 3000}`,
    databaseUrl,
    runnerToken: env.FEATURE_REC_RUNNER_TOKEN ?? "",
    githubToken: env.FEATURE_REC_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? "",
    githubAppId: env.GITHUB_APP_ID ?? "",
    githubPrivateKey: (env.GITHUB_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    slackBotToken: env.SLACK_BOT_TOKEN ?? "",
    slackSigningSecret: env.SLACK_SIGNING_SECRET ?? "",
  };
}
