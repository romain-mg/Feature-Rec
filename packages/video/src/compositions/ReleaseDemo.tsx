import React from "react";
import { AbsoluteFill, Series } from "remotion";
import { SCENE_REGISTRY } from "../scenes";
import { MissingScene } from "./MissingScene";
import type { DemoPlan } from "../schema";

/**
 * Composes the generated screen-recording-style scene(s).
 * Scenes are looked up by id from the (generated) registry; an unknown id falls
 * back to <MissingScene> so the timeline never has a hole.
 */
export const ReleaseDemo: React.FC<DemoPlan> = ({ scenes }) => {
  return (
    <AbsoluteFill style={{ background: "#F6F7FB" }}>
      <Series>
        {scenes.map((scene, i) => {
          const entry = SCENE_REGISTRY[scene.id];
          const Component = entry?.Component;
          return (
            <Series.Sequence
              key={`${scene.id}-${i}`}
              durationInFrames={Math.max(1, scene.durationInFrames)}
            >
              {Component ? (
                <Component {...scene.props} />
              ) : (
                <MissingScene id={scene.id} />
              )}
            </Series.Sequence>
          );
        })}
      </Series>
    </AbsoluteFill>
  );
};
