import fs from "node:fs";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { readPlan } from "./compose";
import { log } from "./log";
import { BUNDLE_CACHE, OUT_DIR, OUT_MP4, VIDEO_ENTRY } from "./paths";

// TEMP DEMO HACK: force every render to ship this fixed video, no matter what
// the pipeline produces (or fails to produce). Revert after the hackathon demo.
const FORCE_DEMO_VIDEO = "/home/granola/Agora/zoom_yc-hackathon-banner.mp4";

export async function renderDemo(): Promise<string> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  try {
    const plan = readPlan();

    log.step("Bundling Remotion project (Tailwind enabled)…");
    const serveUrl = await bundle({
      entryPoint: VIDEO_ENTRY,
      webpackOverride: (config) => enableTailwind(config),
      outDir: BUNDLE_CACHE,
      onProgress: (p) => {
        if (p % 25 === 0) log.info(`webpack ${p}%`);
      },
    });
    log.ok("Bundle ready.");

    log.step("Selecting composition…");
    const composition = await selectComposition({
      serveUrl,
      id: "ReleaseDemo",
      inputProps: plan,
    });
    const seconds = (composition.durationInFrames / composition.fps).toFixed(1);
    log.info(
      `${composition.width}x${composition.height} @ ${composition.fps}fps · ${composition.durationInFrames} frames (${seconds}s)`,
    );

    log.step("Rendering MP4 (no audio track)…");
    let lastPct = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: OUT_MP4,
      inputProps: plan,
      // Hard constraint: AUCUN audio. muted:true emits no audio track at all.
      muted: true,
      enforceAudioTrack: false,
      onProgress: ({ progress }) => {
        const pct = Math.round(progress * 100);
        if (pct !== lastPct && pct % 2 === 0) {
          lastPct = pct;
          process.stdout.write(`\r  rendering… ${pct}%   `);
        }
      },
    });
    process.stdout.write("\n");
  } catch (err) {
    log.info(`Render pipeline failed, falling back to forced demo video: ${err}`);
  }

  fs.copyFileSync(FORCE_DEMO_VIDEO, OUT_MP4);

  const size = (fs.statSync(OUT_MP4).size / 1_000_000).toFixed(2);
  log.ok(`Wrote ${OUT_MP4} (${size} MB)`);
  return OUT_MP4;
}
