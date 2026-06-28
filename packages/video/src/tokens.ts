/**
 * AutoDemo design system — "devtool premium dark".
 * These tokens support shared motion and legacy chrome components.
 * The REPRODUCED UI inside a scene uses the target repo's own classNames/colors,
 * never these — fidelity comes from the source code, not from here.
 */

export const COLORS = {
  bgBase: "#08080C",
  bgGlow: "#14121F",
  surface: "#16161F",
  accent: "#6C5CE7",
  accentSoft: "rgba(108,92,231,0.25)",
  textHi: "#F5F5F7",
  textMid: "#C7C7D2",
  textLo: "#8A8A9A",
  subtitleBg: "rgba(8,8,16,0.82)",
  spotlightScrim: "rgba(8,8,16,0.55)",
  hairline: "rgba(255,255,255,0.08)",
} as const;

/** Smooth UI transitions — critically damped, zero bounce. */
export const SPRING_SMOOTH = { damping: 200, mass: 0.6, stiffness: 100 } as const;
/** Pills / captions — snappy pop. */
export const SPRING_POP = { damping: 13, mass: 0.8, stiffness: 200 } as const;

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const INTRO_FRAMES = 75;
export const OUTRO_FRAMES = 60;

export const RADIAL_BG = `radial-gradient(circle at 50% 40%, ${COLORS.bgGlow} 0%, ${COLORS.bgBase} 70%)`;

/** Font stack used by the brand chrome (Inter loaded via @remotion/google-fonts). */
export const FALLBACK_FONT =
  "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Default brand accent, overridable per release via DemoPlan.brand.primary. */
export const DEFAULT_ACCENT = COLORS.accent;
