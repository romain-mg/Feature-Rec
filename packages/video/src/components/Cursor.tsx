import React from "react";

export const Cursor: React.FC<{
  x: number;
  y: number;
  scale?: number;
  opacity?: number;
}> = ({ x, y, scale = 1, opacity = 1 }) => {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 24,
        height: 24,
        opacity,
        transform: `translate(-3px, -2px) scale(${scale})`,
        transformOrigin: "top left",
        pointerEvents: "none",
        filter: "drop-shadow(0 3px 5px rgba(0,0,0,0.25))",
      }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 3.5L19.2 14.1L12.7 15.1L9.1 21.2L4 3.5Z"
          fill="#FFFFFF"
          stroke="#111827"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};
