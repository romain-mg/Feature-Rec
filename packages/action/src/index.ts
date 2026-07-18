#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { configHash, isAllowedPullRequestEvent, loadFeatureRecConfig } from "@feature-rec/core";
import { renderFeatureRecVideo } from "@autodemo/cli/feature-rec";
import { acceptCycle, failCycle, startCycle, uploadVideo } from "./backend";
import { classifyFrontendVisible } from "./classifier";
import { collectDiffContext } from "./diff";

type PullRequestEvent = {
  action?: string;
  repository: {
    name: string;
    owner: { login: string };
  };
  pull_request: {
    number: number;
    state: string;
    draft: boolean;
    title: string;
    user: { login: string };
    base: { sha: string };
    head: { sha: string };
  };
};

function arg(name: string, fallback = ""): string {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(arg("--repo", process.cwd()));
  const configPath = path.resolve(arg("--config", path.join(repoRoot, ".github/feature-rec-config.yaml")));
  const eventPath = path.resolve(arg("--event", process.env.GITHUB_EVENT_PATH ?? ""));
  const apiUrl = arg("--api-url", process.env.FEATURE_REC_API_URL ?? "").replace(/\/$/, "");
  if (!apiUrl) throw new Error("Missing Feature-Rec api-url.");
  if (!eventPath || !fs.existsSync(eventPath)) throw new Error("Missing GITHUB_EVENT_PATH.");

  const config = loadFeatureRecConfig(configPath);
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8")) as PullRequestEvent;
  if (!isAllowedPullRequestEvent(event)) {
    console.log("Feature-Rec skipped: PR event is not an open ready review event.");
    return;
  }

  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const pr = event.pull_request;
  const cfgHash = configHash(config);
  const started = await startCycle(apiUrl, {
    owner,
    repo,
    prNumber: pr.number,
    prTitle: pr.title,
    prAuthor: pr.user.login,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    configHash: cfgHash,
    config,
  });

  // Same-head duplicate: another runner already owns this cycle. Exit cleanly
  // before any work so no duplicate check runs, video uploads, or Slack posts.
  if (started.duplicate) {
    console.log(`Feature-Rec: duplicate start for ${started.cycleKey}; another run owns this cycle. Exiting.`);
    return;
  }
  // A non-duplicate start always returns an attempt token; its absence is a
  // backend contract violation, so fail loud rather than send token-less calls.
  const attemptId = started.attemptId;
  if (!attemptId) {
    throw new Error("Feature-Rec: backend returned no attemptId for a new cycle.");
  }

  try {
    const diff = collectDiffContext({
      repoRoot,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      prTitle: pr.title,
      prNumber: pr.number,
    });
    const classifier = await classifyFrontendVisible({
      files: diff.files,
      patch: diff.patch,
      prTitle: pr.title,
    });
    console.log(`Feature-Rec classifier: ${JSON.stringify(classifier, null, 2)}`);

    if (!classifier.frontendVisible) {
      await acceptCycle(apiUrl, started.cycleId, classifier, attemptId);
      return;
    }

    const selectedSources = diff.frontendSources.filter((source) =>
      classifier.files.length === 0 ? true : classifier.files.includes(source.file),
    );
    const sources = selectedSources.length > 0 ? selectedSources : diff.frontendSources;
    if (sources.length === 0) {
      throw new Error(
        "Classifier found a frontend-visible change, but Feature-Rec could not extract reproducible TSX/JSX source.",
      );
    }

    const video = await renderFeatureRecVideo({
      repoRoot,
      sources,
      offline: process.env.FEATURE_REC_OFFLINE === "1",
    });
    await uploadVideo(apiUrl, started.cycleId, video, attemptId);
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    await failCycle(apiUrl, started.cycleId, message, attemptId);
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
