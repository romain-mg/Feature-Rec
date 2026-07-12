import assert from "node:assert/strict";
import { classifyFrontendVisible, extractClassifierJson } from "../src/classifier";
import { collectDiffContext, heuristicFrontendVisible } from "../src/diff";

assert.equal(
  heuristicFrontendVisible(["README.md", ".github/workflows/ci.yaml"], "").frontendVisible,
  false,
);
assert.equal(
  heuristicFrontendVisible(["apps/web/components/Button.tsx"], "+ className").frontendVisible,
  true,
);
assert.equal(typeof collectDiffContext, "function");
assert.deepEqual(
  extractClassifierJson('```json\n{"frontendVisible":false,"confidence":0.9}\n```'),
  { frontendVisible: false, confidence: 0.9 },
);

const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
const oldAllowHeuristic = process.env.FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER;
await assert.rejects(
  () =>
    classifyFrontendVisible({
      files: ["apps/web/components/Button.tsx"],
      patch: "+ className",
      prTitle: "Change button",
    }),
  /ANTHROPIC_API_KEY is required/,
);
if (oldAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
else process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
if (oldAllowHeuristic === undefined) delete process.env.FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER;
else process.env.FEATURE_REC_ALLOW_HEURISTIC_CLASSIFIER = oldAllowHeuristic;

console.log("action selftest passed");
