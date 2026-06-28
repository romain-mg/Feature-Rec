import fs from "node:fs";
import { DemoPlanSchema, type DemoPlan } from "@autodemo/video/schema";
import { COLORS } from "@autodemo/video/brand";
import type { Feature } from "./analyze";
import { OUT_DIR, PLAN_FILE } from "./paths";

/** Per-scene length in frames (within the 120-210 target). */
export const SCENE_FRAMES = 175;

/** Build the DemoPlan (intro brand + one scene ref per feature). */
export function buildPlan(features: Feature[]): DemoPlan {
  const head = features[0];
  const plan = {
    brand: {
      productName: head?.productName ?? "Acme",
      primary: COLORS.accent,
      tagline: head?.prTitle ?? "New in this release",
      releaseTag: head?.releaseTag ?? "v0.1.0",
      prNumber: head?.prNumber ?? 0,
    },
    scenes: features.map((f) => ({
      id: f.id,
      title: f.prTitle,
      durationInFrames: SCENE_FRAMES,
      // Sparse props: the scene's own zod schema fills the rest.
      props: {
        brandPrimary: COLORS.accent,
      },
    })),
  };
  return DemoPlanSchema.parse(plan);
}

export function writePlan(plan: DemoPlan): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), "utf8");
}

export function readPlan(): DemoPlan {
  if (!fs.existsSync(PLAN_FILE)) {
    throw new Error(`No plan found at ${PLAN_FILE}. Run \`autodemo generate\` first.`);
  }
  return DemoPlanSchema.parse(JSON.parse(fs.readFileSync(PLAN_FILE, "utf8")));
}
