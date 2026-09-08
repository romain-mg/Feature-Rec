import crypto from "node:crypto";
import {
  GITHUB_ACCEPT_COMMENT,
  GITHUB_CHECK_NAME,
  GITHUB_REJECT_COMMENT,
  renderTemplate,
} from "@feature-rec/core";
import type { ServiceEnv } from "./env";
import { withRetry } from "./retry";
import type { CycleRecord } from "./storage";

type CheckConclusion = "success" | "failure" | "neutral" | "action_required";

type CheckOutput = {
  title: string;
  summary: string;
};

type IssueComment = {
  html_url: string;
};

export type GitHubInstallation = {
  installationId: string;
  githubAccountId: string;
};

export type GitHubRepositoryIdentity = GitHubInstallation & {
  repositoryId: string;
  repositoryOwnerId: string;
  owner: string;
  repo: string;
  fullName: string;
};

export type RepositoryAccess = {
  token: string;
  expiresAt: number;
  repositoryId: string;
  repositoryOwnerId: string;
  owner: string;
  repo: string;
  fullName: string;
};

export type GitHubPullRequest = {
  state: "open" | "closed";
  draft: boolean;
  headSha: string;
  prTitle: string;
  prAuthor: string;
};

export class GitHubAuthorizationError extends Error {
  constructor() { super("Repository access denied"); }
}

function repositoryPath(access: RepositoryAccess): string {
  return `/repos/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.repo)}`;
}

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

function decimalId(value: unknown, label: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`GitHub returned an invalid ${label}`);
  }
  return String(value);
}

function safeIdNumber(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive decimal string`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw new Error(`${label} cannot be represented exactly as a JavaScript number`);
  }
  return parsed;
}

export class GitHubRequestError extends Error {
  constructor(
    readonly status: number | null,
    readonly retryable = status === null || status === 429 || (status >= 500 && status <= 599),
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(status === null
      ? "GitHub network request failed (retryable)"
      : `GitHub API request failed: HTTP ${status} (${retryable ? "retryable; retry after GitHub recovers or its rate limit resets" : "check App permissions, installation and repository access"})`);
    this.name = "GitHubRequestError";
  }
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
    signal: AbortSignal.timeout(5_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }).catch(() => { throw new GitHubRequestError(null); });
  if (!response.ok) {
    let secondaryRateLimited = false;
    if (response.status === 403 || response.status === 429) {
      // Secondary limits may omit Retry-After while primary quota remains.
      // Inspect the category only; provider messages and JSON parse errors can
      // contain credentials and must never escape through an error or its cause.
      const body: unknown = await response.json().catch(() => undefined);
      secondaryRateLimited = !!body && typeof body === "object" && "message" in body &&
        typeof body.message === "string" && /\bsecondary rate limit\b/i.test(body.message);
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    const rateLimited = response.status === 403 && (secondaryRateLimited || response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
    const retryAfter = response.headers.get("retry-after");
    const reset = response.headers.get("x-ratelimit-reset");
    const retrySeconds = retryAfter !== null
      ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1_000)
      : response.headers.get("x-ratelimit-remaining") === "0" && reset !== null ? Number(reset) - Date.now() / 1_000 : NaN;
    throw new GitHubRequestError(response.status, rateLimited || response.status === 429 || response.status >= 500,
      Number.isFinite(retrySeconds) ? Math.max(0, Math.ceil(retrySeconds)) : secondaryRateLimited ? 60 : null);
  }
  try {
    return (await response.json()) as T;
  } catch {
    // JSON parsing errors may quote the response body, including access tokens.
    throw new GitHubRequestError(null);
  }
}

export class GitHubClient {
  #env: ServiceEnv;

  constructor(env: ServiceEnv) {
    this.#env = env;
  }

  async inspectInstallation(installationId: string): Promise<GitHubInstallation> {
    const requestedId = safeIdNumber(installationId, "GitHub installation ID");
    const installation = await githubFetch<{ id: number; account?: { id?: number } }>(
      `/app/installations/${requestedId}`,
      { token: appJwt(this.#env) },
    );
    const returnedId = decimalId(installation.id, "installation ID");
    if (returnedId !== installationId) {
      throw new Error("GitHub returned a different installation ID");
    }
    return {
      installationId: returnedId,
      githubAccountId: decimalId(installation.account?.id, "installation account ID"),
    };
  }

  async resolveRepository(owner: string, repo: string): Promise<GitHubRepositoryIdentity> {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const jwt = appJwt(this.#env);
    const installation = await githubFetch<{ id: number; account?: { id?: number } }>(
      `/repos/${encodedOwner}/${encodedRepo}/installation`,
      { token: jwt },
    );
    const installationId = decimalId(installation.id, "installation ID");
    const githubAccountId = decimalId(installation.account?.id, "installation account ID");
    const access = await githubFetch<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { token: jwt, method: "POST", body: {} },
    );
    const repository = await githubFetch<{
      id: number;
      name: string;
      full_name: string;
      owner?: { id?: number; login?: string };
    }>(`/repos/${encodedOwner}/${encodedRepo}`, { token: access.token });
    const repositoryOwnerId = decimalId(repository.owner?.id, "repository owner ID");
    if (repositoryOwnerId !== githubAccountId) {
      throw new Error("GitHub repository owner does not match the installation account");
    }
    return {
      installationId,
      githubAccountId,
      repositoryId: decimalId(repository.id, "repository ID"),
      repositoryOwnerId,
      owner: repository.owner?.login ?? owner,
      repo: repository.name,
      fullName: repository.full_name,
    };
  }

  async inspectInstallationRepository(
    installationId: string,
    owner: string,
    repo: string,
  ): Promise<GitHubRepositoryIdentity> {
    const installation = await this.inspectInstallation(installationId);
    const repository = await this.resolveRepository(owner, repo);
    if (
      repository.installationId !== installation.installationId ||
      repository.githubAccountId !== installation.githubAccountId
    ) {
      throw new Error("The selected repository does not belong to the requested installation");
    }

    // End-to-end check that the app can mint a token restricted to this exact
    // repository. The token remains opaque and is never returned or logged.
    await githubFetch<{ token: string }>(
      `/app/installations/${installation.installationId}/access_tokens`,
      {
        token: appJwt(this.#env),
        method: "POST",
        body: {
          repository_ids: [safeIdNumber(repository.repositoryId, "GitHub repository ID")],
        },
      },
    );
    return repository;
  }

  // Mint scoped access for each logical operation so both permission checks and
  // repository coordinates come from the current installation grant.
  async authorizeRepository(installationId: string, repositoryId: string): Promise<RepositoryAccess> {
    let id: number;
    try {
      id = safeIdNumber(repositoryId, "GitHub repository ID");
      safeIdNumber(installationId, "GitHub installation ID");
    } catch {
      throw new GitHubAuthorizationError();
    }
    const access = await githubFetch<{
      token: string;
      expires_at: unknown;
      repositories?: Array<{ id: number; full_name: string; owner?: { id?: number } }>;
    }>(`/app/installations/${installationId}/access_tokens`, {
      token: appJwt(this.#env),
      method: "POST",
      body: { repository_ids: [id] },
    }).catch((error: unknown) => {
      // These statuses at the grant endpoint mean this installation cannot
      // grant the requested repository. A 401 is an App credential problem;
      // failures from later PR/check calls retain their provider context.
      if (error instanceof GitHubRequestError && !error.retryable && [403, 404, 422].includes(error.status ?? 0)) {
        throw new GitHubAuthorizationError();
      }
      throw error;
    });
    if (!access || typeof access !== "object") throw new GitHubRequestError(null);
    const expiresAt = typeof access.expires_at === "string" ? Date.parse(access.expires_at) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new GitHubRequestError(null);
    const repository = access.repositories?.[0];
    if (
      access.repositories?.length !== 1 || !repository ||
      typeof access.token !== "string" || !access.token ||
      repository.id !== id || !Number.isSafeInteger(repository.id) ||
      typeof repository.full_name !== "string" ||
      !/^[^/\s?#]+\/[^/\s?#]+$/.test(repository.full_name)
    ) throw new GitHubAuthorizationError();
    let repositoryOwnerId: string;
    try {
      repositoryOwnerId = decimalId(repository.owner?.id, "repository owner ID");
    } catch {
      throw new GitHubAuthorizationError();
    }
    const [owner, repo] = repository.full_name.split("/");
    return { token: access.token, expiresAt, repositoryId, repositoryOwnerId, owner, repo, fullName: repository.full_name };
  }

  async getPullRequest(access: RepositoryAccess, prNumber: number): Promise<GitHubPullRequest> {
    const pr = await githubFetch<{
      number: number; state: string; draft: boolean; title: string;
      head: { sha: string }; user: { login: string };
    }>(`${repositoryPath(access)}/pulls/${prNumber}`, { token: access.token });
    if (
      pr.number !== prNumber || !["open", "closed"].includes(pr.state) ||
      typeof pr.draft !== "boolean" || typeof pr.title !== "string" ||
      typeof pr.head?.sha !== "string" || typeof pr.user?.login !== "string"
    ) throw new GitHubRequestError(null);
    return { state: pr.state as "open" | "closed", draft: pr.draft, headSha: pr.head.sha, prTitle: pr.title, prAuthor: pr.user.login };
  }

  async createCheckRun(input: { headSha: string; cycleKey: string }, access: RepositoryAccess): Promise<number> {
    const check = await githubFetch<{ id: number }>(
      `${repositoryPath(access)}/check-runs`,
      {
        token: access.token,
        method: "POST",
        body: {
          name: GITHUB_CHECK_NAME,
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
    cycle: Pick<CycleRecord, "checkRunId">,
    input: {
      status?: "in_progress" | "completed";
      conclusion?: CheckConclusion;
      output: CheckOutput;
    },
    access: RepositoryAccess,
  ): Promise<void> {
    if (!cycle.checkRunId) return;
    await githubFetch(`${repositoryPath(access)}/check-runs/${cycle.checkRunId}`, {
      token: access.token,
      method: "PATCH",
      body: {
        status: input.status ?? (input.conclusion ? "completed" : "in_progress"),
        conclusion: input.conclusion,
        completed_at: input.conclusion ? new Date().toISOString() : undefined,
        output: input.output,
      },
    });
  }

  async comment(cycle: CycleRecord, body: string, access: RepositoryAccess): Promise<string> {
    const comment = await githubFetch<IssueComment>(
      `${repositoryPath(access)}/issues/${cycle.prNumber}/comments`,
      {
        token: access.token,
        method: "POST",
        body: { body },
      },
    );
    return comment.html_url;
  }

  // Retry policy: the comment POST is single-shot (retrying after a post-write
  // timeout would duplicate PR comments — not idempotent); the check-run PATCH
  // is idempotent and retried. Callers must NOT wrap these methods in withRetry.
  async accept(cycle: CycleRecord, access: RepositoryAccess): Promise<void> {
    const commentUrl = await this.comment(
      cycle,
      renderTemplate(GITHUB_ACCEPT_COMMENT, {
        pr_author: cycle.prAuthor,
      }).trim(),
      access,
    );
    await withRetry(() =>
      this.updateCheckRun(cycle, {
        conclusion: "success",
        output: {
          title: "Feature-Rec: accepted",
          summary: `Validation passed. See PR conversation: ${commentUrl}`,
        },
      }, access),
    );
  }

  async reject(cycle: CycleRecord, reviewComment: string, access: RepositoryAccess): Promise<void> {
    const commentUrl = await this.comment(
      cycle,
      renderTemplate(GITHUB_REJECT_COMMENT, {
        review_comment: reviewComment,
        pr_author: cycle.prAuthor,
      }).trim(),
      access,
    );
    await withRetry(() =>
      this.updateCheckRun(cycle, {
        conclusion: "action_required",
        output: {
          title: "Feature-Rec: rejected",
          summary: `Validation requested changes. See PR conversation: ${commentUrl}`,
        },
      }, access),
    );
  }
}
