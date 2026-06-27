import crypto from "node:crypto";
import type { RunStartRequest } from "@feature-rec/core";
import { renderTemplate } from "@feature-rec/core";
import type { ServiceEnv } from "./env";
import type { CycleRecord } from "./storage";

type CheckConclusion = "success" | "failure" | "neutral" | "action_required";

type CheckOutput = {
  title: string;
  summary: string;
};

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function appJwt(env: ServiceEnv): string {
  if (!env.githubAppId || !env.githubPrivateKey) {
    throw new Error("GitHub App credentials are missing. Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY.");
  }
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: env.githubAppId,
    }),
  );
  const data = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(data).sign(env.githubPrivateKey);
  return `${data}.${b64url(signature)}`;
}

async function githubFetch<T>(
  path: string,
  opts: {
    token: string;
    method?: string;
    body?: unknown;
  },
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${opts.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  }
  return (await response.json()) as T;
}

export class GitHubClient {
  #env: ServiceEnv;
  #installationTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(env: ServiceEnv) {
    this.#env = env;
  }

  async tokenForRepo(owner: string, repo: string): Promise<string> {
    if (this.#env.githubToken) return this.#env.githubToken;
    const cacheKey = `${owner}/${repo}`;
    const cached = this.#installationTokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const jwt = appJwt(this.#env);
    const installation = await githubFetch<{ id: number }>(`/repos/${owner}/${repo}/installation`, {
      token: jwt,
    });
    const access = await githubFetch<{ token: string; expires_at: string }>(
      `/app/installations/${installation.id}/access_tokens`,
      { token: jwt, method: "POST", body: {} },
    );
    this.#installationTokens.set(cacheKey, {
      token: access.token,
      expiresAt: new Date(access.expires_at).getTime(),
    });
    return access.token;
  }

  async createCheckRun(input: RunStartRequest & { cycleKey: string }): Promise<number> {
    const token = await this.tokenForRepo(input.owner, input.repo);
    const check = await githubFetch<{ id: number }>(
      `/repos/${input.owner}/${input.repo}/check-runs`,
      {
        token,
        method: "POST",
        body: {
          name: input.checkName,
          head_sha: input.headSha,
          status: "in_progress",
          external_id: input.cycleKey,
          output: {
            title: "Feature-Rec: analyzing",
            summary: "Feature-Rec is checking whether this PR needs Slack validation.",
          },
        },
      },
    );
    return check.id;
  }

  async updateCheckRun(
    cycle: Pick<CycleRecord, "owner" | "repo" | "checkRunId">,
    input: {
      status?: "in_progress" | "completed";
      conclusion?: CheckConclusion;
      output: CheckOutput;
    },
  ): Promise<void> {
    if (!cycle.checkRunId) return;
    const token = await this.tokenForRepo(cycle.owner, cycle.repo);
    await githubFetch(`/repos/${cycle.owner}/${cycle.repo}/check-runs/${cycle.checkRunId}`, {
      token,
      method: "PATCH",
      body: {
        status: input.status ?? (input.conclusion ? "completed" : "in_progress"),
        conclusion: input.conclusion,
        completed_at: input.conclusion ? new Date().toISOString() : undefined,
        output: input.output,
      },
    });
  }

  async comment(cycle: CycleRecord, body: string): Promise<void> {
    const token = await this.tokenForRepo(cycle.owner, cycle.repo);
    await githubFetch(`/repos/${cycle.owner}/${cycle.repo}/issues/${cycle.prNumber}/comments`, {
      token,
      method: "POST",
      body: { body },
    });
  }

  async accept(cycle: CycleRecord, template: string): Promise<void> {
    await this.updateCheckRun(cycle, {
      conclusion: "success",
      output: {
        title: "Feature-Rec: accepted",
        summary: "Validation passed.",
      },
    });
    await this.comment(
      cycle,
      renderTemplate(template, {
        pr_author: cycle.prAuthor,
      }).trim(),
    );
  }

  async reject(cycle: CycleRecord, template: string, reviewComment: string): Promise<void> {
    await this.updateCheckRun(cycle, {
      conclusion: "action_required",
      output: {
        title: "Feature-Rec: rejected",
        summary: `Validation requested changes.\n\n${reviewComment}`,
      },
    });
    await this.comment(
      cycle,
      renderTemplate(template, {
        review_comment: reviewComment,
        pr_author: cycle.prAuthor,
      }).trim(),
    );
  }
}
