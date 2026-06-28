import React from "react";
import {
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import { Cursor, ScreenFrame } from "../../components";
import { SPRING_POP, SPRING_SMOOTH } from "../../tokens";

export const schema = z.object({
  brandPrimary: z.string().default("#6C5CE7"),
  accountLabel: z.string().default("Account"),
  accountEmail: z.string().default("team@acme.com"),
  notificationsLabel: z.string().default("Notifications"),
  notificationsSubtext: z.string().default("Email me about releases"),
  appearanceLabel: z.string().default("Appearance"),
  appearanceSubtext: z.string().default("Use dark theme across the app"),
});

export type DarkModeToggleProps = z.infer<typeof schema>;

export default function DarkModeToggleScene(props: Partial<DarkModeToggleProps>) {
  const {
    brandPrimary,
    accountLabel,
    accountEmail,
    notificationsLabel,
    notificationsSubtext,
    appearanceLabel,
    appearanceSubtext,
  } = schema.parse(props ?? {});
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const rowIn = spring({ frame: frame - 22, fps, config: SPRING_SMOOTH });
  const toggleOn = spring({ frame: frame - 54, fps, config: SPRING_SMOOTH });
  const click = spring({ frame: frame - 52, fps, config: SPRING_POP });
  const cursorMove = spring({ frame: frame - 34, fps, config: SPRING_SMOOTH });
  const cursorX = interpolate(cursorMove, [0, 1], [1010, 1115], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const cursorY = interpolate(cursorMove, [0, 1], [584, 574], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return (
    <ScreenFrame background="#F4F6FA">
      <div className="h-full w-full bg-[#101018] flex items-center justify-center">
        <div className="rounded-2xl bg-[#16161F] shadow-2xl ring-1 ring-white/5 w-[800px] overflow-hidden">
          <div className="px-10 h-[100px] flex flex-col justify-center">
            <h2 className="text-[#F5F5F7] text-2xl font-bold">Settings</h2>
            <p className="text-[#8A8A9A] text-sm font-medium">Manage your workspace preferences</p>
          </div>

          <div className="px-10 divide-y divide-white/10">
            <div className="h-[92px] flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[#F5F5F7] text-xl font-semibold">{accountLabel}</span>
                <span className="text-[#8A8A9A] text-sm font-medium">{accountEmail}</span>
              </div>
              <span className="text-[#C7C7D2] text-sm font-medium">Manage</span>
            </div>

            <div className="h-[92px] flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[#F5F5F7] text-xl font-semibold">{notificationsLabel}</span>
                <span className="text-[#8A8A9A] text-sm font-medium">{notificationsSubtext}</span>
              </div>
              <span className="text-[#6C5CE7] text-sm font-semibold">On</span>
            </div>

            <div
              className="h-[92px] flex items-center justify-between"
              style={{
                height: 92 * rowIn,
                opacity: Math.min(1, rowIn),
                overflow: "hidden",
              }}
            >
              <div className="flex flex-col">
                <span className="text-[#F5F5F7] text-xl font-semibold">{appearanceLabel}</span>
                <span className="text-[#8A8A9A] text-sm font-medium">{appearanceSubtext}</span>
              </div>
              <button
                aria-pressed={toggleOn > 0.5}
                className="relative w-[64px] h-[34px] rounded-full p-1 transition-colors"
                style={{
                  background: toggleOn > 0.08 ? brandPrimary : "#3A3A44",
                  transform: `scale(${1 - Math.min(0.08, click * 0.08)})`,
                }}
              >
                <span
                  className="block w-[26px] h-[26px] rounded-full bg-white shadow transition-transform"
                  style={{ transform: `translateX(${30 * toggleOn}px)` }}
                />
              </button>
            </div>
          </div>
        </div>
      </div>
      <Cursor x={cursorX} y={cursorY} opacity={frame < 112 ? 1 : 0} />
    </ScreenFrame>
  );
}
