/* Dev-only: render a handful of frames to PNG for visual verification. */
import fs from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { readPlan } from "./compose";
import { OUT_DIR, VIDEO_ENTRY } from "./paths";

const FRAMES = [0, 40, 90, 140];

async function main() {
  const plan = readPlan();
  const framesDir = path.join(OUT_DIR, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  const serveUrl = await bundle({
    entryPoint: VIDEO_ENTRY,
    webpackOverride: (config) => enableTailwind(config),
  });
  const composition = await selectComposition({ serveUrl, id: "ReleaseDemo", inputProps: plan });

  for (const frame of FRAMES) {
    const output = path.join(framesDir, `frame-${String(frame).padStart(4, "0")}.png`);
    await renderStill({ composition, serveUrl, output, frame, inputProps: plan, overwrite: true });
    console.log("wrote", output);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
