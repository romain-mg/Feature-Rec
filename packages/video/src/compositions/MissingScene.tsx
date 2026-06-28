import React from "react";
import { AbsoluteFill } from "remotion";
import { COLORS } from "../tokens";
import { fontFamily } from "../font";

/**
 * Safety net: rendered when a DemoPlan references a scene id that is not in the
 * registry. Guarantees we NEVER render an empty frame.
 */
export const MissingScene: React.FC<{ id: string }> = ({ id }) => {
  return (
    <AbsoluteFill
      style={{
        background: "#F6F7FB",
        fontFamily,
        alignItems: "center",
        justifyContent: "center",
        color: COLORS.textMid,
      }}
    >
      <div
        style={{
          padding: "28px 40px",
          borderRadius: 14,
          background: "#FFFFFF",
          border: "1px solid rgba(15, 23, 42, 0.10)",
          boxShadow: "0 24px 80px rgba(15, 23, 42, 0.12)",
          fontSize: 30,
          fontWeight: 600,
        }}
      >
        Preview unavailable — <span style={{ color: COLORS.textLo }}>{id}</span>
      </div>
    </AbsoluteFill>
  );
};
