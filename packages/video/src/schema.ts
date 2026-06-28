import { z } from "zod";
import { DEFAULT_ACCENT } from "./tokens";

/**
 * DemoPlan — the serializable spine of a release video.
 * Built by the CLI, passed to the Remotion composition as inputProps.
 * Everything here must be JSON-serializable (no functions/components).
 */

export const BrandSchema = z.object({
  productName: z.string().default("Acme"),
  primary: z.string().default(DEFAULT_ACCENT),
  tagline: z.string().default("Ship the feature. Ship the demo."),
  releaseTag: z.string().default("v0.0.0"),
  prNumber: z.number().int().nonnegative().default(0),
});
export type Brand = z.infer<typeof BrandSchema>;

/**
 * A reference to one generated scene + the props it should render with.
 * `id` matches a key in the (generated) scene registry; `props` is that
 * scene's own zod-validated prop object (values, cursor coordinates, brandPrimary...).
 */
export const SceneRefSchema = z.object({
  id: z.string(),
  title: z.string().default(""),
  durationInFrames: z.number().int().positive().default(165),
  props: z.record(z.string(), z.any()).default({}),
});
export type SceneRef = z.infer<typeof SceneRefSchema>;

export const DemoPlanSchema = z.object({
  brand: BrandSchema.default({}),
  scenes: z.array(SceneRefSchema).default([]),
});
export type DemoPlan = z.infer<typeof DemoPlanSchema>;

/** Total composition length = every generated scene, with no presentation intro/outro. */
export function totalFrames(plan: DemoPlan): number {
  const scenes = plan.scenes.reduce((acc, s) => acc + s.durationInFrames, 0);
  return Math.max(1, scenes);
}
