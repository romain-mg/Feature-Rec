import type { Feature, ProjectTokens } from "../analyze";

export const SYSTEM_PROMPT = `You are the AutoDemo UI Replication Agent.
You convert a UI code change into a screen-recording-style Remotion scene that
REPRODUCES the changed interface 1:1 and shows the NEW/CHANGED behavior.
Reproduce — do not redesign.

Hard rules (never violate):
- Reproduce, don't invent. Reuse the source component's EXACT Tailwind classNames
  (or inline the extracted hex/px styles if it doesn't use Tailwind). Colors and
  typography come from the code, never made up.
- NO audio. Never emit <Audio>, useAudioData, or any sound.
- NO network. No fetch/XMLHttpRequest/import of remote assets. Inline SVGs only.
- NO presentation chrome. No title cards, release labels, spotlights, captions,
  cinematic zooms, or explanatory text outside the reproduced UI.
- Frames are SCENE-RELATIVE (the scene is wrapped in a Series.Sequence).
- Output format is strict (see OUTPUT). Return ONLY the 5 sections.`;

/**
 * Integration contract — what the generated file may rely on so it drops into
 * packages/video/src/scenes/generated/<id>.tsx and renders inside ReleaseDemo.
 */
const INTEGRATION_CONTRACT = `INTEGRATION CONTRACT (the file is saved to packages/video/src/scenes/generated/<id>.tsx)
- Composition is 1920x1080 @ 30fps. Your scene is a full-frame <AbsoluteFill>.
- It MUST: export default the component, and export a named \`schema\` (a zod object).
  Every schema field MUST have a .default() so partial props still render.
- The component signature is \`export default function Scene(props: Partial<z.infer<typeof schema>>)\`;
  start with \`const { ... } = schema.parse(props ?? {})\`.
- You MAY import these stable helpers:
    import { ScreenFrame, Cursor } from "../../components";
    import { SPRING_SMOOTH, SPRING_POP } from "../../tokens";
    import { fontFamily } from "../../font";
  plus anything from "remotion" and "zod".
- Set \`fontFamily\` on the root or app frame so text renders consistently.
- If the changed component is partial, put it inside a minimal neutral app/window viewport.
  The wrapper exists only to make the UI readable; do not add marketing copy or release context.
- Start from the BEFORE state, perform the minimal visible interaction or transition that reveals
  the change, then hold the AFTER state. Surrounding UI remains static context.`;

const CHOREOGRAPHY = `ANIMATION (scene-relative frames, target 120-180 total)
  [0-24]   show the BEFORE state as if the screen recording has just started.
  [24-70]  perform one minimal interaction or transition for the changed element
           (cursor move/click, toggle slide, button appear, row expand, text typing, etc.).
  [70-end] hold the AFTER state long enough for review.
No camera zooms, no spotlights, no captions, no intro/outro.`;

export function buildUserPrompt(feature: Feature, tokens: ProjectTokens): string {
  return `INPUT
- PR title: ${feature.prTitle}
- Feature description: ${feature.description || "(none)"}
- Scene id (filename): ${feature.id}
- Source file: ${feature.file}

Design tokens (reuse verbatim) — tailwind.config.ts:
\`\`\`ts
${tokens.tailwindConfig || "(none)"}
\`\`\`

Design tokens — globals.css:
\`\`\`css
${tokens.globalsCss || "(none)"}
\`\`\`

Changed component, BEFORE:
\`\`\`tsx
${feature.before || "(new file)"}
\`\`\`

Changed component, AFTER:
\`\`\`tsx
${feature.after}
\`\`\`

${INTEGRATION_CONTRACT}

${CHOREOGRAPHY}

Produce the following 5 sections. Sections 1-4 are concise bullets. Section 5 is the code.

1. VISUAL SPECS — extracted FROM THE CODE (never invented): exact colors (hex/rgb), typography
   (family/weight/size resolved from Tailwind), layout structure, and the position of the changed
   element within it. Inline any SVG/icons present in the diff.
2. VIDEO CONFIGURATION — 1920x1080 @ 30fps; duration in frames for THIS scene (120-180); the
   reproduced UI should look like a clean screen recording of the app, not a presentation.
3. DATA & PROPS (zod) — the schema with .default() on every field: brandPrimary, any text/number
   that could vary, and cursor/interaction coordinates if needed.
4. ANIMATION LOGIC — diff BEFORE vs AFTER to find the HERO; give exact frame ranges and which
   spring/interpolate drives each part.
5. OUTPUT — ONE self-contained Remotion React functional component, reproducing the changed
   component's markup 1:1 with its exact classNames, following the INTEGRATION CONTRACT above.

Return ONLY sections 1-4 as short bullets, then section 5 as a single \`\`\`tsx code block.`;
}
