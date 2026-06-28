/** Extract the tsx code block and sanity-check it against the hard invariants. */

export class SceneValidationError extends Error {}

/**
 * Pull the last fenced code block. Accepts any language label (```tsx, ```typescript,
 * ```react, ```…). If fences are present but none parse cleanly (e.g. a truncated /
 * unterminated block), FAIL rather than silently returning prose + partial code.
 */
export function extractCodeBlock(text: string): string {
  const fence = /```[a-zA-Z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fence.exec(text)) !== null) {
    last = match[1];
  }
  if (last && last.trim()) return last.trim();

  // Fences exist but none closed cleanly → likely truncated/malformed. Don't write junk.
  if (text.includes("```")) {
    throw new SceneValidationError(
      "Agent output has an unterminated or malformed code fence (possibly truncated).",
    );
  }
  // Truly fence-less response: only accept if it actually looks like a module.
  if (/export\s+default/.test(text)) return text.trim();
  throw new SceneValidationError("No tsx code block found in agent output.");
}

const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /<\s*Audio[\s/>]/, why: "audio is forbidden (<Audio>)" },
  { re: /useAudioData|@remotion\/media-utils/, why: "audio utilities are forbidden" },
  { re: /\bfetch\s*\(/, why: "network calls are forbidden (fetch)" },
  { re: /XMLHttpRequest/, why: "network calls are forbidden (XMLHttpRequest)" },
  { re: /\bnew\s+WebSocket/, why: "network calls are forbidden (WebSocket)" },
  { re: /import\s+[^;]*https?:\/\//, why: "remote imports are forbidden" },
  {
    re: /import\s+\{[^}]*\b(Camera|Spotlight|Caption|Intro|Outro)\b[^}]*\}\s+from\s+["']\.\.\/\.\.\/components["']/,
    why: "presentation chrome helpers are forbidden",
  },
  { re: /from\s+["']\.\.\/\.\.\/components\/(Camera|Spotlight|Caption|Intro|Outro)["']/, why: "presentation chrome helpers are forbidden" },
  { re: /<\s*(Camera|Spotlight|Caption|Intro|Outro)\b/, why: "presentation chrome elements are forbidden" },
  { re: /\bRADIAL_BG\b/, why: "presentation background chrome is forbidden" },
];

/**
 * Best-effort static check that every TOP-LEVEL field of
 * `export const schema = z.object({ ... })` has a `.default(...)`.
 * The scene is rendered with sparse props, so a field without a default throws a
 * ZodError at render time — catch it here so the fallback chain engages instead.
 * Returns the names of offending fields (empty if the schema isn't a parseable
 * inline z.object — in which case we don't false-fail).
 */
export function fieldsMissingDefaults(code: string): string[] {
  const head = /export\s+const\s+schema\s*=\s*z\s*\.\s*object\s*\(\s*\{/.exec(code);
  if (!head) return [];
  const objOpen = head.index + head[0].length - 1; // index of the object-literal '{'

  let depth = 0;
  let end = -1;
  for (let i = objOpen; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return []; // unbalanced — can't parse, skip

  const body = code.slice(objOpen + 1, end);
  const fields: string[] = [];
  let d = 0;
  let start = 0;
  for (let j = 0; j < body.length; j++) {
    const ch = body[j];
    if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "}" || ch === "]") d--;
    else if (ch === "," && d === 0) {
      fields.push(body.slice(start, j));
      start = j + 1;
    }
  }
  fields.push(body.slice(start));

  const missing: string[] = [];
  for (const raw of fields) {
    const seg = raw.trim();
    if (!seg) continue;
    const name = /^([A-Za-z_$][\w$]*)\s*:/.exec(seg);
    if (!name) continue; // comment / not a field
    if (!/\.default\s*\(/.test(seg)) missing.push(name[1]);
  }
  return missing;
}

export function validateScene(code: string): string {
  if (!/export\s+default/.test(code)) {
    throw new SceneValidationError("Generated scene is missing `export default`.");
  }
  if (!/export\s+const\s+schema\b/.test(code)) {
    throw new SceneValidationError("Generated scene is missing `export const schema`.");
  }
  for (const { re, why } of FORBIDDEN) {
    if (re.test(code)) {
      throw new SceneValidationError(`Generated scene violates an invariant: ${why}.`);
    }
  }
  const missing = fieldsMissingDefaults(code);
  if (missing.length > 0) {
    throw new SceneValidationError(
      `Schema field(s) without .default(): ${missing.join(", ")}. ` +
        `Every field must have a default so the scene renders with partial props.`,
    );
  }
  return code;
}
