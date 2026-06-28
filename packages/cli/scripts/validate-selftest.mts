/* Self-test for the agent-path validation fixes (not part of the build). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractCodeBlock,
  fieldsMissingDefaults,
  SceneValidationError,
  validateScene,
} from "../src/agent/validate.ts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof SceneValidationError;
  }
}

// 1. broadened language label
ok(
  "extractCodeBlock accepts ```typescript",
  extractCodeBlock("intro\n```typescript\nexport default function X(){}\n```\n").includes(
    "export default",
  ),
);

// 2. truncated/unterminated fence → throw (don't return prose+partial)
ok(
  "extractCodeBlock rejects unterminated fence",
  throws(() => extractCodeBlock("notes\n```tsx\nexport default function X(){}\n")),
);

// 3. genuinely fence-less module is accepted
ok(
  "extractCodeBlock accepts fence-less module",
  extractCodeBlock("export default function X(){}\nexport const schema = 1;").includes("export"),
);

// 4. multiple fences → last one wins
ok(
  "extractCodeBlock takes the last block",
  extractCodeBlock("```ts\nA\n```\ntext\n```tsx\nexport default B\n```").trim() === "export default B",
);

// 5. missing-default detection
ok(
  "fieldsMissingDefaults flags a field without .default()",
  JSON.stringify(
    fieldsMissingDefaults(
      'export const schema = z.object({ a: z.string().default("x"), b: z.number() });',
    ),
  ) === JSON.stringify(["b"]),
);

// 6. nested object with outer .default() is fine
ok(
  "fieldsMissingDefaults allows nested object w/ outer default",
  fieldsMissingDefaults(
    "export const schema = z.object({ focus: z.object({ x: z.number(), y: z.number() }).default({ x: 1, y: 2 }) });",
  ).length === 0,
);

// 7. the real known-good scene passes validation end-to-end
const here = path.dirname(fileURLToPath(import.meta.url));
const scenePath = path.resolve(
  here,
  "../../video/src/scenes/generated/dark-mode-toggle.tsx",
);
const sceneCode = fs.readFileSync(scenePath, "utf8");
ok("known-good scene: no missing defaults", fieldsMissingDefaults(sceneCode).length === 0);
ok(
  "known-good scene: validateScene passes",
  (() => {
    try {
      validateScene(sceneCode);
      return true;
    } catch {
      return false;
    }
  })(),
);

// 8. forbidden patterns still caught
ok(
  "validateScene rejects <Audio>",
  throws(() =>
    validateScene(
      'export default function X(){return null} export const schema = z.object({a: z.string().default("")}); <Audio src="x" />',
    ),
  ),
);

ok(
  "validateScene rejects presentation chrome",
  throws(() =>
    validateScene(
      'import { Spotlight } from "../../components"; export default function X(){return <Spotlight x={1} y={2} radius={3} opacity={1} />} export const schema = z.object({a: z.string().default("")});',
    ),
  ),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
