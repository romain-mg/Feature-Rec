import React from "react";
import { AbsoluteFill } from "remotion";
import { fontFamily } from "../font";

export const ScreenFrame: React.FC<{
  children: React.ReactNode;
  background?: string;
}> = ({ children, background = "#F6F7FB" }) => {
  return (
    <AbsoluteFill
      style={{
        background,
        fontFamily,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 1440,
          height: 900,
          position: "relative",
          overflow: "hidden",
          borderRadius: 18,
          background: "#FFFFFF",
          boxShadow: "0 24px 80px rgba(15, 23, 42, 0.14)",
          border: "1px solid rgba(15, 23, 42, 0.10)",
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};
