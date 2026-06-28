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

const MemberSchema = z.object({
  initials: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
});

export const schema = z.object({
  brandPrimary: z.string().default("#6C5CE7"),
  cardTitle: z.string().default("Members"),
  cardSubtitle: z.string().default("3 people in Acme"),
  buttonLabel: z.string().default("Invite"),
  members: z
    .array(MemberSchema)
    .default([
      { initials: "MC", name: "Maya Chen", email: "maya@acme.com", role: "Admin" },
      { initials: "TP", name: "Theo Park", email: "theo@acme.com", role: "Member" },
      { initials: "IR", name: "Inès Roux", email: "ines@acme.com", role: "Member" },
    ]),
});

export type InviteMembersProps = z.infer<typeof schema>;

export default function InviteMembersScene(props: Partial<InviteMembersProps>) {
  const { brandPrimary, cardTitle, cardSubtitle, buttonLabel, members } = schema.parse(props ?? {});
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const buttonIn = spring({ frame: frame - 34, fps, config: SPRING_POP });
  const cursorMove = spring({ frame: frame - 12, fps, config: SPRING_SMOOTH });
  const cursorX = interpolate(cursorMove, [0, 1], [1020, 1184], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const cursorY = interpolate(cursorMove, [0, 1], [152, 146], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return (
    <ScreenFrame background="#F4F6FA">
      <div className="h-full w-full bg-[#101018] flex items-center justify-center">
        <div className="rounded-2xl bg-[#16161F] shadow-2xl ring-1 ring-white/5 w-[840px]">
          <div className="px-10 h-[110px] flex items-center justify-between border-b border-white/10">
            <div className="flex flex-col">
              <h2 className="text-[#F5F5F7] text-2xl font-bold">{cardTitle}</h2>
              <p className="text-[#8A8A9A] text-sm font-medium">{cardSubtitle}</p>
            </div>
            <button
              className="flex items-center gap-2 h-[48px] w-[150px] justify-center rounded-xl bg-[#6C5CE7] text-white text-base font-semibold"
              style={{
                background: brandPrimary,
                transform: `scale(${buttonIn})`,
                opacity: Math.min(1, buttonIn),
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              {buttonLabel}
            </button>
          </div>

          <div className="px-10 divide-y divide-white/10">
            {members.map((m) => (
              <div key={m.email} className="h-[96px] flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-[#3A3A44] flex items-center justify-center text-white text-sm font-bold">
                    {m.initials}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[#F5F5F7] text-lg font-semibold">{m.name}</span>
                    <span className="text-[#8A8A9A] text-sm font-medium">{m.email}</span>
                  </div>
                </div>
                <span className="text-[#8A8A9A] text-sm font-medium">{m.role}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <Cursor x={cursorX} y={cursorY} opacity={frame < 104 ? 1 : 0} />
    </ScreenFrame>
  );
}
